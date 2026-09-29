import { TrackKind } from './model';

/** The 22 knob functions (Owner's Manual ch. 8). */
export type KnobFn =
  | 'level' | 'pan' | 'pitch' | 'attack' | 'release' | 'length'
  | 'grvTiming' | 'grvVelocity' | 'grvGate'
  | 'lfoSpeed' | 'lfoAmp' | 'lfoFilter' | 'lfoPitch'
  | 'eqHiGain' | 'eqHiFreq' | 'eqLoGain' | 'eqLoFreq'
  | 'cutoff' | 'resonance'
  | 'effect1' | 'effect2' | 'effect3';

export interface KnobFnDef {
  id: KnobFn;
  /** Name as shown on the function screen. */
  screen: string;
  min: (kind: TrackKind) => number;
  max: number;
  def: (kind: TrackKind) => number;
  /** Track types that store this setting. */
  tracks: readonly TrackKind[];
  /** Recorded knob moves snap to the QUANTIZE grid (p.174). */
  quantized?: boolean;
  /** Knob uses the groove RESOLUTION setting (shown in the NOTE area). */
  grooveRes?: boolean;
  format: (v: number) => string;
}

const SAMPLE: TrackKind[] = ['loop', 'composed', 'free'];
const ALL: TrackKind[] = [...SAMPLE, 'audioIn', 'master'];
const c = (n: number) => () => n;

const pad3 = (v: number) => String(Math.abs(v)).padStart(3, '0');
const unsigned = (v: number) => pad3(v);
const signed3 = (v: number) => (v < 0 ? '-' : '+') + pad3(v);
const signed2 = (v: number) => (v < 0 ? '-' : '+') + String(Math.abs(v)).padStart(2, '0');

/** EQ HI FRQ: 500 Hz – 16 kHz in 31 steps. */
export const EQ_HI_FREQS = Array.from({ length: 31 }, (_, i) => 500 * Math.pow(32, i / 30));
/** EQ LO FRQ: 32 Hz – 2.0 kHz in 37 steps. */
export const EQ_LO_FREQS = Array.from({ length: 37 }, (_, i) => 32 * Math.pow(62.5, i / 36));

function hz(f: number): string {
  if (f < 1000) return String(Math.round(f));
  const k = f / 1000;
  return (k < 10 ? k.toFixed(1) : Math.round(k)) + 'K';
}

