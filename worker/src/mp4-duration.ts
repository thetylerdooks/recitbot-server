// An MP4's length from its moov box, through small ranged reads for the top-level boxes (moov may sit after a large
// mdat) and one bounded read of moov itself; a fragmented MP4 also gets one bounded read per moof.

/** Returns `length` bytes at `offset` (fewer = the read failed). */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

/** Top-level boxes walked (each a header read of 8 or 16 bytes). */
const MAX_HOPS = 64;
/**
 * Largest moov read in one piece. The recorders' 30-minute moov (stts/stsz/stco/stss for ~54000 variable-rate frames
 * plus audio) is around 1-2 MiB.
 */
export const MAX_MOOV_BYTES = 16 * 1024 * 1024;

type Box = { type: string; body: number; end: number };

/** Box header at `off` inside [.., end) of `v`: 32-bit size, 64-bit largesize (size 1) or to-the-end (size 0). */
function boxIn(v: DataView, off: number, end: number): Box | null {
  if (off + 8 > end) return null;
  const type = String.fromCharCode(v.getUint8(off + 4), v.getUint8(off + 5), v.getUint8(off + 6), v.getUint8(off + 7));
  let len = v.getUint32(off);
  let hdr = 8;
  if (len === 1) {
    if (off + 16 > end) return null;
    len = Number(v.getBigUint64(off + 8));
    hdr = 16;
  } else if (len === 0) {
    len = end - off;
  }
  if (len < hdr || off + len > end) return null;
  return { type, body: off + hdr, end: off + len };
}

/** Children of [from, end); null when any child doesn't fit. */
function children(v: DataView, from: number, end: number): Box[] | null {
  const out: Box[] = [];
  for (let off = from; off < end; ) {
    const b = boxIn(v, off, end);
    if (!b) return null;
    out.push(b);
    off = b.end;
  }
  return out;
}

const only = (boxes: Box[], type: string): Box | null | undefined => {
  const m = boxes.filter((b) => b.type === type);
  return m.length === 1 ? m[0] : m.length === 0 ? undefined : null;
};

const U32_UNKNOWN = 0xffffffff;
const U64_UNKNOWN = 0xffffffffffffffffn;

/** A full box's (version, flags) header, then `v0`/`v1` byte layouts: [timescale offset | -1, duration offset, duration width]. */
function header(v: DataView, b: Box, v0: [number, number], v1: [number, number]): { version: number; ts: number | null; dur: bigint } | null {
  if (b.end - b.body < 4) return null;
  const version = v.getUint8(b.body);
  if (version > 1) return null;
  const [tsAt, durAt] = version === 1 ? v1 : v0;
  const width = version === 1 ? 8 : 4;
  if (b.body + durAt + width > b.end || (tsAt >= 0 && b.body + tsAt + 4 > b.end)) return null;
  const dur = version === 1 ? v.getBigUint64(b.body + durAt) : BigInt(v.getUint32(b.body + durAt));
  if (dur === (version === 1 ? U64_UNKNOWN : BigInt(U32_UNKNOWN))) return null;
  return { version, ts: tsAt >= 0 ? v.getUint32(b.body + tsAt) : null, dur };
}

/**
 * Seconds of one trak: the longest of tkhd duration and the edit list total (movie timescale), the mdhd duration and
 * the sum of the stts sample deltas (media timescale). null when it has no mdhd or stts or any of them is malformed.
 */
