/*
 * Effects (Owner's Manual ch. 7, p.185–192; EFFECT knobs p.211; EFFECT SETUP p.214–219;
 * effect type and parameter lists p.333–344).
 *
 * Three effect blocks. Each holds one of 43 effect types, either a system effect (every track
 * but MASTER sends to it at its own EFFECT level) or an insertion effect (chosen tracks connect
 * to it; the MASTER track's EFFECT level sets the level for all of them). A track connects to
 * at most one insertion block. Block 1 can feed blocks 2 and 3, block 2 can feed block 3.
 */

import { AUDIO_IN, MASTER } from './model.ts';

export type EffectMode = 'sys' | 'ins';

export interface ParamDef {
  /** Name as shown on the parameter page. */
  label: string;
  min: number;
  max: number;
  def: number;
  step?: number;
  /** Named values; the stored value is the index. */
  options?: readonly string[];
  /** Display style for numeric values. */
  style?: 'dryWet' | 'erRev' | 'signed';
}

export interface EffectDef {
  /** Display name (p.333). */
  id: string;
  name: string;
  mode: EffectMode;
  /** Synchronised to BPM: takes a RESOLUTION setting (p.192). */
  sync: boolean;
  params: readonly ParamDef[];
}

// ---- parameter shorthands ----
const n = (label: string, min: number, max: number, def: number, step?: number): ParamDef => ({ label, min, max, def, step });
const s = (label: string, min: number, max: number, def: number, step?: number): ParamDef => ({ label, min, max, def, step, style: 'signed' });
const o = (label: string, options: readonly string[], def = 0): ParamDef => ({ label, min: 0, max: options.length - 1, def, options });
const DRY_WET = (def = 0): ParamDef => ({ label: 'DRY/WET', min: -63, max: 63, def, style: 'dryWet' });
const ER_REV = (def: number): ParamDef => ({ label: 'ER/REV', min: -63, max: 63, def, style: 'erRev' });
const LOWGAIN = (def = 0) => s('LOWGAIN', -12, 12, def);
const HI_GAIN = (def = 0) => s('HI GAIN', -12, 12, def);
const FBLEVEL = (def: number) => s('FBLEVEL', -63, 63, def);
const FBHIDMP = (def = 8) => n('FBHIDMP', 1, 10, def);
const LPF_FRQ = (def = 54) => n('LPF FRQ', 34, 60, def);
const HPF_FRQ = (def = 4) => n('HPF FRQ', 0, 52, def);
const WAVES = ['A', 'B', 'C', 'D'] as const;
const IN_MODES = ['MONO', 'STEREO'] as const;
const reverb = (time: number, er: number): ParamDef[] => [n('REVTIME', 0, 69, time), LPF_FRQ(50), HPF_FRQ(6), ER_REV(er), n('DIFFUSN', 0, 10, 10)];
const drive = (wet: number): ParamDef[] => [n('DRIVE', 0, 127, 70), LPF_FRQ(48), n('MIDFREQ', 14, 54, 34), n('OUT LVL', 0, 127, 60), DRY_WET(wet)];

/** Resolution values for synchronised effects (whole-note fractions); default and CLEAR value 1/2 (p.212, 215). */
export const EFFECT_RES = ['1/32', '1/24', '1/16', '1/12', '1/8', '1/6', '1/4', '1/3', '1/2', '1/1'] as const;
export const EFFECT_RES_DEFAULT = EFFECT_RES.indexOf('1/2');

