/*
 * Waveform maths for the SAMPLE jobs (Owner's Manual p.259–271) and TRACK SET | SETUP loop
 * lengths (p.238–239). Plain Float32Array channels so it runs (and is tested) outside a browser.
 */
import type { LoopNote } from './model.ts';

/** Nearest zero crossing to `frame`, searching outward (first in `dir`, if given). */
export function zeroCross(ch: Float32Array, frame: number, dir: -1 | 0 | 1 = 0, window = 4096): number {
  const n = ch.length;
  frame = Math.max(0, Math.min(n, Math.round(frame)));
  const isCross = (i: number) => i <= 0 || i >= n || ch[i] === 0 || (ch[i - 1] < 0) !== (ch[i] < 0);
  if (isCross(frame)) return frame;
  for (let d = 1; d <= window; d++) {
    const order = dir < 0 ? [frame - d, frame + d] : [frame + d, frame - d];
    for (const i of order) if (i >= 0 && i <= n && isCross(i)) return i;
  }
  return frame;
}

/** Everything before `start` and from `end` on is dropped. */
export function trim(chs: Float32Array[], start: number, end: number): Float32Array[] {
  return chs.map((c) => c.slice(start, end));
}

export function reverse(chs: Float32Array[]): Float32Array[] {
  return chs.map((c) => c.slice().reverse());
}

/** NORMALIZE: peak lands at `rate`% of full scale; anything above clips, as on the unit. */
export function normalize(chs: Float32Array[], rate: number): Float32Array[] {
  let peak = 0;
  for (const c of chs) for (const x of c) peak = Math.max(peak, Math.abs(x));
  if (peak === 0) return chs.map((c) => c.slice());
  const g = rate / 100 / peak;
  return chs.map((c) => c.map((x) => Math.max(-1, Math.min(1, x * g))));
}

/** BIT CONVERT 16 → 8 bits. */
export function toEightBit(chs: Float32Array[]): Float32Array[] {
  return chs.map((c) => c.map((x) => Math.round(x * 127) / 127));
}

export type MonoMode = 'L' | 'R' | 'L+R' | 'L-R';
export const MONO_MODES: MonoMode[] = ['L', 'R', 'L+R', 'L-R'];

/** STEREO TO MONO. L+R is mixed 3 dB down; L-R cancels the centre (p.270). */
export function toMono([l, r]: Float32Array[], mode: MonoMode): Float32Array[] {
  const out = new Float32Array(l.length);
  const k = Math.SQRT1_2;
  for (let i = 0; i < out.length; i++) {
    out[i] = mode === 'L' ? l[i] : mode === 'R' ? r[i] : mode === 'L+R' ? (l[i] + r[i]) * k : l[i] - r[i];
  }
  return [out];
}

/** Target rates FREQ. CONVERT offers for a sample recorded at `rate` (p.267). */
export function lowerRates(rate: number): number[] {
  if (rate === 44100) return [22050, 11025];
  if (rate === 22050) return [11025];
  if (rate === 48000) return [24000];
  if (rate === 32000) return [16000];
  return [];
}

/**
 * LOOP-track LOOP LENGTH range, in beats: any length whose implied tempo (the tempo that plays
 * the span at its own speed) stays within 40–299.9 BPM (p.238).
 */
export function loopLengthRange(spanSec: number, bpmMin: number, bpmMax: number): { min: number; max: number } | null {
  if (spanSec <= 0) return null;
  const min = Math.max(1, Math.ceil((bpmMin * spanSec) / 60 - 1e-9));
  const max = Math.floor((bpmMax * spanSec) / 60 + 1e-9);
  return min <= max ? { min, max } : null;
}

/** Tempo that plays a `beats`-long loop of `spanSec` at the sample's own speed. */
export const impliedBpm = (spanSec: number, beats: number) => (60 * beats) / spanSec;

/** COMPOSED LOOP tracks can't be shortened past the beat of their last note-on (p.239). */
export function composedMinLength(notes: LoopNote[], ppq: number): number {
  if (!notes.length) return 1;
  return Math.floor(Math.max(...notes.map((n) => n.tick)) / ppq) + 1;
}
