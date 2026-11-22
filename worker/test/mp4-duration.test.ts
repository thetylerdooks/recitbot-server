import { describe, expect, it } from "vitest";
import { MAX_MOOV_BYTES, mp4DurationSeconds } from "../src/mp4-duration";
import { box, cat, edts, fragmentedFile, ftyp, mdhd, mehd, moof, moovOf, mvhd, stts, tfhd, tkhd, traf, trak, trex, trun } from "./mp4-fixture";

/** A read callback over `bytes` that records every request. */
function reader(bytes: Uint8Array) {
  const reads: { offset: number; length: number }[] = [];
  const read = async (offset: number, length: number) => {
    reads.push({ offset, length });
    return bytes.slice(offset, offset + length);
  };
  return { read, reads };
}

const seconds = async (bytes: Uint8Array) => mp4DurationSeconds(reader(bytes).read, bytes.length);
const mdat = (n = 64) => box("mdat", new Uint8Array(n));
/** A track of `ms` at timescale 1000 in every header. */
const track = (ms: number) => trak({ tkhd: tkhd(0, ms), mdhd: mdhd(0, 1000, ms), stts: stts([[1, ms]]) });

describe("mp4DurationSeconds", () => {
  it("reads mvhd v0 and v1 and tracks with their own timescales", async () => {
    expect(await seconds(cat(ftyp(), moovOf(400), mdat()))).toBe(400);
    const v1 = box("moov", cat(mvhd(1, 600, 600n * 1800n), trak({ tkhd: tkhd(1, 600n * 1800n), mdhd: mdhd(1, 90000, 90000n * 1800n), stts: stts([[54000, 3000]]) })));
    expect(await seconds(cat(ftyp(), v1))).toBe(1800);
    const audio = box("moov", cat(mvhd(0, 1000, 500), trak({ mdhd: mdhd(0, 44100, 22050), stts: stts([[22050, 1]]) })));
    expect(await seconds(cat(ftyp(), audio))).toBe(0.5);
  });

  it("the longest of mvhd, tkhd, edit list, mdhd and the stts samples counts: a short mvhd can't hide long tracks", async () => {
    const short = (t: Uint8Array) => cat(ftyp(), box("moov", cat(mvhd(0, 1000, 1000), t)), mdat());
    // mvhd 1 s, track says 1 s everywhere but its samples run 3600 s.
    expect(await seconds(short(trak({ tkhd: tkhd(0, 1000), mdhd: mdhd(0, 1000, 1000), stts: stts([[3600, 1000]]) })))).toBe(3600);
    // mdhd 3600 s in its own timescale.
    expect(await seconds(short(trak({ tkhd: tkhd(0, 1000), mdhd: mdhd(0, 90000, 90000 * 3600), stts: stts([[1, 1]]) })))).toBe(3600);
    // tkhd 64-bit duration.
    expect(await seconds(short(trak({ tkhd: tkhd(1, 3_600_000n), mdhd: mdhd(0, 1000, 1000), stts: stts([[1, 1000]]) })))).toBe(3600);
    // An edit list that plays 1 s of media 3600 times.
    const edits = Array.from({ length: 3600 }, () => 1000);
    expect(await seconds(short(trak({ tkhd: tkhd(0, 1000), mdhd: mdhd(0, 1000, 1000), stts: stts([[1, 1000]]), extra: [edts(edits)] })))).toBe(3600);
    // A second, longer track.
    expect(await seconds(cat(ftyp(), box("moov", cat(mvhd(0, 1000, 1000), track(1000), track(900_000)))))).toBe(900);
  });

  it("mvhd duration 0 with real samples is the samples' length, not 0", async () => {
    const zero = box("moov", cat(mvhd(0, 1000, 0), trak({ tkhd: tkhd(0, 0), mdhd: mdhd(0, 1000, 0), stts: stts([[400, 1000]]) })));
    expect(await seconds(cat(ftyp(), zero, mdat()))).toBe(400);
  });

  it("a top-level moof or mfra without moov/mvex is unmeasurable; moov/mvex with no fragments is its mvhd and tracks", async () => {
    const mvex = box("mvex", cat(box("mehd", new Uint8Array(8)), box("trex", new Uint8Array(24))));
    expect(await seconds(cat(ftyp(), box("moov", cat(mvhd(0, 1000, 1000), track(1000), mvex)), mdat()))).toBe(1);
    expect(await seconds(cat(ftyp(), moovOf(1), box("moof", new Uint8Array(16)), mdat()))).toBeNull();
    expect(await seconds(cat(ftyp(), moovOf(1), mdat(), box("mfra", new Uint8Array(16))))).toBeNull();
  });

  describe("fragmented MP4 (moov/mvex + moofs)", () => {
    /** `n` samples of `d` each, in one trun. */
    const run = (n: number, d: number) => trun(Array.from({ length: n }, () => d));

    it("mvhd 0: the mehd fragment duration counts", async () => {
      expect(await seconds(fragmentedFile({ mvexKids: [mehd(400_000), trex(1)] }))).toBe(400);
    });

    it("mvhd 0, no mehd: trun sample durations summed across moofs, in the track's timescale", async () => {
      const moofs = [moof(traf(tfhd(1), run(100, 90000))), moof(traf(tfhd(1), run(300, 90000)))];
      expect(await seconds(fragmentedFile({ timescale: 90000, mvexKids: [trex(1)], moofs }))).toBe(400);
    });

    it("a trun without per-sample durations takes the tfhd default, else the trex default", async () => {
      const tf = [moof(traf(tfhd(1, 2000), trun({ count: 100 }))), moof(traf(tfhd(1, 2000), trun({ count: 100 })))];
      expect(await seconds(fragmentedFile({ mvexKids: [trex(1, 5)], moofs: tf }))).toBe(400);
      const tr = [moof(traf(tfhd(1), trun({ count: 200 }))), moof(traf(tfhd(1), trun({ count: 200 })))];
      expect(await seconds(fragmentedFile({ mvexKids: [trex(1, 1000)], moofs: tr }))).toBe(400);
    });

    it("the longest counts: a short mvhd or mehd can't hide long fragments", async () => {
      const moofs = [moof(traf(tfhd(1), run(400, 1000)))];
      expect(await seconds(fragmentedFile({ mvhdMs: 1000, mvexKids: [mehd(1000), trex(1)], moofs }))).toBe(400);
    });

    it("under the limit is measured as such", async () => {
      expect(await seconds(fragmentedFile({ mvexKids: [trex(1)], moofs: [moof(traf(tfhd(1), run(200, 1000)))] }))).toBe(200);
    });

    it("undeterminable is null: nothing but zeros, samples with no duration anywhere, a traf for an unknown track, a malformed trun", async () => {
      expect(await seconds(fragmentedFile({ mvexKids: [trex(1)] }))).toBeNull();
      expect(await seconds(fragmentedFile({ mvexKids: [mehd(0), trex(1)], moofs: [moof(traf(tfhd(1), run(10, 0)))] }))).toBeNull();
      expect(await seconds(fragmentedFile({ mvexKids: [trex(1)], moofs: [moof(traf(tfhd(1), trun({ count: 400 })))] }))).toBeNull();
      expect(await seconds(fragmentedFile({ mvexKids: [trex(1, 1000)], moofs: [moof(traf(tfhd(2), run(400, 1000)))] }))).toBeNull();
      const short = box("trun", new Uint8Array([0, 0, 1, 0, 0, 0, 0, 9, 0, 0, 0, 1]));
      expect(await seconds(fragmentedFile({ mvexKids: [trex(1)], moofs: [moof(traf(tfhd(1), short))] }))).toBeNull();
    });
  });

  it("finds moov after a large mdat: small header reads, then one read of moov", async () => {
    // A 3 GB mdat (header only): the reader serves the header bytes and the moov past the mdat's declared end.
    const mdatSize = 3 * 1024 ** 3;
    const head = cat(ftyp(), (() => {
      const h = new Uint8Array(16);
      const v = new DataView(h.buffer);
      v.setUint32(0, 1);
      h.set(new TextEncoder().encode("mdat"), 4);
      v.setBigUint64(8, BigInt(mdatSize));
      return h;
    })());
    const tail = moovOf(400);
    const moovAt = head.length - 16 + mdatSize;
    const size = moovAt + tail.length;
    const reads: { offset: number; length: number }[] = [];
    const read = async (offset: number, length: number) => {
      reads.push({ offset, length });
      if (offset >= moovAt) return tail.slice(offset - moovAt, offset - moovAt + length);
      return head.slice(offset, offset + length);
    };
    expect(await mp4DurationSeconds(read, size)).toBe(400);
    // ftyp, mdat (8 + largesize 8), moov header, moov body.
    expect(reads.map((r) => r.length)).toEqual([8, 8, 8, 8, tail.length - 8]);
  });

  it("refuses a moov over MAX_MOOV_BYTES without reading it", async () => {
    const hdr = new Uint8Array(8);
    new DataView(hdr.buffer).setUint32(0, MAX_MOOV_BYTES + 9);
    hdr.set(new TextEncoder().encode("moov"), 4);
    const f = ftyp();
    const size = f.length + MAX_MOOV_BYTES + 9;
    const reads: number[] = [];
    const read = async (offset: number, length: number) => {
      reads.push(length);
      return offset === 0 ? f.slice(0, length) : offset === f.length ? hdr.slice(0, length) : new Uint8Array(0);
    };
    expect(await mp4DurationSeconds(read, size)).toBeNull();
    expect(Math.max(...reads)).toBe(8);
  });

  it("handles a largesize (size == 1) moov and a size-0 last box", async () => {
    const body = cat(mvhd(0, 1000, 12_000), track(12_000));
    expect(await seconds(cat(ftyp(), box("moov", body, true)))).toBe(12);
    const last = moovOf(7);
    new DataView(last.buffer).setUint32(0, 0);
    expect(await seconds(cat(ftyp(), last))).toBe(7);
  });

  it("returns null for truncated, garbage, or nonsense headers", async () => {
    const good = cat(ftyp(), moovOf(5));
    expect(await seconds(good)).toBe(5);
    expect(await seconds(good.slice(0, good.length - 50))).toBeNull(); // moov runs past the end
    expect(await seconds(cat(good, new Uint8Array(3)))).toBeNull(); // trailing bytes that aren't a box
    expect(await seconds(new Uint8Array(4096).map((_, i) => (i * 37) % 256))).toBeNull();
    expect(await seconds(new Uint8Array(0))).toBeNull();
    expect(await seconds(cat(ftyp(), mdat()))).toBeNull(); // no moov
    expect(await seconds(cat(ftyp(), moovOf(1), moovOf(1)))).toBeNull(); // two moovs
    expect(await seconds(cat(ftyp(), box("moov", track(5000))))).toBeNull(); // no mvhd
    expect(await seconds(cat(ftyp(), box("moov", mvhd(0, 1000, 5000))))).toBeNull(); // no tracks
    expect(await seconds(cat(ftyp(), box("moov", cat(mvhd(0, 0, 5_000), track(5000)))))).toBeNull(); // timescale 0
    expect(await seconds(cat(ftyp(), box("moov", cat(mvhd(0, 1000, 0xffffffff), track(5000)))))).toBeNull(); // unknown duration
    expect(await seconds(cat(ftyp(), box("moov", cat(mvhd(1, 1000, 0xffffffffffffffffn), track(5000)))))).toBeNull();
    expect(await seconds(cat(ftyp(), box("moov", cat(box("mvhd", new Uint8Array(12)), track(5000)))))).toBeNull(); // short mvhd
    // A track without stts, or with an mdhd timescale of 0, or an stts count past its box.
    expect(await seconds(cat(ftyp(), box("moov", cat(mvhd(0, 1000, 1000), box("trak", box("mdia", mdhd(0, 1000, 1000)))))))).toBeNull();
    expect(await seconds(cat(ftyp(), box("moov", cat(mvhd(0, 1000, 1000), trak({ mdhd: mdhd(0, 0, 1000), stts: stts([[1, 1]]) })))))).toBeNull();
    const lying = stts([[1, 1]]);
    new DataView(lying.buffer).setUint32(12, 1000);
    expect(await seconds(cat(ftyp(), box("moov", cat(mvhd(0, 1000, 1000), trak({ mdhd: mdhd(0, 1000, 1000), stts: lying })))))).toBeNull();
    const tiny = cat(ftyp(), moovOf(5));
    new DataView(tiny.buffer).setUint32(0, 4); // box smaller than its header
    expect(await seconds(tiny)).toBeNull();
  });

  it("gives up after 64 top-level boxes and when the reader comes back short", async () => {
    const many = cat(...Array.from({ length: 70 }, () => box("free", new Uint8Array(0))), moovOf(5));
    const r = reader(many);
    expect(await mp4DurationSeconds(r.read, many.length)).toBeNull();
    expect(r.reads.length).toBeLessThanOrEqual(64);
    const good = cat(ftyp(), moovOf(5));
    expect(await mp4DurationSeconds(async () => new Uint8Array(0), good.length)).toBeNull();
  });
});
