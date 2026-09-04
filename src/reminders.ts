import { nextOccurrence, relativeDays } from "./calendar";
import { listReminderCandidates, logPush } from "./data";
import type { AnniversaryRow, Env, LocalDateTime } from "./types";
import { localDate, localNow, localTime } from "./utils";
import { sendWebPushToUser } from "./webpush";

export function notificationMessage(item: AnniversaryRow, now: LocalDateTime): string {
  const days = relativeDays(item, now);
  const intro = item.mode === "countdown"
    ? `${item.title} ${days === 0 ? "就是今天" : `还有 ${days} 天`}。`
    : `${item.title}已经第 ${days} 天了。`;
  return `[纪念日提醒] ${intro}${item.note ? `\n${item.note}` : ""}`;
}

export async function sendWecomWebhook(url: string, message: string): Promise<{ success: boolean; detail: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: message } }),
      signal: AbortSignal.timeout(8_000),
    });
    const raw = await response.text();
    const result = raw ? JSON.parse(raw) as { errcode?: number; errmsg?: string } : {};
    if (!response.ok || (result.errcode ?? 0) !== 0) return { success: false, detail: result.errmsg || `HTTP ${response.status}` };
    return { success: true, detail: "推送成功" };
  } catch (error) {
    return { success: false, detail: `推送失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function reminderIsDue(item: AnniversaryRow, now: LocalDateTime): boolean {
  if (!item.reminder_enabled || (!item.webhook_url && !item.web_push_enabled)) return false;
  if (item.last_reminded_on === localDate(now) || localTime(now, false) !== item.reminder_time) return false;
  const days = relativeDays(item, now);
  if (item.mode === "countdown" && (days < 0 || days > item.advance_days)) return false;
  if (item.mode === "elapsed" && days < 0) return false;
  if (item.reminder_type === "times") {
    const occurrenceDate = localDate(nextOccurrence(item, { ...now, hour: 0, minute: 0, second: 0 }));
    const remindersSent = item.reminder_occurrence_date === occurrenceDate ? item.reminders_sent : 0;
    if (item.max_reminders === null || remindersSent >= item.max_reminders) return false;
  }
  return true;
}

export async function dispatchScheduledReminders(env: Env, instant = new Date()): Promise<void> {
  const now = localNow(env.APP_TIMEZONE || "Asia/Shanghai", instant);
  now.second = 0;
  const candidates = await listReminderCandidates(env.DB, localTime(now, false));
  for (const item of candidates) {
    if (!reminderIsDue(item, now)) continue;
    const message = notificationMessage(item, now);
    let delivered = false;
    if (item.web_push_enabled) {
      const result = await sendWebPushToUser(env, item.user_id, "纪念日提醒", message, `anniversary-${item.id}`);
      if (result.successCount || result.failureCount) {
        await logPush(env.DB, item.user_id, item.id, "web_push", result.successCount ? "success" : "failed", result.detail);
      }
      delivered ||= result.successCount > 0;
    }
    if (item.webhook_url) {
      const result = await sendWecomWebhook(item.webhook_url, message);
      await logPush(env.DB, item.user_id, item.id, "wecom", result.success ? "success" : "failed", result.detail);
      delivered ||= result.success;
    }
    if (delivered) {
      const occurrenceDate = localDate(nextOccurrence(item, { ...now, hour: 0, minute: 0, second: 0 }));
      await env.DB.prepare(`UPDATE anniversaries SET last_reminded_on = ?, reminders_sent = CASE
        WHEN reminder_occurrence_date = ? THEN reminders_sent + 1 ELSE 1 END,
        reminder_occurrence_date = ? WHERE id = ? AND user_id = ?`)
        .bind(localDate(now), occurrenceDate, occurrenceDate, item.id, item.user_id).run();
    }
  }
}