/** The 43 effect types in the manual's order (p.333–334). */
export const EFFECTS: readonly EffectDef[] = [
  { id: 'TECHMOD', name: 'TECH MODULATION', mode: 'ins', sync: false, params: [
    n('MOD SPD', 0, 127, 70), n('MODDPTH', 0, 127, 100), n('MOD HPF', 0, 52, 10), s('MODGAIN', -12, 12, 0), DRY_WET(20)] },
  { id: 'AUTOSYN', name: 'AUTO SYNTH', mode: 'ins', sync: true, params: [
    n('MOD SPD', 0, 127, 64), o('MODWAVE', WAVES), n('MODDPTH', 0, 127, 100), s('MODOFST', -63, 63, 0), n('DLY LVL', 0, 127, 40)] },
  { id: 'SCRATCH', name: 'DIGITAL SCRATCH', mode: 'ins', sync: true, params: [
    n('INPUT', 0, 127, 90), n('DELAY', 0, 127, 30), HPF_FRQ(8), n('PANDPTH', 0, 127, 40), DRY_WET(30)] },
  { id: 'JUMP', name: 'JUMP', mode: 'ins', sync: false, params: [
    n('DEPTH', 0, 127, 100), o('TYPE', ['A', 'B', 'C']), o('JMPWAVE', WAVES),
    o('RESOLTN', ['1', '1/2', '1/4', '1/8', '1/16', '1/32', '1/64', '1/128', '1/256'], 4), DRY_WET(30)] },
  { id: 'PITCH1', name: 'PITCH CHANGE 1', mode: 'ins', sync: false, params: [
    s('PITCH', -24, 24, 12), s('FINE', -50, 50, 0), n('INITDLY', 0, 127, 0), FBLEVEL(0), DRY_WET(0)] },
  { id: 'PITCH2', name: 'PITCH CHANGE 2', mode: 'ins', sync: false, params: [
    s('PITCH', -50, 50, 10), s('FINE1', -50, 50, -10), n('INITDLY', 0, 127, 10), FBLEVEL(0), DRY_WET(0)] },
  { id: 'VCECNCL', name: 'VOICE CANCELER', mode: 'ins', sync: false, params: [n('LOW ADJ', 0, 26, 6), n('HI ADJ', 0, 26, 20)] },
  { id: 'AMBIENC', name: 'AMBIENCE', mode: 'ins', sync: false, params: [
    n('DLYTIME', 0, 127, 40), o('OUT_PHS', ['NORMAL', 'INVERSE'], 1), LOWGAIN(), HI_GAIN(), DRY_WET(0)] },
  { id: 'LO RESO', name: 'LOW RESOLUTION', mode: 'ins', sync: false, params: [
    n('MODDPTH', 0, 127, 20), n('MODOFST', 0, 127, 20), o('RESOLTN', ['1', '1/2', '1/4', '1/8', '1/16', '1/32', '1/64', '1/128', '1/256'], 5),
    o('PHASINV', ['OFF', 'WET', 'WET+DRY']), DRY_WET(40)] },
  { id: 'NOISY', name: 'NOISY', mode: 'ins', sync: false, params: [
    n('DRIVE', 0, 127, 80), n('MODDPTH', 0, 10, 4), LPF_FRQ(50), n('LPF Q', 10, 120, 20), DRY_WET(30)] },
  { id: 'ATKLOFI', name: 'ATTACK LOFI', mode: 'ins', sync: true, params: [
    n('SENSITV', 0, 127, 80), o('RESOLTN', ['0', '1/2', '1/4', '1/8', '1/16'], 2), n('PEAKFRQ', 14, 54, 36), LPF_FRQ(50), DRY_WET(30)] },
  { id: 'RADIO', name: 'RADIO', mode: 'ins', sync: false, params: [
    n('MOD LPF', 0, 52, 40), n('MODLPFQ', 10, 120, 40), HPF_FRQ(28), LPF_FRQ(44), DRY_WET(50)] },
  { id: 'TURNTBL', name: 'DIGITAL TURNTABLE', mode: 'ins', sync: false, params: [
    n('NOISLVL', 0, 127, 60), n('NS TONE', 0, 6, 3), n('NSLPF Q', 10, 120, 20), n('CLICK', 0, 127, 60), n('DRYNOIS', 0, 127, 100)] },
  { id: 'DIST', name: 'DISTORTION', mode: 'ins', sync: false, params: drive(30) },
  { id: 'OVERDRV', name: 'OVERDRIVE', mode: 'ins', sync: false, params: drive(30) },
  { id: 'AMPSIM', name: 'AMP SIMULATOR', mode: 'sys', sync: false, params: [
    n('DRIVE', 0, 127, 60), o('AMPTYPE', ['OFF', 'STACK', 'COMBO', 'TUBE'], 1), LPF_FRQ(46), n('EDGE', 0, 127, 64), n('OUT LVL', 0, 127, 70)] },
  { id: 'COMP', name: 'COMPRESSOR', mode: 'ins', sync: false, params: [
    n('THRSHLD', -48, -6, -24), n('ATTACK', 1, 40, 5), n('RELEASE', 10, 680, 120, 10),
    o('RATIO', ['1.0', '1.5', '2.0', '3.0', '5.0', '7.0', '10.0', '20.0'], 4), n('OUT LVL', 0, 127, 90)] },
  { id: 'COMP+DS', name: 'COMP+DIST', mode: 'ins', sync: false, params: [
    n('THRSHLD', -48, -6, -24), o('RATIO', ['1.0', '1.5', '2.0', '3.0', '5.0', '7.0', '10.0', '20.0'], 4), n('DRIVE', 0, 127, 70),
    LPF_FRQ(46), n('OUT LVL', 0, 127, 60)] },
  { id: 'TWAH+DS', name: 'TOUCH WAH+DIST', mode: 'ins', sync: false, params: [
    n('FRQOFST', 0, 127, 40), n('RESO', 10, 120, 50), n('DRIVE', 0, 127, 60), n('DR LPF', 34, 60, 48), DRY_WET(30)] },
  { id: 'TWAH+OD', name: 'TOUCH WAH+ODRV', mode: 'ins', sync: false, params: [
    n('FRQOFST', 0, 127, 40), n('RESO', 10, 120, 50), n('DRIVE', 0, 127, 60), n('DR LPF', 34, 60, 48), DRY_WET(30)] },
  { id: 'AWAH+DS', name: 'AUTO WAH+DIST', mode: 'ins', sync: true, params: [
    n('DEPTH', 0, 127, 90), n('FRQOFST', 0, 127, 40), n('RESO', 10, 120, 50), n('DRIVE', 0, 127, 60), DRY_WET(30)] },
  { id: 'AWAH+OD', name: 'AUTO WAH+OVD', mode: 'ins', sync: true, params: [
    n('DEPTH', 0, 127, 90), n('FRQOFST', 0, 127, 40), n('RESO', 10, 120, 50), n('DRIVE', 0, 127, 60), DRY_WET(30)] },
  { id: 'AUTOPAN', name: 'AUTO PAN', mode: 'ins', sync: true, params: [
    n('L/RDPTH', 0, 127, 110), n('F/RDPTH', 0, 127, 40), o('DIRECTN', ['L<>R', 'L>R', 'L<R', 'L@', 'R@', 'L/R']), LOWGAIN(), HI_GAIN()] },
  { id: 'TREMOLO', name: 'TREMOLO', mode: 'ins', sync: false, params: [
    n('LFOFREQ', 0, 127, 83), n('AMDEPTH', 0, 127, 100), LOWGAIN(), HI_GAIN(), o('INMODE', IN_MODES, 1)] },
  { id: 'TRM_BPM', name: 'TREMOLO(BPM)', mode: 'ins', sync: true, params: [
    n('AMDEPTH', 0, 127, 100), n('PMDEPTH', 0, 127, 0), s('PHASE', -180, 180, 0, 6), o('INMODE', IN_MODES, 1), LOWGAIN()] },
  { id: 'ROTARY', name: 'ROTARY SPEAKER', mode: 'ins', sync: false, params: [
    n('LFOFREQ', 0, 127, 70), n('DEPTH', 0, 127, 80), LOWGAIN(), HI_GAIN(), DRY_WET(40)] },
  { id: 'CHORUS', name: 'CHORUS', mode: 'ins', sync: true, params: [
    n('DEPTH', 0, 127, 60), LOWGAIN(), HI_GAIN(), DRY_WET(0), o('INMODE', IN_MODES, 1)] },
  { id: 'PHASER', name: 'PHASER', mode: 'ins', sync: true, params: [
    n('DEPTH', 0, 127, 90), n('PHSHIFT', 0, 127, 40), FBLEVEL(30), n('STAGE', 4, 12, 8, 2), DRY_WET(0)] },
  { id: 'FLANGER', name: 'FLANGER', mode: 'ins', sync: true, params: [
    n('DEPTH', 0, 127, 80), FBLEVEL(40), n('OFFSET', 0, 63, 10), s('PHASE', -180, 180, 90, 6), DRY_WET(0)] },
  { id: 'FLNGPAN', name: 'FLANGING PAN', mode: 'ins', sync: true, params: [
    n('FLN DLY', 0, 127, 20), n('PAN DLY', 0, 127, 50), s('PAN FB', -63, 63, 30), n('DLY LVL', 0, 127, 80), DRY_WET(0)] },
  { id: 'NOISDLY', name: 'NOISY MOD DELAY', mode: 'ins', sync: true, params: [
    n('MOD SPD', 0, 127, 40), n('MODDPTH', 0, 127, 50), o('MODWAVE', WAVES), FBLEVEL(30), DRY_WET(-10)] },
  { id: 'NOISAMB', name: 'NOISE AMBIENT', mode: 'ins', sync: true, params: [
    n('MOD SPD', 1, 127, 40), n('MODDPTH', 0, 127, 50), o('DLY LVL', WAVES, 2), n('AMDEPTH', 0, 127, 40), DRY_WET(-10)] },
  { id: 'FLOWPAN', name: 'FLOW PAN', mode: 'ins', sync: true, params: [
    n('PAN SPD', 0, 127, 50), n('DLY MIX', 0, 127, 64), FBLEVEL(30), FBHIDMP(), n('PRPANDP', 0, 127, 64)] },
  { id: '3DELAY', name: 'DELAY L,C,R', mode: 'sys', sync: false, params: [
    n('TIME L', 0, 127, 40), n('TIME R', 0, 127, 80), n('TIME C', 0, 127, 120), n('FB TIME', 0, 127, 120), FBLEVEL(20)] },
  { id: '2DELAY', name: 'DELAY L,R', mode: 'sys', sync: true, params: [FBLEVEL(30), FBHIDMP(), LOWGAIN(), HI_GAIN()] },
  { id: '1DELAY', name: '1DELAY', mode: 'sys', sync: true, params: [FBLEVEL(30), FBHIDMP(), LOWGAIN(), HI_GAIN()] },
  { id: 'X-DELAY', name: 'CROSS DELAY', mode: 'sys', sync: true, params: [
    FBLEVEL(30), FBHIDMP(), o('INSELECT', ['L', 'R', 'L/R'], 2), LOWGAIN(), HI_GAIN()] },
  // The manual reuses the 1DELAY labels for parameters 3–5 here; these are the names that match what they do.
  { id: 'DLY+PAN', name: 'DELAY+AUTO PAN', mode: 'sys', sync: true, params: [
    FBLEVEL(30), FBHIDMP(), n('PANDPTH', 0, 127, 90), s('MIDGAIN', -12, 12, 0), n('MIDFREQ', 4, 40, 28)] },
  { id: 'HALL', name: 'HALL', mode: 'sys', sync: false, params: reverb(23, 20) },
  { id: 'ROOM', name: 'ROOM', mode: 'sys', sync: false, params: reverb(7, -10) },
  { id: 'STAGE', name: 'STAGE', mode: 'sys', sync: false, params: reverb(15, 0) },
  { id: 'PLATE', name: 'PLATE', mode: 'sys', sync: false, params: reverb(13, 30) },
  { id: 'CANYON', name: 'CANYON', mode: 'sys', sync: false, params: reverb(47, 40) },
];

