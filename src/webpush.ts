import { pushSubscriptions } from "./data";
import type { Env, PushSubscriptionRow } from "./types";
import { base64UrlDecode, base64UrlEncode, concatBytes, encoder } from "./utils";

const AES_RECORD_SIZE = 4096;

async function hkdf(
  input: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", input, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

export async function encryptPushPayload(subscription: PushSubscriptionRow, payload: string): Promise<Uint8Array<ArrayBuffer>> {
  const receiverPublicBytes = base64UrlDecode(subscription.p256dh);
  const authSecret = base64UrlDecode(subscription.auth);
  const receiverPublicKey = await crypto.subtle.importKey(
    "raw", receiverPublicBytes, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const senderKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  ) as CryptoKeyPair;
  const senderPublicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", senderKeys.publicKey));
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: receiverPublicKey }, senderKeys.privateKey, 256,
  ));
  const keyInfo = concatBytes(encoder.encode("WebPush: info\0"), receiverPublicBytes, senderPublicBytes);
  const inputKeyMaterial = await hkdf(sharedSecret, authSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const contentEncryptionKey = await hkdf(inputKeyMaterial, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(inputKeyMaterial, salt, encoder.encode("Content-Encoding: nonce\0"), 12);
  const plaintext = concatBytes(encoder.encode(payload), new Uint8Array([2]));
  if (plaintext.length + 16 > AES_RECORD_SIZE) throw new Error("Web Push payload is too large");
  const aesKey = await crypto.subtle.importKey("raw", contentEncryptionKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext));
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, AES_RECORD_SIZE);
  return concatBytes(salt, recordSize, new Uint8Array([senderPublicBytes.length]), senderPublicBytes, ciphertext);
}

export async function createVapidAuthorization(endpoint: string, env: Env): Promise<string> {
  const publicKey = base64UrlDecode(env.VAPID_PUBLIC_KEY);
  const privateKey = base64UrlDecode(env.VAPID_PRIVATE_KEY);
  if (publicKey.length !== 65 || publicKey[0] !== 4 || privateKey.length !== 32) {
    throw new Error("VAPID key configuration is invalid");
  }
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT,
  })));
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", x: base64UrlEncode(publicKey.slice(1, 33)),
    y: base64UrlEncode(publicKey.slice(33, 65)), d: base64UrlEncode(privateKey), ext: false,
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(signingInput));
  return `vapid t=${signingInput}.${base64UrlEncode(signature)}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function sendOne(subscription: PushSubscriptionRow, payload: string, env: Env): Promise<Response> {
  const [body, authorization] = await Promise.all([
    encryptPushPayload(subscription, payload),
    createVapidAuthorization(subscription.endpoint, env),
  ]);
  return fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
    },
    body,
  });
}

export interface PushResult {
  successCount: number;
  failureCount: number;
  detail: string;
}

export async function sendWebPushToUser(
  env: Env,
  userId: number,
  title: string,
  body: string,
  tag = "anniversary-reminder",
): Promise<PushResult> {
  const subscriptions = await pushSubscriptions(env.DB, userId);
  if (!subscriptions.length) return { successCount: 0, failureCount: 0, detail: "该用户还没有开启系统通知" };
  const payload = JSON.stringify({
    title, body, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", url: "/", tag,
  });
  let successCount = 0;
  let failureCount = 0;
  const errors: string[] = [];
  for (const subscription of subscriptions) {
    try {
      const response = await sendOne(subscription, payload, env);
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`), { status: response.status });
      successCount += 1;
      await env.DB.prepare("UPDATE push_subscriptions SET last_success_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?").bind(subscription.id).run();
    } catch (error) {
      failureCount += 1;
      const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(detail.slice(0, 180));
      if (status === 404 || status === 410) {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(subscription.id).run();
      } else {
        await env.DB.prepare("UPDATE push_subscriptions SET last_error = ? WHERE id = ?").bind(detail.slice(0, 500), subscription.id).run();
      }
    }
  }
  let detail = `成功 ${successCount} 台，失败 ${failureCount} 台`;
  if (errors.length) detail += `；${errors[0]}`;
  return { successCount, failureCount, detail };
}
