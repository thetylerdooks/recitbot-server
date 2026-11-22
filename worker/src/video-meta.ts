// A recording's owner-set title and short description: validation and the one UPDATE. Used by the update_video MCP
// tool and the watch page's owner PATCH. Plain text is stored; escaping happens where it is rendered.
import type { Env } from "./env";

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 280;

export type VideoMetaInput = { title?: unknown; description?: unknown };
export type VideoMeta = { ok: true; title?: string | null; description?: string | null } | { ok: false; error: string };

/** Thrown by setVideoMeta on invalid input; callers map it to INVALID_ARGUMENTS (or a 400). */
export class VideoMetaError extends Error {}

/** Titles are one line: control characters (Unicode Cc: newlines, tabs, NUL, ...) removed, then trimmed. */
const clean = (s: string) => s.replace(/\p{Cc}/gu, "").trim();
/**
 * Descriptions keep line breaks: CRLF (and a lone CR) becomes LF, every other control character is removed, trailing
 * spaces on each line go, 3 or more blank lines in a row become 2, then the whole is trimmed.
 */
const cleanDescription = (s: string) =>
  s
    .replace(/\r\n?/g, "\n")
    .replace(/[^\P{Cc}\n]/gu, "")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
/** Length in code points, so one emoji counts as one character. */
const chars = (s: string) => [...s].length;

/**
 * title: up to 120 characters; empty or blank resets it to the default (null, as on a new recording). description:
 * 0-280 characters, '' clears it (null). At least one of the two.
 */
export function validateVideoMeta(input: VideoMetaInput): VideoMeta {
  const out: { ok: true; title?: string | null; description?: string | null } = { ok: true };
  if (input.title === undefined && input.description === undefined) return { ok: false, error: "Pass a title, a description or both." };
  if (input.title !== undefined) {
    if (typeof input.title !== "string") return { ok: false, error: "title must be a string." };
    const t = clean(input.title);
    if (chars(t) > TITLE_MAX) return { ok: false, error: `title is longer than ${TITLE_MAX} characters.` };
    out.title = t || null;
  }
  if (input.description !== undefined) {
    if (typeof input.description !== "string") return { ok: false, error: "description must be a string." };
    const d = cleanDescription(input.description);
    if (chars(d) > DESCRIPTION_MAX) return { ok: false, error: `description is longer than ${DESCRIPTION_MAX} characters.` };
    out.description = d || null;
  }
  return out;
}

export type VideoMetaRow = {
  id: string;
  account_id: string;
  title: string | null;
  description: string | null;
  status: string;
  created_at: number;
  expires_at: number;
};

/**
 * Sets the given fields on a recording of this account. Throws VideoMetaError on invalid input; returns the updated
 * row, or null when no such recording exists on this account.
 */
export async function setVideoMeta(env: Env, accountId: string, videoId: string, meta: VideoMetaInput): Promise<VideoMetaRow | null> {
  const v = validateVideoMeta(meta);
  if (!v.ok) throw new VideoMetaError(v.error);
  const cols: string[] = [];
  const vals: (string | null)[] = [];
  if (v.title !== undefined) {
    cols.push("title = ?");
    vals.push(v.title);
  }
  if (v.description !== undefined) {
    cols.push("description = ?");
    vals.push(v.description);
  }
  return env.DB.prepare(`UPDATE recordings SET ${cols.join(", ")} WHERE id = ? AND account_id = ? RETURNING *`)
    .bind(...vals, videoId, accountId)
    .first<VideoMetaRow>();
}