export const KNOB_FNS: Record<KnobFn, KnobFnDef> = {
  level: {
    id: 'level', screen: 'LEVEL', min: c(0), max: 127, tracks: ALL, quantized: true, format: unsigned,
    def: (k) => (k === 'audioIn' ? 77 : k === 'master' ? 127 : 100),
  },
  pan: {
    id: 'pan', screen: 'PAN', min: c(-64), max: 63, def: c(0), tracks: ALL, quantized: true,
    format: (v) => (v === 0 ? 'C' : v < 0 ? `L${String(-v).padStart(2, '0')}` : `R${String(v).padStart(2, '0')}`),
  },
  pitch: { id: 'pitch', screen: 'PITCH', min: c(-128), max: 127, def: c(0), tracks: SAMPLE, quantized: true, format: signed3 },
  attack: {
    id: 'attack', screen: 'ATTACK', min: c(0), max: 127, tracks: SAMPLE, format: unsigned,
    def: (k) => (k === 'loop' ? 24 : 0),
  },
  release: { id: 'release', screen: 'RELEASE', min: c(0), max: 127, def: c(45), tracks: SAMPLE, format: unsigned },
  length: { id: 'length', screen: 'SAMPLE LNGTH', min: c(-64), max: 63, def: c(0), tracks: ['loop'], format: signed2 },

  grvTiming: {
    id: 'grvTiming', screen: 'GRV TIMING', min: (k) => (k === 'loop' ? -100 : 0), max: 100, def: c(0),
    tracks: SAMPLE, grooveRes: true, format: signed3,
  },
  grvVelocity: { id: 'grvVelocity', screen: 'GRV VELOCITY', min: c(-100), max: 100, def: c(0), tracks: SAMPLE, grooveRes: true, format: signed3 },
  grvGate: { id: 'grvGate', screen: 'GRV GATETIM', min: c(-100), max: 100, def: c(0), tracks: SAMPLE, grooveRes: true, format: signed3 },

  lfoSpeed: { id: 'lfoSpeed', screen: 'LFO SPEED', min: c(0), max: 127, def: c(25), tracks: SAMPLE, format: unsigned },
  lfoAmp: { id: 'lfoAmp', screen: 'LFO AMP DPTH', min: c(0), max: 127, def: c(0), tracks: SAMPLE, format: unsigned },
  lfoFilter: { id: 'lfoFilter', screen: 'LFO FIL DPTH', min: c(0), max: 127, def: c(0), tracks: SAMPLE, format: unsigned },
  lfoPitch: { id: 'lfoPitch', screen: 'LFO PIT DPTH', min: c(0), max: 127, def: c(0), tracks: SAMPLE, format: unsigned },

  eqHiGain: { id: 'eqHiGain', screen: 'EQ HI GAIN', min: c(-64), max: 63, def: c(0), tracks: [...SAMPLE, 'master'], format: signed2 },
  eqHiFreq: {
    id: 'eqHiFreq', screen: 'EQ HI FRQ', min: c(0), max: 30, def: c(26), tracks: [...SAMPLE, 'master'],
    format: (v) => hz(EQ_HI_FREQS[v]),
  },
  eqLoGain: { id: 'eqLoGain', screen: 'EQ LO GAIN', min: c(-64), max: 63, def: c(0), tracks: [...SAMPLE, 'master'], format: signed2 },
  eqLoFreq: {
    id: 'eqLoFreq', screen: 'EQ LO FRQ', min: c(0), max: 36, def: c(8), tracks: [...SAMPLE, 'master'],
    format: (v) => hz(EQ_LO_FREQS[v]),
  },

  cutoff: { id: 'cutoff', screen: 'FILTR CUTOFF', min: c(0), max: 127, def: c(127), tracks: SAMPLE, quantized: true, format: unsigned },
  resonance: { id: 'resonance', screen: 'RESONANCE', min: c(0), max: 127, def: c(16), tracks: SAMPLE, format: unsigned },

  // Effect levels. Effect blocks aren't emulated yet, so these are stored but inaudible.
  effect1: { id: 'effect1', screen: 'EFFECT 1', min: c(0), max: 127, def: c(0), tracks: [...SAMPLE, 'audioIn'], format: unsigned },
  effect2: { id: 'effect2', screen: 'EFFECT 2', min: c(0), max: 127, def: c(0), tracks: [...SAMPLE, 'audioIn'], format: unsigned },
  effect3: { id: 'effect3', screen: 'EFFECT 3', min: c(0), max: 127, def: c(0), tracks: [...SAMPLE, 'audioIn'], format: unsigned },
};

export const ALL_KNOB_FNS = Object.keys(KNOB_FNS) as KnobFn[];

export function defaultKnobs(kind: TrackKind): Record<KnobFn, number> {
  return Object.fromEntries(ALL_KNOB_FNS.map((f) => [f, KNOB_FNS[f].def(kind)])) as Record<KnobFn, number>;
}

export const supports = (fn: KnobFn, kind: TrackKind) => KNOB_FNS[fn].tracks.includes(kind);

/** Knob position 0..1 for a stored value. */
export function toUnit(fn: KnobFn, kind: TrackKind, v: number): number {
  const d = KNOB_FNS[fn];
  const min = d.min(kind);
  return (v - min) / (d.max - min);
}

/** Stored (integer) value for a knob position 0..1. */
export function fromUnit(fn: KnobFn, kind: TrackKind, u: number): number {
  const d = KNOB_FNS[fn];
  const min = d.min(kind);
  return Math.round(min + Math.min(1, Math.max(0, u)) * (d.max - min));
}

export function clampKnob(fn: KnobFn, kind: TrackKind, v: number): number {
  const d = KNOB_FNS[fn];
  return Math.min(d.max, Math.max(d.min(kind), Math.round(v)));
}
