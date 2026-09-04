import { lunarToSolar, serializeAnniversary } from "./calendar";
import type { AnniversaryRow, LocalDateTime, PushSubscriptionRow, User } from "./types";
import { ApiError, base64UrlDecode, localDate, parseDateTime, randomToken, sha256 } from "./utils";

type AnniversaryInput = Omit<AnniversaryRow,
  "id" | "user_id" | "reminders_sent" | "last_reminded_on" | "reminder_occurrence_date" | "created_at" | "updated_at"
>;

const INPUT_FIELDS: (keyof AnniversaryInput)[] = [
  "title", "accent", "mode", "event_date", "event_time", "calendar_type", "lunar_year", "lunar_month",
  "lunar_day", "lunar_is_leap", "repeat_rule", "reminder_enabled", "advance_days", "reminder_type",
  "max_reminders", "reminder_time", "webhook_url", "web_push_enabled", "note",
];

const SCHEDULE_FIELDS = new Set<keyof AnniversaryInput>([
  "mode", "event_date", "event_time", "calendar_type", "lunar_year", "lunar_month", "lunar_day",
  "lunar_is_leap", "repeat_rule", "reminder_enabled", "advance_days", "reminder_type", "max_reminders",
  "reminder_time", "webhook_url", "web_push_enabled",
]);

function normalizeUsername(value: unknown): [string, string] {
  const username = String(value ?? "").normalize("NFKC").trim();
  if (!username || [...username].length > 32) throw new ApiError(400, "请输入 1-32 个字符的用户名");
  if ([...username].some((character) => /[\r\n\t\x00-\x1f]/.test(character))) {
    throw new ApiError(400, "用户名包含无效字符");
  }
  return [username, username.toLocaleLowerCase()];
}

function integer(value: unknown, message: string): number {
  if (value === "" || value === null || value === undefined || !Number.isInteger(Number(value))) throw new ApiError(400, message);
  return Number(value);
}

