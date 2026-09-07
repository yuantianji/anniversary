import { createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const pemPath = process.env.VAPID_PEM || "vapid_private.pem";
const privateJwk = createPrivateKey(readFileSync(pemPath)).export({ format: "jwk" });
if (!privateJwk.d || !privateJwk.x || !privateJwk.y) throw new Error("VAPID PEM is not a P-256 private key");
const publicKey = Buffer.concat([
  Buffer.from([4]), Buffer.from(privateJwk.x, "base64url"), Buffer.from(privateJwk.y, "base64url"),
]).toString("base64url");

if (process.argv.includes("--public")) {
  process.stdout.write(`${publicKey}\n`);
  process.exit(0);
}

if (process.argv.includes("--dev")) {
  writeFileSync(".dev.vars", `VAPID_PRIVATE_KEY=${privateJwk.d}\n`, { mode: 0o600 });
  console.log("Created .dev.vars with the VAPID private key.");
  process.exit(0);
}

const executable = process.platform === "win32" ? "npx.cmd" : "npx";
const secretCommand = process.argv.includes("--versioned")
  ? ["wrangler", "versions", "secret", "put", "VAPID_PRIVATE_KEY"]
  : ["wrangler", "secret", "put", "VAPID_PRIVATE_KEY"];
const result = spawnSync(executable, secretCommand, {
  input: `${privateJwk.d}\n`, stdio: ["pipe", "inherit", "inherit"],
});
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`VAPID secret uploaded. Set VAPID_PUBLIC_KEY in wrangler.jsonc to:\n${publicKey}`);