function trakSeconds(v: DataView, trak: Box, movieTs: number): number | null {
  const kids = children(v, trak.body, trak.end);
  if (!kids) return null;
  let best = 0;
  const tkhd = only(kids, "tkhd");
  if (tkhd === null) return null;
  if (tkhd) {
    // v0: version/flags, creation, modification, track id, reserved, duration; v1: 64-bit times and duration.
    const h = header(v, tkhd, [-1, 20], [-1, 28]);
    if (!h) return null;
    best = Math.max(best, Number(h.dur) / movieTs);
  }
  const edts = only(kids, "edts");
  if (edts === null) return null;
  if (edts) {
    const ek = children(v, edts.body, edts.end);
    const elst = ek && only(ek, "elst");
    if (!ek || elst === null) return null;
    if (elst) {
      if (elst.end - elst.body < 8) return null;
      const version = v.getUint8(elst.body);
      const n = v.getUint32(elst.body + 4);
      const entry = version === 1 ? 20 : 12;
      if (version > 1 || elst.body + 8 + n * entry > elst.end) return null;
      let sum = 0n;
      for (let i = 0, at = elst.body + 8; i < n; i++, at += entry) {
        const d = version === 1 ? v.getBigUint64(at) : BigInt(v.getUint32(at));
        if (d === (version === 1 ? U64_UNKNOWN : BigInt(U32_UNKNOWN))) return null;
        sum += d;
      }
      best = Math.max(best, Number(sum) / movieTs);
    }
  }
  const mk = (() => {
    const mdia = only(kids, "mdia");
    return mdia ? children(v, mdia.body, mdia.end) : null;
  })();
  const mdhd = mk && only(mk, "mdhd");
  if (!mdhd) return null;
  // v0: version/flags, creation, modification, timescale, duration; v1: 64-bit times and duration.
  const mh = header(v, mdhd, [12, 16], [20, 24]);
  if (!mh || !mh.ts) return null;
  best = Math.max(best, Number(mh.dur) / mh.ts);
  const minf = only(mk, "minf");
  const fk = minf && children(v, minf.body, minf.end);
  const stbl = fk && only(fk, "stbl");
  const sk = stbl && children(v, stbl.body, stbl.end);
  const stts = sk && only(sk, "stts");
  if (!stts || stts.end - stts.body < 8) return null;
  const n = v.getUint32(stts.body + 4);
  if (stts.body + 8 + n * 8 > stts.end) return null;
  let samples = 0n;
  for (let i = 0, at = stts.body + 8; i < n; i++, at += 8) samples += BigInt(v.getUint32(at)) * BigInt(v.getUint32(at + 4));
  return Math.max(best, Number(samples) / mh.ts);
}

/** A trak's track_ID (tkhd) and media timescale (mdhd); null when either is missing or malformed. */
function trakIdAndTimescale(v: DataView, trak: Box): { id: number; ts: number } | null {
  const kids = children(v, trak.body, trak.end);
  const tkhd = kids && only(kids, "tkhd");
  const mdia = kids && only(kids, "mdia");
  const mk = mdia && children(v, mdia.body, mdia.end);
  const mdhd = mk && only(mk, "mdhd");
  if (!tkhd || !mdhd || tkhd.end - tkhd.body < 4) return null;
  // track_ID follows creation and modification times: 32-bit in v0, 64-bit in v1.
  const idAt = tkhd.body + (v.getUint8(tkhd.body) === 1 ? 20 : 12);
  if (idAt + 4 > tkhd.end) return null;
  const mh = header(v, mdhd, [12, 16], [20, 24]);
  return mh && mh.ts ? { id: v.getUint32(idAt), ts: mh.ts } : null;
}

/** trex default_sample_duration by track_ID; null when a trex is malformed or a track has two. */
function trexDefaults(v: DataView, mvex: Box[]): Map<number, number> | null {
  const out = new Map<number, number>();
  for (const b of mvex) {
    if (b.type !== "trex") continue;
    // version/flags, track_ID, default_sample_description_index, default_sample_duration, size, flags.
    if (b.end - b.body < 24) return null;
    const id = v.getUint32(b.body + 4);
    if (out.has(id)) return null;
    out.set(id, v.getUint32(b.body + 12));
  }
  return out;
}

/** tfhd: track_ID and its default_sample_duration (flag 0x8), if any. */
function tfhd(v: DataView, b: Box): { id: number; dflt: number | null } | null {
  if (b.end - b.body < 8) return null;
  const flags = v.getUint32(b.body) & 0xffffff;
  const at = b.body + 8 + (flags & 0x1 ? 8 : 0) + (flags & 0x2 ? 4 : 0);
  if (!(flags & 0x8)) return { id: v.getUint32(b.body + 4), dflt: null };
  return at + 4 > b.end ? null : { id: v.getUint32(b.body + 4), dflt: v.getUint32(at) };
}

