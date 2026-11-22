// Creates worker/.dev.vars with random dev-only secrets, or adds the ones an existing file lacks. Never prints values.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const file = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "worker", ".dev.vars");
const names = ["SHARE_HMAC_KEY", "UPLOAD_HMAC_KEY", "DEVICE_CMD_KEY", "IP_HASH_KEY", "INSTALLER_URL_KEY"];
const line = (n) => `${n}=${randomBytes(32).toString("base64url")}\n`;
if (existsSync(file)) {
  const have = new Set(readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.split("=")[0].trim()));
  const missing = names.filter((n) => !have.has(n));
  if (missing.length) {
    appendFileSync(file, (readFileSync(file, "utf8").endsWith("\n") ? "" : "\n") + missing.map(line).join(""));
    console.log(`worker/.dev.vars exists; added random dev-only values for: ${missing.join(", ")}`);
  } else console.log("worker/.dev.vars exists and has every secret; leaving it alone");
} else {
  writeFileSync(file, names.map(line).join(""), { mode: 0o600 });
  console.log(`wrote worker/.dev.vars with random dev-only values for: ${names.join(", ")}`);
}