const BY_ID = new Map(EFFECTS.map((e) => [e.id, e]));
export const effectDef = (id: string): EffectDef => BY_ID.get(id) ?? EFFECTS[0];

// ---------------------------------------------------------------------------
// Block state

export interface EffectBlock {
  type: string;
  params: number[];
  /** Block output LEVEL (000–127, default 100) and PAN (L64–R63) (p.219). */
  level: number;
  pan: number;
  /** EF2 SEND (block 1 only) and EF3 SEND (blocks 1 and 2). */
  ef2: number;
  ef3: number;
  /** Index into EFFECT_RES; only meaningful for synchronised effects. */
  res: number;
  /** Tracks connected to an insertion effect. */
  connected: number[];
}

export type EffectSetup = [EffectBlock, EffectBlock, EffectBlock];

/** Factory assignments: AMPSIM, 1DELAY, HALL (p.215). */
export const DEFAULT_TYPES = ['AMPSIM', '1DELAY', 'HALL'] as const;

export function makeBlock(type: string): EffectBlock {
  return {
    type, params: effectDef(type).params.map((p) => p.def), level: 100, pan: 0, ef2: 0, ef3: 0,
    res: EFFECT_RES_DEFAULT, connected: [],
  };
}

export const defaultEffects = (): EffectSetup => DEFAULT_TYPES.map(makeBlock) as EffectSetup;