/** A trun's total sample duration (per-sample durations, flag 0x100, else `dflt` per sample); null when unknowable. */
function trunDuration(v: DataView, b: Box, dflt: number | null): number | null {
  if (b.end - b.body < 8) return null;
  const flags = v.getUint32(b.body) & 0xffffff;
  const n = v.getUint32(b.body + 4);
  let at = b.body + 8 + (flags & 0x1 ? 4 : 0) + (flags & 0x4 ? 4 : 0);
  // Per sample: duration (0x100), size (0x200), flags (0x400), composition offset (0x800), 4 bytes each.
  const per = [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length * 4;
  if (at + n * per > b.end) return null;
  if (!(flags & 0x100)) return n === 0 ? 0 : dflt === null ? null : n * dflt;
  let sum = 0;
  for (let i = 0; i < n; i++, at += per) sum += v.getUint32(at);
  return sum;
}

/**
 * Seconds of the MP4 of `size` bytes: the longest of the mvhd duration and every track's own lengths (trakSeconds), so
 * a short mvhd in front of long tracks doesn't pass. A fragmented file (moov/mvex) also counts the mehd fragment
 * duration and, per track, the sum of its trun sample durations across every moof (tfhd, then trex, default duration
 * when a trun has none) in that track's timescale; it can't be measured when all of that comes to 0. null = can't be
 * measured: top-level boxes that don't tile the file within MAX_HOPS, no moov or more than one, a moov over
 * MAX_MOOV_BYTES, moof or mfra without mvex, moofs over MAX_MOOV_BYTES in all, a traf for a track moov doesn't have,
 * trun samples with no duration anywhere, no mvhd, no tracks, a timescale of 0, an unknown duration, or any malformed
 * box on the way.
 */
export async function mp4DurationSeconds(read: ReadRange, size: number): Promise<number | null> {
  const readExact = async (offset: number, length: number) => {
    const b = await read(offset, length);
    return b.length >= length ? new DataView(b.buffer, b.byteOffset, length) : null;
  };

  // 1. The top level, header by header, must reach exactly `size`.
  let moov: { off: number; body: number; end: number } | null = null;
  const moofs: { body: number; end: number }[] = [];
  let mfra = false;
  let off = 0;
  for (let hops = 0; off < size; hops++) {
    if (hops >= MAX_HOPS || off + 8 > size) return null;
    const h = await readExact(off, 8);
    if (!h) return null;
    const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    let len = h.getUint32(0);
    let hdr = 8;
    if (len === 1) {
      if (off + 16 > size) return null;
      const l = await readExact(off + 8, 8);
      if (!l) return null;
      len = Number(l.getBigUint64(0));
      hdr = 16;
    } else if (len === 0) {
      len = size - off;
    }
    if (len < hdr || off + len > size) return null;
    if (type === "moof") moofs.push({ body: off + hdr, end: off + len });
    if (type === "mfra") mfra = true;
    if (type === "moov") {
      if (moov) return null;
      moov = { off, body: off + hdr, end: off + len };
    }
    off += len;
  }
  if (!moov || moov.end - moov.body > MAX_MOOV_BYTES) return null;

  // 2. moov in one read, parsed in memory.
  const v = await readExact(moov.body, moov.end - moov.body);
  if (!v) return null;
  const kids = children(v, 0, v.byteLength);
  if (!kids) return null;
  const mvex = only(kids, "mvex");
  if (mvex === null || (!mvex && (moofs.length || mfra))) return null;
  const mvhd = only(kids, "mvhd");
  if (!mvhd) return null;
  const mh = header(v, mvhd, [12, 16], [20, 24]);
  if (!mh || !mh.ts) return null;
  const traks = kids.filter((b) => b.type === "trak");
  if (traks.length === 0) return null;
  let best = Number(mh.dur) / mh.ts;
  for (const t of traks) {
    const s = trakSeconds(v, t, mh.ts);
    if (s === null) return null;
    best = Math.max(best, s);
  }
  if (!mvex) return best;

  // 3. Fragmented: mehd, then every moof's trafs summed per track.
  const xk = children(v, mvex.body, mvex.end);
  const mehd = xk && only(xk, "mehd");
  const trex = xk && trexDefaults(v, xk);
  if (!xk || mehd === null || !trex) return null;
  if (mehd) {
    const h = header(v, mehd, [-1, 4], [-1, 4]);
    if (!h) return null;
    best = Math.max(best, Number(h.dur) / mh.ts);
  }
  const tracks = new Map<number, { ts: number; sum: number }>();
  for (const t of traks) {
    const info = trakIdAndTimescale(v, t);
    if (!info || tracks.has(info.id)) return null;
    tracks.set(info.id, { ts: info.ts, sum: 0 });
  }
  if (moofs.reduce((n, m) => n + m.end - m.body, 0) > MAX_MOOV_BYTES) return null;
  for (const m of moofs) {
    const mv = await readExact(m.body, m.end - m.body);
    const mk = mv && children(mv, 0, mv.byteLength);
    if (!mv || !mk) return null;
    for (const traf of mk.filter((b) => b.type === "traf")) {
      const tk = children(mv, traf.body, traf.end);
      const th = tk && only(tk, "tfhd");
      const fh = th && tfhd(mv, th);
      const track = fh && tracks.get(fh.id);
      if (!tk || !fh || !track) return null;
      for (const trun of tk.filter((b) => b.type === "trun")) {
        const d = trunDuration(mv, trun, fh.dflt ?? trex.get(fh.id) ?? null);
        if (d === null) return null;
        track.sum += d;
      }
    }
  }
  for (const t of tracks.values()) best = Math.max(best, t.sum / t.ts);
  return best > 0 ? best : null;
}
