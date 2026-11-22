/**
 * Silence gate: Whisper invents text ("Thank you.") on silent audio, so measure the
 * mic WAV first and skip transcription when it is effectively silent.
 * Expects PCM16 WAV (what the recorder uploads); anything unparseable is treated as not silent.
 */
export interface Level {
  rmsDbfs: number;
  peakDbfs: number;
}

export const SILENCE_RMS_DBFS = -50;
export const SILENCE_PEAK_DBFS = -35;

export function wavLevel(buf: ArrayBuffer): Level | null {
  const v = new DataView(buf);
  if (buf.byteLength < 44) return null;
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let off = 12;
  let bits = 0;
  let fmt = 0;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = v.getUint16(body, true);
      bits = v.getUint16(body + 14, true);
    } else if (id === "data") {
      if (fmt !== 1 || bits !== 16) return null;
      const end = Math.min(buf.byteLength, body + size);
      let sum = 0;
      let peak = 0;
      let n = 0;
      for (let i = body; i + 1 < end; i += 2) {
        const s = v.getInt16(i, true) / 32768;
        sum += s * s;
        const a = Math.abs(s);
        if (a > peak) peak = a;
        n++;
      }
      if (n === 0) return { rmsDbfs: -Infinity, peakDbfs: -Infinity };
      const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
      return { rmsDbfs: db(Math.sqrt(sum / n)), peakDbfs: db(peak) };
    }
    off = body + size + (size % 2);
  }
  return null;
}

export interface WavInfo {
  channels: number;
  sampleRate: number;
  bits: number;
  byteRate: number;
  blockAlign: number;
  /** Offset of the PCM samples and their length as the header states it (callers clamp to the file). */
  dataOffset: number;
  dataSize: number;
}

/** Parses a PCM16 WAV header from the file's first bytes (fmt before data, as ffmpeg writes it). */
export function wavInfo(head: ArrayBuffer): WavInfo | null {
  const v = new DataView(head);
  if (head.byteLength < 44) return null;
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let off = 12;
  let fmt: Omit<WavInfo, "dataOffset" | "dataSize"> | null = null;
  while (off + 8 <= head.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt " && body + 16 <= head.byteLength) {
      if (v.getUint16(body, true) !== 1 || v.getUint16(body + 14, true) !== 16) return null;
      fmt = {
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        byteRate: v.getUint32(body + 8, true),
        blockAlign: v.getUint16(body + 12, true),
        bits: 16,
      };
    } else if (id === "data") {
      return fmt && fmt.byteRate > 0 && fmt.blockAlign > 0 ? { ...fmt, dataOffset: body, dataSize: size } : null;
    }
    off = body + size + (size % 2);
  }
  return null;
}

/** A standalone PCM16 WAV around `pcm` (one transcription window of a longer file). */
export function wavFile(info: WavInfo, pcm: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const put = (o: number, s: string) => out.set(new TextEncoder().encode(s), o);
  put(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  put(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, info.channels, true);
  v.setUint32(24, info.sampleRate, true);
  v.setUint32(28, info.byteRate, true);
  v.setUint16(32, info.blockAlign, true);
  v.setUint16(34, 16, true);
  put(36, "data");
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out.buffer;
}

export function isSilent(l: Level | null): boolean {
  return l !== null && l.rmsDbfs < SILENCE_RMS_DBFS && l.peakDbfs < SILENCE_PEAK_DBFS;
}

/** Whisper's own no-speech rule: drop a segment it flags as non-speech with low confidence. */
export function keepSegment(s: { no_speech_prob?: number; avg_logprob?: number }): boolean {
  const ns = typeof s.no_speech_prob === "number" ? s.no_speech_prob : 0;
  const lp = typeof s.avg_logprob === "number" ? s.avg_logprob : 0;
  return !(ns > 0.6 && lp < -1);
}