export const cloneEffects = (e: EffectSetup): EffectSetup =>
  e.map((b) => ({ ...b, params: [...b.params], connected: [...b.connected] })) as EffectSetup;

export const isInsertion = (b: EffectBlock) => effectDef(b.type).mode === 'ins';

/** Tracks that may connect to an insertion block: everything but MASTER. */
export const connectable = (track: number) => track >= 0 && track <= AUDIO_IN;

/**
 * SETUP dial: a new effect type for block `bi`. Parameters take the new type's defaults; a
 * track left connected to another insertion block is disconnected here (a track feeds only one).
 */
export function setType(setup: EffectSetup, bi: number, type: string): EffectSetup {
  const next = cloneEffects(setup);
  const keep = next[bi].connected;
  next[bi] = { ...makeBlock(type), level: next[bi].level, pan: next[bi].pan, ef2: next[bi].ef2, ef3: next[bi].ef3, res: next[bi].res };
  if (effectDef(type).mode === 'ins') {
    const taken = new Set(next.flatMap((b, j) => (j !== bi && isInsertion(b) ? b.connected : [])));
    next[bi].connected = keep.filter((t) => !taken.has(t));
  }
  return next;
}

/** Insertion block (other than `bi`) the track is already connected to, or -1. */
export function connectedElsewhere(setup: EffectSetup, bi: number, track: number): number {
  return setup.findIndex((b, j) => j !== bi && isInsertion(b) && b.connected.includes(track));
}

