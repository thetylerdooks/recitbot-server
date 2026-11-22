// get_recording_for_skill: "learn this skill" from a Recitbot recording. Spread into mcp.ts TOOLS; like
// account-tools.ts, import this module through mcp.ts only (it imports mcp.ts back).
// Read-only and on demand: nothing is fetched or generated when a recording is made; this reads what the recording
// already has (title, description, transcript) when a bot calls it. Access follows the watch page (share.ts skillVideo).
// Keyframes: the stills recorder 0.6.1+ uploads after the MP4 (upload.ts handleKeyframe; R2 k/<id>/<n>.jpg, times in
// recording_keyframes). The Worker never decodes video: a recording from an older recorder (or audio only) has none,
// and keyframes_note says so; include_video gives the MP4, to the video's owner on a paid tier only (share.ts canDownload).
import { Buffer } from "node:buffer";
import { z } from "zod";
import type { Env } from "./env";
import { accountLimits, LIMITS } from "./env";
import { EXTRA_CONTENT, ToolError, tool, type ContentBlock } from "./mcp";
import { recordingExpired } from "./retention-hold";
import { canDownload, customVideoBase, mmss, parseVideoRef, skillVideo, videoFileUrl, type Segment } from "./share";
import { DOWNLOAD_OWNER_ONLY } from "./selfhost-text";
import { billingConfigured } from "./stripe";
import { recordingRemoved, REMOVED_MESSAGE } from "./takedown-state";
import { keyframeKey } from "./upload";
import { now } from "./util";
import { videoFields } from "./video-url";

const KEYFRAMES_NOTE =
  "This recording has no still frames (it was made by an older recorder, or has no video picture), so keyframes is " +
  "empty. Work from the transcript.";

/** include_video on the owner's own video on Free: no file, the rest of the result as usual. */
const UPGRADE_REQUIRED = {
  error: "UPGRADE_REQUIRED",
  message: "Downloading the video file is part of Recitbot Pro ($10/mo or $100/yr). Upgrade to Pro to download your videos; you can still watch it on its page.",
};

/** include_video on another account's video: its file is only ever for its owner. */
const VIDEO_FILE_NOT_SHARED = {
  error: "VIDEO_FILE_NOT_SHARED",
  message: "This video's file isn't available to share: only its owner can download it. You can still watch it on its page.",
};

const SKILL_INSTRUCTIONS =
  "Learn this skill: read the transcript (and watch the video, if you fetched it) and follow the steps the user " +
  "performs. Then write a reusable skill from them: the goal, what is needed first, numbered steps with the exact " +
  "actions, inputs and expected results, and the pitfalls the recording shows. Leave out private details seen in it " +
  "(names, emails, passwords, keys).";

