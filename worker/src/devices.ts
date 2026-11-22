// Device inventory (monitors, microphones, webcams) reported by the recorder, and the rules for matching a casual
// request ("right", "2nd", "HyperX") to one entry. Keep the rules in sync with recorder/AgentRecorder.cs `DeviceMatch`:
// the server resolves against the last report to fail fast; the recorder re-checks against its own live inventory.
import { z } from "zod";

const Name = z.string().max(256);
/** The recorder reports at most this many windows (z-order, topmost first). */
export const MAX_WINDOWS = 40;

export const MonitorEntry = z.object({
  id: z.string().regex(/^mon_[0-9a-f]{10}$/),
  index: z.number().int().min(0).max(63),
  output_idx: z.number().int().min(-1).max(63),
  name: Name,
  friendly_name: Name,
  primary: z.boolean(),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scale: z.number().positive().max(10),
  position: z.number().int().min(0).max(63),
  label: z.enum(["left", "center", "right"]),
});
export const MicEntry = z.object({ id: z.string().regex(/^mic_[0-9a-f]{10}$/), name: Name, default: z.boolean() });
export const CameraEntry = z.object({ id: z.string().regex(/^cam_[0-9a-f]{10}$/), name: Name });
/** An open top-level window (z-order, topmost first). `monitor` is the id of the monitor holding most of it ("" if none). */
export const WindowEntry = z.object({
  id: z.string().regex(/^win_[0-9a-f]{10}$/),
  app: Name,
  exe: Name,
  title: Name,
  monitor: z.union([z.literal(""), z.string().regex(/^mon_[0-9a-f]{10}$/)]),
  minimized: z.boolean(),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
});

/** {"type":"devices",...} frame from the recorder (on connect, and in answer to a signed "devices" command). */
export const DevicesReport = z.object({
  type: z.literal("devices"),
  request_id: z.string().max(64),
  monitors: z.array(MonitorEntry).max(16),
  mics: z.array(MicEntry).max(32),
  cameras: z.array(CameraEntry).max(32),
  /** Recorders older than 0.3 do not report windows (and cannot record one). */
  windows: z.array(WindowEntry).max(MAX_WINDOWS).optional(),
});

export type Monitor = z.infer<typeof MonitorEntry>;
export type Mic = z.infer<typeof MicEntry>;
export type Camera = z.infer<typeof CameraEntry>;
export type Window = z.infer<typeof WindowEntry>;
export type Inventory = { monitors: Monitor[]; mics: Mic[]; cameras: Camera[]; windows?: Window[] };
export type StoredInventory = Inventory & { device_id: string; at: number };

/** Ids, names and device names only contain these (no separators of the signed canonical form, no quotes). */
export const DEVICE_QUERY = /^[^|"\\\u0000-\u001f]+$/;

export type Match<T, E extends string = "DEVICE_NOT_FOUND" | "DEVICE_AMBIGUOUS"> = { item: T } | { error: E; candidates: T[] };

const PRIMARY = ["primary", "main", "default"];
const SECONDARY = ["secondary", "second", "2nd", "other", "external", "non-primary"];

function unique<T>(hits: T[], all: T[]): Match<T> {
  if (hits.length === 1) return { item: hits[0] };
  return hits.length ? { error: "DEVICE_AMBIGUOUS", candidates: hits } : { error: "DEVICE_NOT_FOUND", candidates: all };
}

/** "primary"/"main", an index, an id, a device name, left/right/center, "second"/"other" or part of the model name. */
export function matchMonitor(ms: Monitor[], query: string | number | undefined): Match<Monitor> {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q || PRIMARY.includes(q)) {
    const p = ms.find((m) => m.primary) ?? ms[0];
    return p ? { item: p } : { error: "DEVICE_NOT_FOUND", candidates: ms };
  }
  if (/^\d+$/.test(q)) return unique(ms.filter((m) => m.index === Number(q)), ms);
  const hit = ms.find((m) => m.id === q || m.name.toLowerCase() === q || m.name.toLowerCase().replace(/^[\\.]+/, "") === q);
  if (hit) return { item: hit };
  const label = q === "middle" ? "center" : q;
  if (label === "left" || label === "right" || label === "center") return unique(ms.filter((m) => m.label === label), ms);
  if (SECONDARY.includes(q)) return unique(ms.filter((m) => !m.primary), ms);
  return unique(ms.filter((m) => m.friendly_name.toLowerCase().includes(q)), ms);
}

/** An id, the exact name, "default" (mics) or a unique part of the name ("HyperX"). */
export function matchAv<T extends { id: string; name: string; default?: boolean }>(ds: T[], query: string): Match<T> {
  const q = query.trim().toLowerCase();
  if (!q) return { error: "DEVICE_NOT_FOUND", candidates: ds };
  const hit = ds.find((d) => d.id === q || d.name.toLowerCase() === q);
  if (hit) return { item: hit };
  if (q === "default") return unique(ds.filter((d) => d.default), ds);
  return unique(ds.filter((d) => d.name.toLowerCase().includes(q)), ds);
}

/** Words people wrap around a window name ("the youtube window", "that notepad", "chrome with youtube open"). */
const WINDOW_FILLER = new Set(["the", "my", "a", "an", "this", "that", "window", "app", "application", "tab", "open", "opened", "with", "and", "of", "on", "in"]);

export function windowTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter((t) => t && !WINDOW_FILLER.has(t));
}

export type WindowMatch = Match<Window, "WINDOW_NOT_FOUND" | "WINDOW_AMBIGUOUS">;

/**
 * An id, an exact title, or tokens that must ALL appear in "app exe title" (case-insensitive): "chrome youtube" matches
 * app "Google Chrome" with a title containing "YouTube". Several hits = ambiguous (ask the user); none = the windows
 * matching the most tokens as candidates.
 */
export function matchWindow(ws: Window[], query: string): WindowMatch {
  const q = query.trim().toLowerCase();
  const byId = ws.find((w) => w.id === q);
  if (byId) return { item: byId };
  const exact = ws.filter((w) => w.title.toLowerCase() === q);
  if (q && exact.length === 1) return { item: exact[0] };
  const tokens = windowTokens(q);
  const hay = (w: Window) => `${w.app} ${w.exe} ${w.title}`.toLowerCase();
  const score = (w: Window) => tokens.filter((t) => hay(w).includes(t)).length;
  const hits = tokens.length ? ws.filter((w) => score(w) === tokens.length) : [];
  if (hits.length === 1) return { item: hits[0] };
  if (hits.length > 1) return { error: "WINDOW_AMBIGUOUS", candidates: hits.slice(0, 10) };
  const ranked = ws
    .map((w, i) => ({ w, s: score(w), i }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.w);
  return { error: "WINDOW_NOT_FOUND", candidates: (ranked.length ? ranked : ws).slice(0, 8) };
}

/** Compact window form for tool results and error candidates. */
export function describeWindow(w: Window, monitors: Monitor[]) {
  const m = monitors.find((x) => x.id === w.monitor);
  return { id: w.id, app: w.app, title: w.title, monitor: m ? m.label : null, monitor_id: w.monitor || null, minimized: w.minimized };
}

/** Compact form for tool results and error candidates. */
export function describeMonitor(m: Monitor) {
  return {
    id: m.id,
    index: m.index,
    label: m.label,
    primary: m.primary,
    resolution: `${m.width}x${m.height}`,
    model: m.friendly_name || null,
  };
}
