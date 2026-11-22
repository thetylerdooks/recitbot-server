// POST /claim: the one-time owner claim (claim.ts), a server-to-server call by whoever set the server up. Body: `secret`, as
// a form or JSON. Success: {"owner_key": "ark_..."}, the owner's API key for the Authorization header of /mcp, shown this
// once (util.ts json: never cached). No browser, cookie or page is involved, so no Turnstile and no CORS. Nothing submitted
// is in any answer or log.
import { newApiKey } from "../auth";
import type { Env } from "../env";
import { governor } from "../governor";
import { json, log, now } from "../util";
import { netHashes } from "./authorize";
import { CLAIMS_PER_DAY, CLAIMS_PER_IP_PER_HOUR, claimOpen, claimSecretMatches, takeClaim } from "./claim";
import { readForm } from "./http";

const MAX_BODY = 4096;

/** The submitted secret; "" (matches nothing) for any body that isn't a form or a JSON object with one. */
async function submittedSecret(req: Request): Promise<string> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return (await readForm(req, MAX_BODY))?.get("secret") ?? "";
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return "";
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_BODY) return "";
  try {
    const secret = (JSON.parse(new TextDecoder().decode(buf)) as { secret?: unknown } | null)?.secret;
    return typeof secret === "string" ? secret : "";
  } catch {
    return "";
  }
}

/** null (the router's 404) unless a claim is possible. An attempt that can't be counted is refused. */
export async function claimServer(req: Request, env: Env): Promise<Response | null> {
  if (!(await claimOpen(env))) return null;
  const limited = () => json({ error: "too many tries" }, 429);
  const unavailable = () => json({ error: "unavailable" }, 503);
  const t = now();
  try {
    const g = governor(env);
    if (!(await g.hit(`owner-claim:ip:${(await netHashes(req, env)).ipHash}`, CLAIMS_PER_IP_PER_HOUR, 3600, t)).ok) return limited();
  } catch (e) {
    log("error", "owner claim: limits unavailable", { err: String(e) });
    return unavailable();
  }
  if (!(await claimSecretMatches(env, await submittedSecret(req)))) {
    // The global daily limit counts WRONG secrets only, so nobody without the secret can stall the real claim.
    log("warn", "owner claim refused");
    try {
      if (!(await governor(env).hit("owner-claim:global", CLAIMS_PER_DAY, 86400, t)).ok) return limited();
    } catch (e) {
      log("error", "owner claim: limits unavailable", { err: String(e) });
      return unavailable();
    }
    return json({ error: "claim failed" }, 403);
  }
  const { key, id, hash } = await newApiKey();
  let accountId: string | null;
  try {
    accountId = await takeClaim(env, { id, hash });
  } catch (e) {
    log("error", "owner claim failed", { err: String(e) });
    return unavailable();
  }
  if (!accountId) return json({ error: "not found" }, 404);
  log("info", "owner claim: server claimed", { account_id: accountId });
  return json({ owner_key: key });
}
