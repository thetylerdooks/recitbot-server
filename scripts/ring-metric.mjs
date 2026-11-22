// Webcam-bubble ring stability: decodes a clip that contains the bubble, samples the pixels on the ring
// (a band just inside the bubble's outline: circle, or 16:9 rounded rectangle) in every frame and reports how much
// they change over time. A stable, opaque ring stays near-white in every frame; a flickering one drops to camera
// pixels in some.
// Usage (standalone): node scripts/ring-metric.mjs <video> <x> <y> <side|WxH> [ringWidthPx] [radius]
//   (WxH = rectangle bubble; radius = its corner radius, default 12 % of H as the recorder draws it)
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Distance inside the bubble's outer outline (positive inside); same shapes as recorder BubbleSurface.Geometry. */
export function insideDistance(x, y, w, h, shape, radius) {
  const cx = w / 2, cy = h / 2;
  if (shape !== "rect") return cx - Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  const hx = cx, hy = cy, rr = Math.min(radius ?? 0.12 * h, hx, hy);
  const qx = Math.abs(x + 0.5 - cx) - (hx - rr), qy = Math.abs(y + 0.5 - cy) - (hy - rr);
  return -(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr);
}

/**
 * rect is in video pixels: {x, y, side} for the round bubble, or {x, y, w, h, shape: "rect", radius} for the
 * rectangle. Returns per-frame ring luminance stats and an overall verdict.
 */
export function ringStability(video, rect, ringWidth = 3, extra = []) {
  const w = Math.round(rect.w ?? rect.side), h = Math.round(rect.h ?? rect.side);
  const raw = execFileSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", ...extra, "-i", video, "-vf", `crop=${w}:${h}:${Math.round(rect.x)}:${Math.round(rect.y)},format=gray`, "-f", "rawvideo", "-"],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  const n = w * h;
  const frames = Math.floor(raw.length / n);
  const ring = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = insideDistance(x, y, w, h, rect.shape, rect.radius);
      // Core of the ring only: skip the anti-aliased half-pixels on both edges.
      if (d >= 1 && d <= ringWidth - 1) ring.push(y * w + x);
    }
  }
  const means = [];
  let dark = 0;
  const sum = new Float64Array(ring.length);
  const sq = new Float64Array(ring.length);
  for (let f = 0; f < frames; f++) {
    const off = f * n;
    let m = 0;
    for (let i = 0; i < ring.length; i++) {
      const v = raw[off + ring[i]];
      m += v;
      sum[i] += v;
      sq[i] += v * v;
      if (v < 200) dark++;
    }
    means.push(m / ring.length);
  }
  let stdSum = 0;
  for (let i = 0; i < ring.length; i++) {
    const mu = sum[i] / frames;
    stdSum += Math.sqrt(Math.max(0, sq[i] / frames - mu * mu));
  }
  let maxJump = 0;
  for (let f = 1; f < means.length; f++) maxJump = Math.max(maxJump, Math.abs(means[f] - means[f - 1]));
  // A frame is broken when its ring is clearly darker than the ring usually is. On a bright background the ring
  // encodes near 250 (threshold 200); on a dark one (YouTube's dark theme) the encoder bleeds the black into the
  // 3 px ring and a steady ring sits near 200, so the threshold follows the median.
  const median = [...means].sort((a, b) => a - b)[Math.floor(means.length / 2)] ?? 0;
  const brokenBelow = Math.min(200, median - 25);
  const out = {
    frames,
    ring_pixels: ring.length,
    ring_luma_mean: +(means.reduce((a, b) => a + b, 0) / Math.max(1, frames)).toFixed(2),
    ring_luma_min_frame: +Math.min(...means).toFixed(2),
    ring_temporal_std_mean: +(stdSum / Math.max(1, ring.length)).toFixed(3),
    ring_dark_sample_pct: +((dark / Math.max(1, frames * ring.length)) * 100).toFixed(3),
    frames_with_broken_ring: means.filter((m) => m < brokenBelow).length,
    max_frame_to_frame_jump: +maxJump.toFixed(2),
  };
  out.stable = out.frames > 0 && out.frames_with_broken_ring === 0 && out.ring_temporal_std_mean < 6;
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [video, x, y, size, ringW, radius] = process.argv.slice(2);
  const [bw, bh] = size.split("x").map(Number);
  const rect = bh ? { x: +x, y: +y, w: bw, h: bh, shape: "rect", radius: radius ? +radius : undefined } : { x: +x, y: +y, side: bw };
  console.log(JSON.stringify(ringStability(video, rect, ringW ? +ringW : 3), null, 2));
}
