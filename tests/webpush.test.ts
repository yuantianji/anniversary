import assert from "node:assert/strict";
import test from "node:test";
import type { Env, PushSubscriptionRow } from "../src/types.ts";
import { base64UrlDecode, base64UrlEncode, concatBytes, encoder } from "../src/utils.ts";
import { createVapidAuthorization, encryptPushPayload } from "../src/webpush.ts";

async function hkdf(input: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: string, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", input, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(info),
  }, key, length * 8));
}

test("produces an RFC 8291 payload the subscriber can decrypt", async () => {
  const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const receiverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const subscription: PushSubscriptionRow = {
    id: 1, user_id: 1, endpoint: "https://push.example.test/message", p256dh: base64UrlEncode(receiverPublic), auth: base64UrlEncode(auth),
  };
  const payload = await encryptPushPayload(subscription, "测试消息");
  const salt = payload.slice(0, 16);
  const recordSize = new DataView(payload.buffer, payload.byteOffset + 16, 4).getUint32(0);
  const keyLength = payload[20];
  const senderPublic = payload.slice(21, 21 + keyLength);
  const ciphertext = payload.slice(21 + keyLength);
  assert.equal(recordSize, 4096);
  assert.equal(keyLength, 65);

  const senderKey = await crypto.subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, receiver.privateKey, 256));
  const keyInfo = concatBytes(encoder.encode("WebPush: info\0"), receiverPublic, senderPublic);
  const sharedKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: auth, info: keyInfo }, sharedKey, 256));
  const cek = await hkdf(ikm, salt, "Content-Encoding: aes128gcm\0", 16);
  const nonce = await hkdf(ikm, salt, "Content-Encoding: nonce\0", 12);
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ciphertext));
  assert.equal(plaintext.at(-1), 2);
  assert.equal(new TextDecoder().decode(plaintext.slice(0, -1)), "测试消息");
});

test("creates a verifiable VAPID JWT", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const env = {
    VAPID_PRIVATE_KEY: jwk.d!, VAPID_PUBLIC_KEY: base64UrlEncode(publicRaw), VAPID_SUBJECT: "mailto:test@example.com",
  } as Env;
  const authorization = await createVapidAuthorization("https://push.example.test/message/1", env);
  const match = /^vapid t=([^.]+\.[^.]+\.([^,]+)), k=(.+)$/.exec(authorization);
  assert.ok(match);
  const token = match[1];
  const [header, claims, signature] = token.split(".");
  assert.equal(match[3], env.VAPID_PUBLIC_KEY);
  assert.equal(JSON.parse(new TextDecoder().decode(base64UrlDecode(claims))).aud, "https://push.example.test");
  assert.equal(JSON.parse(new TextDecoder().decode(base64UrlDecode(header))).alg, "ES256");
  assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, base64UrlDecode(signature), encoder.encode(`${header}.${claims}`)), true);
});
