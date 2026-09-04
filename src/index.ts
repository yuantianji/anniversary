import { lunarYearOptions, serializeAnniversary } from "./calendar";
import {
  createAnniversary,
  deleteAnniversary,
  deletePushSubscription,
  getAnniversary,
  listAnniversaries,
  loginUser,
  logoutUser,
  pushSubscriptionCount,
  savePushSubscription,
  updateAnniversary,
  userForRequest,
  logPush,
} from "./data";
import { dispatchScheduledReminders, notificationMessage, sendWecomWebhook } from "./reminders";
import type { Env } from "./types";
import { ApiError, json, localNow, readJson } from "./utils";
import { sendWebPushToUser } from "./webpush";

function numericId(value: string | undefined): number {
  const id = Number(value);
  if (!value || !Number.isSafeInteger(id) || id < 1) throw new ApiError(404, "找不到纪念日");
  return id;
}

function pushConfigured(env: Env): boolean {
  return Boolean(env.VAPID_PRIVATE_KEY && env.VAPID_PUBLIC_KEY && !env.VAPID_PUBLIC_KEY.startsWith("REPLACE_"));
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (request.method === "GET" && path === "/api/health") return json({ status: "ok" });
  if (request.method === "POST" && path === "/api/auth/login") {
    const result = await loginUser(env.DB, await readJson(request));
    return json({ ...result, push_public_key: pushConfigured(env) ? env.VAPID_PUBLIC_KEY : "" });
  }

  const user = await userForRequest(env.DB, request);
  const now = localNow(env.APP_TIMEZONE || "Asia/Shanghai");
  if (request.method === "GET" && path === "/api/auth/me") {
    return json({ user, push_public_key: pushConfigured(env) ? env.VAPID_PUBLIC_KEY : "" });
  }
  if (request.method === "POST" && path === "/api/auth/logout") {
    await logoutUser(env.DB, request);
    return json({ logged_out: true });
  }
  if (request.method === "GET" && path === "/api/anniversaries") {
    const rows = await listAnniversaries(env.DB, user.id);
    return json({ items: rows.map((row) => serializeAnniversary(row, now)) });
  }
  if (request.method === "POST" && path === "/api/anniversaries") {
    return json({ item: await createAnniversary(env.DB, user.id, await readJson(request), now) }, 201);
  }
  if (request.method === "GET" && path === "/api/lunar/options") {
    const solarDate = url.searchParams.get("solar_date") || undefined;
    let year = Number(url.searchParams.get("year") || now.year);
    if (solarDate) {
      const selected = lunarYearOptions(now.year, solarDate).selected as { year: number };
      year = selected.year;
    }
    return json(lunarYearOptions(year, solarDate));
  }
  if (request.method === "GET" && ["/api/push/config", "/api/anniversaries/push-config"].includes(path)) {
    return json({
      public_key: pushConfigured(env) ? env.VAPID_PUBLIC_KEY : "",
      subscription_count: await pushSubscriptionCount(env.DB, user.id),
    });
  }
  if (["/api/push/subscriptions", "/api/anniversaries/push-subscription"].includes(path)) {
    const payload = await readJson(request);
    if (request.method === "POST") {
      const count = await savePushSubscription(env.DB, user.id, payload, request.headers.get("User-Agent") ?? "");
      return json({ subscribed: true, subscription_count: count });
    }
    if (request.method === "DELETE") return json({ deleted: await deletePushSubscription(env.DB, user.id, payload) });
  }
  if (request.method === "POST" && ["/api/push/test", "/api/anniversaries/push-test"].includes(path)) {
    if (!pushConfigured(env)) throw new ApiError(503, "服务端尚未配置 VAPID 密钥");
    const result = await sendWebPushToUser(env, user.id, "纪念簿通知已开启", "这是一条测试消息，今后的纪念日会按你的设置提醒。", "anniversary-test");
    if (result.successCount) return json({ success: true, message: result.detail, sent: result.successCount });
    throw new ApiError(result.failureCount ? 502 : 400, result.detail);
  }

  const itemMatch = /^\/api\/anniversaries\/(\d+)$/.exec(path);
  if (itemMatch && request.method === "PUT") {
    const item = await updateAnniversary(env.DB, numericId(itemMatch[1]), user.id, await readJson(request), now);
    if (!item) throw new ApiError(404, "找不到纪念日");
    return json({ item });
  }
  if (itemMatch && request.method === "DELETE") {
    const deleted = await deleteAnniversary(env.DB, numericId(itemMatch[1]), user.id);
    if (!deleted) throw new ApiError(404, "找不到纪念日");
    return json({ deleted: true });
  }
  const webhookMatch = /^\/api\/anniversaries\/(\d+)\/test-webhook$/.exec(path);
  if (webhookMatch && request.method === "POST") {
    const id = numericId(webhookMatch[1]);
    const item = await getAnniversary(env.DB, id, user.id);
    if (!item) throw new ApiError(404, "找不到纪念日");
    if (!item.webhook_url) throw new ApiError(400, "请先填写企业微信机器人地址");
    const result = await sendWecomWebhook(item.webhook_url, notificationMessage(item, now));
    await logPush(env.DB, user.id, id, "wecom", result.success ? "success" : "failed", `测试：${result.detail}`);
    if (!result.success) throw new ApiError(502, result.detail);
    return json({ success: true, message: result.detail });
  }
  throw new ApiError(404, "接口不存在");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: "服务器内部错误" }, 500);
    }
  },

  async scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(dispatchScheduledReminders(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
