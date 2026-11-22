// Minimal MP4 box builders for tests (mp4-duration.ts and the upload fixtures in helpers.ts).

export const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Box header (8 bytes, or 16 with a 64-bit largesize) + body. */
export function box(type: string, body: Uint8Array, large = false): Uint8Array {
  const hdr = large ? 16 : 8;
  const b = new Uint8Array(hdr + body.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, large ? 1 : hdr + body.length);
  b.set(new TextEncoder().encode(type), 4);
  if (large) v.setBigUint64(8, BigInt(hdr + body.length));
  b.set(body, hdr);
  return b;
}

/** mvhd / mdhd: version 0 (32-bit times and duration) or 1 (64-bit). */
function timed(type: string, version: 0 | 1, timescale: number, duration: number | bigint): Uint8Array {
  const b = new Uint8Array(type === "mvhd" ? (version ? 112 : 100) : version ? 36 : 24);
  const v = new DataView(b.buffer);
  b[0] = version;
  if (version) {
    v.setUint32(20, timescale);
    v.setBigUint64(24, BigInt(duration));
  } else {
    v.setUint32(12, timescale);
    v.setUint32(16, Number(duration));
  }
  return box(type, b);
}

export const mvhd = (version: 0 | 1, timescale: number, duration: number | bigint) => timed("mvhd", version, timescale, duration);
export const mdhd = (version: 0 | 1, timescale: number, duration: number | bigint) => timed("mdhd", version, timescale, duration);

/** tkhd with a duration in the movie timescale (and a track_ID, 0 unless given). */
export function tkhd(version: 0 | 1, duration: number | bigint, trackId = 0): Uint8Array {
  const b = new Uint8Array(version ? 96 : 84);
  const v = new DataView(b.buffer);
  b[0] = version;
  if (version) {
    v.setUint32(20, trackId);
    v.setBigUint64(28, BigInt(duration));
  } else {
    v.setUint32(12, trackId);
    v.setUint32(20, Number(duration));
  }
  return box("tkhd", b);
}

/** stts from [sample_count, sample_delta] runs. */
export function stts(runs: [number, number][]): Uint8Array {
  const b = new Uint8Array(8 + runs.length * 8);
  const v = new DataView(b.buffer);
  v.setUint32(4, runs.length);
  runs.forEach(([n, d], i) => {
    v.setUint32(8 + i * 8, n);
    v.setUint32(12 + i * 8, d);
  });
  return box("stts", b);
}

/** edts/elst (version 0) from segment durations in the movie timescale. */
export function edts(segments: number[]): Uint8Array {
  const b = new Uint8Array(8 + segments.length * 12);
  const v = new DataView(b.buffer);
  v.setUint32(4, segments.length);
  segments.forEach((d, i) => {
    v.setUint32(8 + i * 12, d);
    v.setUint32(12 + i * 12, 0);
    v.setUint32(16 + i * 12, 0x00010000);
  });
  return box("edts", box("elst", b));
}

/** A trak: tkhd (if given), extra boxes (edts), then mdia/mdhd + minf/stbl/stts. */
export function trak(o: { tkhd?: Uint8Array; mdhd: Uint8Array; stts: Uint8Array; extra?: Uint8Array[] }): Uint8Array {
  return box(
    "trak",
    cat(...(o.tkhd ? [o.tkhd] : []), ...(o.extra ?? []), box("mdia", cat(o.mdhd, box("minf", box("stbl", o.stts))))),
  );
}

export const ftyp = () => box("ftyp", new TextEncoder().encode("isom\0\0\0\0isom"));

/** One video track of `seconds` at 1000/s everywhere (mvhd, tkhd, mdhd, stts: 30 fps-ish runs). */
export function moovOf(seconds: number): Uint8Array {
  const ms = Math.round(seconds * 1000);
  const frames = Math.floor(ms / 33);
  const runs: [number, number][] = frames ? [[frames, 33]] : [];
  if (ms - frames * 33 > 0) runs.push([1, ms - frames * 33]);
  return box("moov", cat(mvhd(0, 1000, ms), trak({ tkhd: tkhd(0, ms), mdhd: mdhd(0, 1000, ms), stts: stts(runs) })));
}

/** ftyp, moovOf(seconds), then an mdat of filler up to `size` bytes in all. */
export function mp4File(size: number, seconds: number): Uint8Array {
  const head = cat(ftyp(), moovOf(seconds));
  if (size < head.length + 8) throw new Error(`MP4 fixture needs at least ${head.length + 8} bytes`);
  const b = new Uint8Array(size);
  b.set(head);
  const v = new DataView(b.buffer);
  v.setUint32(head.length, size - head.length);
  b.set(new TextEncoder().encode("mdat"), head.length + 4);
  for (let i = head.length + 8; i < size; i++) b[i] = i % 251;
  return b;
}

// Fragmented MP4: moov/mvex (mehd, trex), then moof/traf (tfhd, trun) + mdat pairs.

/** A full box: version, 24-bit flags, then 32-bit fields. */
function full(type: string, version: number, flags: number, fields: number[]): Uint8Array {
  const b = new Uint8Array(4 + fields.length * 4);
  const v = new DataView(b.buffer);
  v.setUint32(0, (version << 24) | flags);
  fields.forEach((f, i) => v.setUint32(4 + i * 4, f));
  return box(type, b);
}

/** mehd: fragment_duration in the movie timescale (version 0, 32-bit). */
export const mehd = (duration: number) => full("mehd", 0, 0, [duration]);
/** trex: track_ID and its default_sample_duration. */
export const trex = (trackId: number, defaultDuration = 0) => full("trex", 0, 0, [trackId, 1, defaultDuration, 0, 0]);
export const mvex = (...kids: Uint8Array[]) => box("mvex", cat(...kids));
/** tfhd: track_ID, with default_sample_duration (flag 0x8) when given. */
export const tfhd = (trackId: number, defaultDuration?: number) =>
  defaultDuration === undefined ? full("tfhd", 0, 0, [trackId]) : full("tfhd", 0, 0x8, [trackId, defaultDuration]);
/** trun: per-sample durations (flag 0x100), or `count` samples without durations. */
export const trun = (s: number[] | { count: number }) =>
  Array.isArray(s) ? full("trun", 0, 0x100, [s.length, ...s]) : full("trun", 0, 0, [s.count]);
export const moof = (...trafs: Uint8Array[]) => box("moof", cat(full("mfhd", 0, 0, [1]), ...trafs));
export const traf = (...kids: Uint8Array[]) => box("traf", cat(...kids));

/** ftyp, a fragmented moov (mvhd `mvhdMs` at 1000/s, track 1 at `timescale` with empty stts, `mvexKids`), then each moof + mdat. */
export function fragmentedFile(o: { mvhdMs?: number; timescale?: number; mvexKids: Uint8Array[]; moofs?: Uint8Array[] }): Uint8Array {
  const track = trak({ tkhd: tkhd(0, 0, 1), mdhd: mdhd(0, o.timescale ?? 1000, 0), stts: stts([]) });
  const moov = box("moov", cat(mvhd(0, 1000, o.mvhdMs ?? 0), track, mvex(...o.mvexKids)));
  return cat(ftyp(), moov, ...(o.moofs ?? []).flatMap((m) => [m, box("mdat", new Uint8Array(64))]));
}
