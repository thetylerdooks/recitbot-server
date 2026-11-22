import { describe, expect, it } from "vitest";
import { isSilent, keepSegment, wavLevel } from "../src/silence";

function wav(samples: Int16Array): ArrayBuffer {
  const b = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(b);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, s, true));
  return b;
}

describe("silence gate", () => {
  it("flags digital silence and faint hiss as silent", () => {
    expect(isSilent(wavLevel(wav(new Int16Array(16000))))).toBe(true);
    const hiss = new Int16Array(16000).map((_, i) => (i % 2 ? 8 : -8));
    expect(isSilent(wavLevel(wav(hiss)))).toBe(true);
  });
  it("does not flag speech-level audio", () => {
    const tone = new Int16Array(16000).map((_, i) => Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / 16000)));
    expect(isSilent(wavLevel(wav(tone)))).toBe(false);
  });
  it("treats unparseable audio as not silent", () => {
    expect(isSilent(wavLevel(new ArrayBuffer(10)))).toBe(false);
    expect(isSilent(wavLevel(new TextEncoder().encode("x".repeat(100)).buffer as ArrayBuffer))).toBe(false);
  });
  it("drops only low-confidence no-speech segments", () => {
    expect(keepSegment({ no_speech_prob: 0.9, avg_logprob: -1.5 })).toBe(false);
    expect(keepSegment({ no_speech_prob: 0.9, avg_logprob: -0.3 })).toBe(true);
    expect(keepSegment({})).toBe(true);
  });
});
