// Every video a tool returns carries title, url and a ready-made Markdown link. The URL itself is built in one place,
// share.ts videoUrl (<origin>/<username>/v/<slug>) or, for every video of an account with a live custom domain,
// share.ts videoLinks (https://<hostname>/<slug>); this module only names and formats it.
import type { Env } from "./env";
import { videoLinks, videoUrl as shareVideoUrl } from "./share";

/** The recording fields a link is built from. */
export type VideoRef = { id: string; title: string | null; created_at: number };

/** The video's one URL (share.ts). */
export function videoUrl(env: Env, origin: string, id: string, accountId: string): Promise<string> {
  return shareVideoUrl(env, origin, id, accountId);
}

export function videoTitle(rec: { title: string | null; created_at: number }): string {
  const t = rec.title?.trim();
  if (t) return t;
  return `Recording ${new Date(rec.created_at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function videoLink(title: string, url: string): string {
  return `[${title.replace(/[\r\n]+/g, " ").replace(/[\\[\]()]/g, "\\$&")}](${url})`;
}

/**
 * title, url and display for a video. custom = the account's live custom domain base (share.ts customVideoBase, looked
 * up once per tool call) or null. home (the URL on our own host, for owner links) is returned separately, never in the fields.
 */
export async function videoLinkFields(
  env: Env,
  origin: string,
  accountId: string,
  rec: VideoRef,
  custom: string | null,
): Promise<{ fields: { title: string; url: string; display: string }; home: string }> {
  const title = videoTitle(rec);
  const { url, home } = await videoLinks(env, origin, rec.id, accountId, custom);
  return { fields: { title, url, display: videoLink(title, url) }, home };
}

export async function videoFields(
  env: Env,
  origin: string,
  accountId: string,
  rec: VideoRef,
  custom: string | null = null,
): Promise<{ title: string; url: string; display: string }> {
  return (await videoLinkFields(env, origin, accountId, rec, custom)).fields;
}