export const LEARN_TOOLS = {
  get_recording_for_skill: tool({
    auth: true,
    description:
      "Use this when the user sends you a Recitbot recording (a video link or recording id) and asks you to learn from " +
      "it: 'learn this skill', 'learn how I do this', 'watch this and make a skill'. Returns the recording's title, " +
      "description, duration, creation time and full timestamped transcript, plus an instruction for writing a reusable " +
      "skill from it. Works for the user's own recordings (recording_id or url) and for videos shared publicly by " +
      "anyone (url only); private videos of other accounts and revoked links are NOT_FOUND. keyframes: up to " +
      "max_keyframes still frames of the screen spread over the video, in time order ({n, t_ms, at}), each also sent as " +
      "a JPEG image after the JSON, labelled with its time; empty with keyframes_note when the recording has none. " +
      "include_video:true is only for the user's own recording on Pro or Owner: it adds video.url, a link to the " +
      `MP4 you can download for ${LIMITS.videoFileUrlSeconds / 60} minutes (with size_bytes and mime_type); only ask for ` +
      "it when you can actually watch video, and never post video.url anywhere. On Free, video is {error: " +
      "UPGRADE_REQUIRED, message}; for someone else's video it is {error: VIDEO_FILE_NOT_SHARED, message}; the rest of " +
      "the result is the same. Free has no video download: never promise one, tell the user the message (they can " +
      "watch it on its page). Nothing is generated ahead of time: this only reads the recording when you call it.",
    input: z.object({
      recording_id: z
        .string()
        .regex(/^[A-Za-z0-9]{20,30}$/, "invalid recording_id")
        .optional()
        .describe("One of the user's own recordings (an id from list_videos or get_video). Pass this or url."),
      url: z
        .string()
        .min(1)
        .max(2048)
        .optional()
        .describe("A Recitbot video URL the user sent, https://<host>/<username>/v/<slug>. Pass this or recording_id."),
      include_video: z
        .boolean()
        .default(false)
        .describe(
          `true = also return video.url, a ${LIMITS.videoFileUrlSeconds / 60}-minute link to the MP4: the user's own video on Pro or Owner only. Default false.`,
        ),
      max_keyframes: z.number().int().min(0).max(12).default(6).describe("At most this many still frames (0-12, default 6)."),
    }),
    async run(a, c) {
      if ((a.recording_id === undefined) === (a.url === undefined)) {
        throw new ToolError("INVALID_ARGUMENTS", "Pass either recording_id or url (one of them).");
      }
      const ref = a.recording_id !== undefined ? { id: a.recording_id } : parseVideoRef(a.url!);
      if (!ref) throw new ToolError("INVALID_ARGUMENTS", "url is not a Recitbot video link (https://<host>/<username>/v/<slug>).");
      const found = await skillVideo(c.env, c.principal!.accountId, ref);
      if (!found) throw new ToolError("NOT_FOUND", "No such video, or it is private or its link was revoked. Ask the user for a link that is shared.");
      const { rec, own } = found;
      if (await recordingRemoved(c.env, rec.id, rec.account_id)) throw new ToolError("RECORDING_REMOVED", REMOVED_MESSAGE);
      if (found.passcode) {
        throw new ToolError("PASSCODE_PROTECTED", "This shared video needs a passcode. Ask its owner to share it without one, or to send it from their own account.");
      }
      if (recordingExpired(rec, now())) throw new ToolError("NOT_READY", "Recording status is expired.");
      if (rec.status !== "ready") throw new ToolError("NOT_READY", `Recording status is ${rec.status}.`);

      let segments: Segment[] = [];
      try {
        segments = rec.transcript ? ((JSON.parse(rec.transcript) as { segments?: Segment[] }).segments ?? []) : [];
      } catch {
        segments = [];
      }
      const out: Record<string | symbol, unknown> = {
        source: own ? "own" : "shared_link",
        ...(own && { recording_id: rec.id }),
        ...(await videoFields(c.env, c.base, rec.account_id, rec, await customVideoBase(c.env, rec.account_id))),
        description: rec.description,
        duration_s: rec.duration_s,
        created_at: new Date(rec.created_at * 1000).toISOString(),
        transcript_status: rec.transcript_status,
        transcript: segments.map((s) => ({ start: round(s.start), end: round(s.end), text: String(s.text).trim() })),
      };
      const frames = await keyframes(c.env, rec.id, a.max_keyframes);
      out.keyframes = frames.map(({ image: _i, ...k }) => k);
      if (!frames.length && a.max_keyframes > 0) out.keyframes_note = KEYFRAMES_NOTE;
      out[EXTRA_CONTENT] = frames.flatMap((k): ContentBlock[] => [
        { type: "text", text: `Keyframe ${k.n} at ${k.at} (t_ms ${k.t_ms})` },
        { type: "image", data: k.image, mimeType: "image/jpeg" },
      ]);
      if (a.include_video) out.video = await videoFile(c.env, c.base, rec, own);
      out.instructions = SKILL_INSTRUCTIONS;
      return out;
    },
  }),
};

const round = (t: number) => Math.round(Number(t) * 100) / 100;

/**
 * include_video's video: the signed MP4 link when canDownload (the caller owns the video and its account is on a paid
 * tier), else UPGRADE_REQUIRED (own video on Free) or VIDEO_FILE_NOT_SHARED (another account's video).
 */
async function videoFile(env: Env, base: string, rec: { id: string; account_id: string }, own: boolean): Promise<Record<string, unknown>> {
  if (!canDownload(own, (await accountLimits(env, rec.account_id)).tier)) return !own ? VIDEO_FILE_NOT_SHARED : billingConfigured(env) ? UPGRADE_REQUIRED : DOWNLOAD_OWNER_ONLY;
  const head = await env.MEDIA.head(`v/${rec.id}.mp4`);
  if (!head) throw new ToolError("VIDEO_UNAVAILABLE", "The video file is not available.");
  const file = await videoFileUrl(env, base, rec.id);
  return { url: file.url, expires_at: new Date(file.expires_at * 1000).toISOString(), size_bytes: head.size, mime_type: "video/mp4" };
}

/**
 * The recording's stored keyframes, at most `max`, in time order. When it has more than `max`, they are picked evenly
 * across the video (first and last kept). A row whose image is missing in R2 is left out.
 */
async function keyframes(env: Env, id: string, max: number): Promise<{ n: number; t_ms: number; at: string; image: string }[]> {
  if (max <= 0) return [];
  const rows = (
    await env.DB.prepare("SELECT n, t_ms FROM recording_keyframes WHERE recording_id = ? ORDER BY t_ms, n").bind(id).all<{ n: number; t_ms: number }>()
  ).results;
  const picked = rows.length <= max ? rows : max === 1 ? [rows[0]] : Array.from({ length: max }, (_, i) => rows[Math.round((i * (rows.length - 1)) / (max - 1))]);
  const out = [];
  for (const r of picked) {
    const obj = await env.MEDIA.get(keyframeKey(id, r.n));
    if (!obj) continue;
    out.push({ n: r.n, t_ms: r.t_ms, at: mmss(r.t_ms / 1000), image: Buffer.from(await obj.arrayBuffer()).toString("base64") });
  }
  return out;
}