/** Toggle a track's connection to insertion block `bi`. `replace` moves it off any other block (REPLACE? → OK). */
export function toggleConnection(setup: EffectSetup, bi: number, track: number, replace = false): EffectSetup {
  if (!connectable(track) || !isInsertion(setup[bi])) return setup;
  const next = cloneEffects(setup);
  const b = next[bi];
  if (b.connected.includes(track)) {
    b.connected = b.connected.filter((t) => t !== track);
    return next;
  }
  const other = connectedElsewhere(next, bi, track);
  if (other >= 0) {
    if (!replace) return setup;
    next[other].connected = next[other].connected.filter((t) => t !== track);
  }
  b.connected = [...b.connected, track].sort((x, y) => x - y);
  return next;
}

// ---------------------------------------------------------------------------
// SETUP pages: effect type, then the effect's own parameters, LEVEL, PAN and the sends (p.219).

export type SetupPage =
  | { kind: 'type' }
  | { kind: 'param'; index: number }
  | { kind: 'level' } | { kind: 'pan' } | { kind: 'ef2' } | { kind: 'ef3' };

export function setupPages(bi: number, b: EffectBlock): SetupPage[] {
  const pages: SetupPage[] = [{ kind: 'type' }];
  effectDef(b.type).params.forEach((_, index) => pages.push({ kind: 'param', index }));
  pages.push({ kind: 'level' }, { kind: 'pan' });
  if (bi === 0) pages.push({ kind: 'ef2' });
  if (bi <= 1) pages.push({ kind: 'ef3' });
  return pages;
}

const pad3 = (v: number) => String(Math.abs(v)).padStart(3, '0');
const signed = (v: number) => (v < 0 ? '-' : '+') + String(Math.abs(v)).padStart(2, '0');
export const formatPan = (v: number) => (v === 0 ? 'C' : v < 0 ? `L${String(-v).padStart(2, '0')}` : `R${String(v).padStart(2, '0')}`);

