// Account usernames: the <username> in https://<our host>/<username>/v/<id>. Links route by recording id, so a
// username only decides the canonical path; a wrong or old one 301s to the current one.

/** First path segments the site uses or may use. Never assignable. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "v", "mcp", "api", "oauth", "well-known", "upload", "admin", "login", "signup", "settings", "pricing", "faq", "about",
  "www", "static", "assets", "recitbot",
  // Existing routes and files at the root.
  "m", "s", "device", "install", "uninstall",
  // Homepage pages and files (worker/home).
  "terms", "privacy", "fonts",
]);

const SHAPE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/;

export type UsernameProblem = "INVALID_USERNAME" | "USERNAME_RESERVED";

/** null = acceptable. Rules: 3-30 chars of [a-z0-9-], starts and ends with a letter or digit, no "--", not reserved. */
export function usernameProblem(name: string): UsernameProblem | null {
  if (!SHAPE.test(name) || name.includes("--")) return "INVALID_USERNAME";
  return RESERVED_USERNAMES.has(name) ? "USERNAME_RESERVED" : null;
}

/** Hint (email, email local part or a name) -> slug: lowercase ASCII, runs of anything else become "-", max 24 chars. */
export function usernameBase(hint: string | null | undefined): string {
  const local = (hint ?? "").split("@")[0];
  return local
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 24)
    .replace(/^-+|-+$/g, "");
}

const SUFFIX = "abcdefghijklmnopqrstuvwxyz0123456789";
function suffix(): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(4))) s += SUFFIX[b % 36];
  return s;
}

const isUniqueViolation = (e: unknown) => /UNIQUE constraint failed/i.test(String(e));

type AccountRow = { username: string | null; email: string | null; bot_name: string | null };

/**
 * The account's username, assigning one when it has none. Idempotent: an account that already has a username keeps it
 * (the hint is then ignored). Derived from `hint`, else the account's email local part, else its bot name, else "user";
 * a taken, reserved or too-short base gets a 4-char suffix ("alex-x7k2").
 */
export async function assignUsername(db: D1Database, accountId: string, hint?: string | null): Promise<string> {
  const row = await db.prepare("SELECT username, email, bot_name FROM accounts WHERE id = ?").bind(accountId).first<AccountRow>();
  if (!row) throw new Error("assignUsername: no such account");
  if (row.username) return row.username;
  const base = usernameBase(hint || row.email || row.bot_name) || "user";
  for (let i = 0; i < 10; i++) {
    const candidate = i === 0 ? base : `${base}-${suffix()}`;
    if (usernameProblem(candidate)) continue;
    try {
      const r = await db.prepare("UPDATE accounts SET username = ? WHERE id = ? AND username IS NULL").bind(candidate, accountId).run();
      if (r.meta.changes) return candidate;
      // Someone else assigned it in the meantime: theirs wins.
      const cur = await db.prepare("SELECT username FROM accounts WHERE id = ?").bind(accountId).first<{ username: string | null }>();
      if (cur?.username) return cur.username;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new Error("assignUsername: no free username");
}

/** Changes an account's username. Old links keep working (they route by recording id and redirect). */
export async function setUsername(
  db: D1Database,
  accountId: string,
  name: string,
): Promise<{ ok: true; username: string } | { ok: false; error: UsernameProblem | "USERNAME_TAKEN" }> {
  const problem = usernameProblem(name);
  if (problem) return { ok: false, error: problem };
  try {
    await db.prepare("UPDATE accounts SET username = ? WHERE id = ?").bind(name, accountId).run();
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: "USERNAME_TAKEN" };
    throw e;
  }
  return { ok: true, username: name };
}

/** Username plus the name the share page shows ("Recorded by ..."): display_name when set, else the username. */
export async function accountByline(db: D1Database, accountId: string): Promise<{ username: string; shown: string }> {
  const username = await assignUsername(db, accountId);
  const row = await db.prepare("SELECT display_name FROM accounts WHERE id = ?").bind(accountId).first<{ display_name: string | null }>();
  return { username, shown: row?.display_name?.trim() || username };
}