export async function loginUser(db: D1Database, payload: Record<string, unknown>): Promise<{ token: string; user: User; created: boolean }> {
  const [username, usernameKey] = normalizeUsername(payload.username);
  const insert = await db.prepare("INSERT OR IGNORE INTO users (username, username_key) VALUES (?, ?)").bind(username, usernameKey).run();
  const user = await db.prepare("SELECT id, username FROM users WHERE username_key = ?").bind(usernameKey).first<User>();
  if (!user) throw new Error("Unable to read the newly created user");
  const token = randomToken();
  await db.batch([
    db.prepare("INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)").bind(await sha256(token), user.id),
    db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN (
      SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20
    )`).bind(user.id, user.id),
  ]);
  return { token, user, created: (insert.meta.changes ?? 0) > 0 };
}

export function bearerToken(request: Request): string {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "");
  return match?.[1].trim() ?? "";
}

export async function userForRequest(db: D1Database, request: Request): Promise<User> {
  const token = bearerToken(request);
  if (!token) throw new ApiError(401, "登录状态无效，请重新进入");
  const user = await db.prepare(`SELECT users.id, users.username FROM sessions
    JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?`).bind(await sha256(token)).first<User>();
  if (!user) throw new ApiError(401, "登录状态无效，请重新进入");
  return user;
}

export async function logoutUser(db: D1Database, request: Request): Promise<void> {
  const token = bearerToken(request);
  if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}

export function validateAnniversary(payload: Record<string, unknown>): AnniversaryInput {
  const title = String(payload.title ?? "").trim();
  if (!title || [...title].length > 50) throw new ApiError(400, "请填写 1-50 个字符的纪念日名称");
  const mode = payload.mode;
  if (mode !== "countdown" && mode !== "elapsed") throw new ApiError(400, "纪念方式无效");
  let repeatRule = String(payload.repeat_rule ?? "once").toLowerCase();
  if (!["once", "yearly", "monthly", "daily"].includes(repeatRule)) throw new ApiError(400, "重复周期无效");
  if (mode !== "countdown") repeatRule = "once";
  const calendarType = String(payload.calendar_type ?? "solar").toLowerCase();
  if (calendarType !== "solar" && calendarType !== "lunar") throw new ApiError(400, "日期类型无效");

  let eventDate: string;
  let lunarYear: number | null = null;
  let lunarMonth: number | null = null;
  let lunarDay: number | null = null;
  const lunarIsLeap = payload.lunar_is_leap === true || payload.lunar_is_leap === 1 || payload.lunar_is_leap === "1";
  if (calendarType === "lunar") {
    lunarYear = integer(payload.lunar_year, "请选择完整的农历日期");
    lunarMonth = integer(payload.lunar_month, "请选择完整的农历日期");
    lunarDay = integer(payload.lunar_day, "请选择完整的农历日期");
    eventDate = localDate(lunarToSolar(lunarYear, lunarMonth, lunarDay, lunarIsLeap));
  } else {
    eventDate = String(payload.event_date ?? "");
    parseDateTime(eventDate);
  }

  let eventTime = String(payload.event_time ?? "00:00:00").trim();
  if (/^\d{2}:\d{2}$/.test(eventTime)) eventTime += ":00";
  parseDateTime(eventDate, eventTime);
  const reminderType = payload.reminder_type ?? "daily";
  if (reminderType !== "daily" && reminderType !== "times") throw new ApiError(400, "提醒频率无效");
  const advanceDays = integer(payload.advance_days ?? 0, "提醒次数必须是数字");
  const maxReminders = reminderType === "times" ? integer(payload.max_reminders, "请设置 1-3650 次提醒") : null;
  if (advanceDays < 0 || advanceDays > 3650) throw new ApiError(400, "提前提醒天数应在 0 到 3650 之间");
  if (maxReminders !== null && (maxReminders < 1 || maxReminders > 3650)) throw new ApiError(400, "请设置 1-3650 次提醒");
  const reminderTime = String(payload.reminder_time ?? "09:00");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(reminderTime)) throw new ApiError(400, "提醒时间格式不正确");
  const webhookValue = String(payload.webhook_url ?? "").trim();
  let webhookUrl: string | null = null;
  if (webhookValue) {
    try {
      const parsed = new URL(webhookValue);
      if (parsed.protocol !== "https:") throw new Error();
      webhookUrl = parsed.href;
    } catch { throw new ApiError(400, "微信机器人地址需要使用有效的 HTTPS URL"); }
  }
  let accent = String(payload.accent ?? "#E85C4A");
  if (!/^#[0-9A-Fa-f]{6}$/.test(accent)) accent = "#E85C4A";
  return {
    title, accent, mode, event_date: eventDate, event_time: eventTime,
    calendar_type: calendarType, lunar_year: lunarYear, lunar_month: lunarMonth, lunar_day: lunarDay,
    lunar_is_leap: lunarIsLeap ? 1 : 0, repeat_rule: repeatRule as AnniversaryInput["repeat_rule"],
    reminder_enabled: payload.reminder_enabled === false ? 0 : 1, advance_days: advanceDays,
    reminder_type: reminderType, max_reminders: maxReminders, reminder_time: reminderTime,
    webhook_url: webhookUrl, web_push_enabled: payload.web_push_enabled === false ? 0 : 1,
    note: String(payload.note ?? "").trim().slice(0, 240),
  };
}

export async function getAnniversary(db: D1Database, id: number, userId: number): Promise<AnniversaryRow | null> {
  return db.prepare("SELECT * FROM anniversaries WHERE id = ? AND user_id = ?").bind(id, userId).first<AnniversaryRow>();
}

export async function listAnniversaries(db: D1Database, userId?: number): Promise<AnniversaryRow[]> {
  const statement = userId === undefined
    ? db.prepare("SELECT * FROM anniversaries ORDER BY event_date, event_time, id DESC")
    : db.prepare("SELECT * FROM anniversaries WHERE user_id = ? ORDER BY event_date, event_time, id DESC").bind(userId);
  return (await statement.all<AnniversaryRow>()).results;
}

export async function listReminderCandidates(db: D1Database, reminderTime: string): Promise<AnniversaryRow[]> {
  return (await db.prepare(`SELECT * FROM anniversaries
    WHERE reminder_enabled = 1 AND reminder_time = ? AND (webhook_url IS NOT NULL OR web_push_enabled = 1)
    ORDER BY id`).bind(reminderTime).all<AnniversaryRow>()).results;
}

export async function createAnniversary(db: D1Database, userId: number, payload: Record<string, unknown>, now: LocalDateTime): Promise<Record<string, unknown>> {
  const item = validateAnniversary(payload);
  const fields = ["user_id", ...INPUT_FIELDS];
  const result = await db.prepare(`INSERT INTO anniversaries (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`)
    .bind(userId, ...INPUT_FIELDS.map((field) => item[field] as string | number | null)).run();
  const row = await getAnniversary(db, Number(result.meta.last_row_id), userId);
  if (!row) throw new Error("Unable to read the newly created anniversary");
  return serializeAnniversary(row, now);
}

export async function updateAnniversary(db: D1Database, id: number, userId: number, payload: Record<string, unknown>, now: LocalDateTime): Promise<Record<string, unknown> | null> {
  const existing = await getAnniversary(db, id, userId);
  if (!existing) return null;
  const item = validateAnniversary(payload);
  const scheduleChanged = INPUT_FIELDS.some((field) => SCHEDULE_FIELDS.has(field) && existing[field] !== item[field]);
  const reset = scheduleChanged ? ", reminders_sent = 0, last_reminded_on = NULL, reminder_occurrence_date = NULL" : "";
  const result = await db.prepare(`UPDATE anniversaries SET ${INPUT_FIELDS.map((field) => `${field} = ?`).join(", ")}${reset}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`)
    .bind(...INPUT_FIELDS.map((field) => item[field] as string | number | null), id, userId).run();
  if (!(result.meta.changes ?? 0)) return null;
  const row = await getAnniversary(db, id, userId);
  return row ? serializeAnniversary(row, now) : null;
}

export async function deleteAnniversary(db: D1Database, id: number, userId: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM anniversaries WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function savePushSubscription(db: D1Database, userId: number, payload: Record<string, unknown>, userAgent: string): Promise<number> {
  const subscription = ((payload.subscription && typeof payload.subscription === "object") ? payload.subscription : payload) as Record<string, unknown>;
  const endpoint = String(subscription.endpoint ?? "").trim();
  const keys = (subscription.keys && typeof subscription.keys === "object" ? subscription.keys : {}) as Record<string, unknown>;
  const p256dh = String(keys.p256dh ?? "").trim();
  const auth = String(keys.auth ?? "").trim();
  try {
    const parsed = new URL(endpoint);
    const publicKey = base64UrlDecode(p256dh);
    const authKey = base64UrlDecode(auth);
    if (parsed.protocol !== "https:" || endpoint.length > 4096 || publicKey.length !== 65 || publicKey[0] !== 4 || authKey.length !== 16) throw new Error();
  } catch { throw new ApiError(400, "推送订阅密钥无效"); }
  await db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
    p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent,
    last_error = NULL, updated_at = CURRENT_TIMESTAMP`).bind(userId, endpoint, p256dh, auth, userAgent.slice(0, 300)).run();
  const count = await db.prepare("SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?").bind(userId).first<{ count: number }>();
  return Number(count?.count ?? 0);
}

export async function deletePushSubscription(db: D1Database, userId: number, payload: Record<string, unknown>): Promise<boolean> {
  const endpoint = String(payload.endpoint ?? "").trim();
  if (!endpoint) throw new ApiError(400, "缺少推送订阅地址");
  const result = await db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").bind(userId, endpoint).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function pushSubscriptionCount(db: D1Database, userId: number): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?").bind(userId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function pushSubscriptions(db: D1Database, userId: number): Promise<PushSubscriptionRow[]> {
  return (await db.prepare("SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?").bind(userId).all<PushSubscriptionRow>()).results;
}

export async function logPush(db: D1Database, userId: number, anniversaryId: number, channel: string, status: string, detail: string): Promise<void> {
  await db.prepare("INSERT INTO push_logs (user_id, anniversary_id, channel, status, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, anniversaryId, channel, status, detail.slice(0, 500)).run();
}