/** Parameter value as shown on the setup screen. Numeric parameters show their raw value, as on the unit (p.218). */
export function formatParam(p: ParamDef, v: number): string {
  if (p.options) return p.options[v] ?? '';
  switch (p.style) {
    case 'dryWet': return v === 0 ? 'D=W' : v < 0 ? `D${-v}>W` : `D<W${v}`;
    case 'erRev': return v === 0 ? 'E=R' : v < 0 ? `E${-v}>R` : `E<R${v}`;
    case 'signed': return Math.abs(v) >= 100 ? (v < 0 ? '-' : '+') + pad3(v) : signed(v);
  }
  return v < 0 ? signed(v) : pad3(v);
}

export function stepParam(p: ParamDef, v: number, dir: number): number {
  return Math.min(p.max, Math.max(p.min, v + dir * (p.step ?? 1)));
}

/** Name and value shown for one setup page. */
export function pageView(bi: number, b: EffectBlock, page: SetupPage): { name: string; value: string } {
  switch (page.kind) {
    case 'type': return { name: b.type, value: isInsertion(b) ? 'INSERTION' : 'SYSTEM' };
    case 'param': {
      const p = effectDef(b.type).params[page.index];
      return { name: p.label, value: formatParam(p, b.params[page.index]) };
    }
    case 'level': return { name: 'LEVEL', value: pad3(b.level) };
    case 'pan': return { name: 'PAN', value: formatPan(b.pan) };
    case 'ef2': return { name: 'EF2SEND', value: pad3(b.ef2) };
    case 'ef3': return { name: 'EF3SEND', value: pad3(b.ef3) };
  }
}

/** Dial on a setup page. Returns the new setup (the type page goes through `setType`). */
export function dialPage(setup: EffectSetup, bi: number, page: SetupPage, dir: number): EffectSetup {
  const b = setup[bi];
  if (page.kind === 'type') {
    const i = EFFECTS.findIndex((e) => e.id === b.type);
    return setType(setup, bi, EFFECTS[Math.min(EFFECTS.length - 1, Math.max(0, i + dir))].id);
  }
  const next = cloneEffects(setup);
  const nb = next[bi];
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  switch (page.kind) {
    case 'param': {
      const p = effectDef(b.type).params[page.index];
      nb.params[page.index] = stepParam(p, nb.params[page.index], dir);
      break;
    }
    case 'level': nb.level = clamp(nb.level + dir, 0, 127); break;
    case 'pan': nb.pan = clamp(nb.pan + dir, -64, 63); break;
    case 'ef2': nb.ef2 = clamp(nb.ef2 + dir, 0, 127); break;
    case 'ef3': nb.ef3 = clamp(nb.ef3 + dir, 0, 127); break;
  }
  return next;
}

/** Whether a track's EFFECT n knob does anything (p.211): system → all but MASTER, insertion → MASTER only. */
export function effectKnobActive(b: EffectBlock, track: number): boolean {
  return isInsertion(b) ? track === MASTER : track !== MASTER;
}

/** Seconds per resolution step at a tempo (whole note = 4 beats). */
export function resSeconds(res: number, bpm: number): number {
  const [a, d] = EFFECT_RES[res].split('/').map(Number);
  return ((a / d) * 4 * 60) / bpm;
}

// ---------------------------------------------------------------------------
// Value tables shared with the audio side (Yamaha XG effect tables).

/** Frequency table for the 0–60 filter / EQ frequency parameters. */
export const EFFECT_FREQS = [
  20, 22, 25, 28, 32, 36, 40, 45, 50, 56, 63, 70, 80, 90, 100, 110, 125, 140, 160, 180, 200, 225, 250, 280, 315,
  355, 400, 450, 500, 560, 630, 700, 800, 900, 1000, 1100, 1200, 1400, 1600, 1800, 2000, 2200, 2500, 2800, 3200,
  3600, 4000, 4500, 5000, 5600, 6300, 7000, 8000, 9000, 10000, 11000, 12000, 14000, 16000, 18000, 20000,
];

/** REVTIME 0–69 → seconds: 0.3–5.0 in 0.1 s, 5.5–10 in 0.5 s, 11–20 in 1 s, then 25 and 30. */
export function reverbSeconds(v: number): number {
  if (v <= 47) return 0.3 + v * 0.1;
  if (v <= 57) return 5 + (v - 47) * 0.5;
  if (v <= 67) return 10 + (v - 57);
  return v === 68 ? 25 : 30;
}
