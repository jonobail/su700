/*
 * SU700 data model (Owner's Manual ch. 3, 8 and 10).
 *
 * 42 tracks per song: 40 sample tracks in 4 banks of 10, then AUDIO IN and MASTER.
 * Within a bank, pads 1–2 are LOOP, 3–6 COMPOSED LOOP and 7–10 FREE, giving
 * 8 LOOP, 16 COMPOSED LOOP and 16 FREE tracks.
 */

export const BANKS = 4;
export const PADS_PER_BANK = 10;
export const AUDIO_IN = BANKS * PADS_PER_BANK; // 40
export const MASTER = AUDIO_IN + 1; // 41
export const TRACK_COUNT = MASTER + 1;
export const SONG_COUNT = 20;
export const SCENE_COUNT = 8;

/** Sequencer clock: ticks per quarter note. The song is always 4/4. */
export const PPQ = 96;
export const TICKS_PER_MEASURE = PPQ * 4;
export const BPM_MIN = 40;
export const BPM_MAX = 299.9;
export const MAX_MEASURES = 999;
/** The manual counts 480 clocks per beat (p.246); the sequencer runs at PPQ. */
export const CLOCKS_PER_TICK = 480 / PPQ;

// ---------------------------------------------------------------------------
// Meter map. EVENT EDIT | ADD MEASURES can insert 1/4–4/4 measures (p.253); `meters[m - 1]` is the
// beat count of measure m, and measures past the end of the list are 4/4.

export const measureTicks = (meters: readonly number[], m: number) => (meters[m - 1] ?? 4) * PPQ;

/** First tick of measure m (1-based). */
export function measureStart(meters: readonly number[], m: number): number {
  const listed = Math.min(m - 1, meters.length);
  let t = 0;
  for (let i = 0; i < listed; i++) t += meters[i] * PPQ;
  return t + Math.max(0, m - 1 - meters.length) * TICKS_PER_MEASURE;
}

export interface Location {
  measure: number;
  beat: number;
  /** Ticks into the beat. */
  tick: number;
}

/** Measure / beat / tick for a song position. The REC countdown (negative ticks) counts in 4/4. */
export function locate(meters: readonly number[], tick: number): Location {
  if (tick < 0) {
    const inBar = ((tick % TICKS_PER_MEASURE) + TICKS_PER_MEASURE) % TICKS_PER_MEASURE;
    return { measure: Math.floor(tick / TICKS_PER_MEASURE), beat: Math.floor(inBar / PPQ) + 1, tick: inBar % PPQ };
  }
  let m = 1;
  let start = 0;
  for (; m <= meters.length; m++) {
    const len = meters[m - 1] * PPQ;
    if (tick < start + len) break;
    start += len;
  }
  if (m > meters.length) {
    const extra = Math.floor((tick - start) / TICKS_PER_MEASURE);
    m += extra;
    start += extra * TICKS_PER_MEASURE;
  }
  const into = tick - start;
  return { measure: m, beat: Math.floor(into / PPQ) + 1, tick: into % PPQ };
}

/** Tick for a measure / beat / tick location. */
export const tickOf = (meters: readonly number[], l: Location) => measureStart(meters, l.measure) + (l.beat - 1) * PPQ + l.tick;

export type TrackKind = 'loop' | 'composed' | 'free' | 'audioIn' | 'master';
export type PadFn = 'play' | 'mute' | 'roll' | 'restart';
export type MainPadFn = PadFn | 'none';
export type FilterType = 'LPF' | 'BPF' | 'HPF' | 'BEF';
export type NoteAssign = 'multi' | 'single';
export type BpmTracking = 'slice' | 'pitch' | 'normal';
export type LfoWave = 'sawDown' | 'sawUp' | 'triangle' | 'square';

export function trackKind(index: number): TrackKind {
  if (index === AUDIO_IN) return 'audioIn';
  if (index === MASTER) return 'master';
  const pad = index % PADS_PER_BANK;
  return pad < 2 ? 'loop' : pad < 6 ? 'composed' : 'free';
}

export const isSampleTrack = (i: number) => i < AUDIO_IN;
export const bankOf = (i: number) => Math.floor(i / PADS_PER_BANK);

/** Track index for pad position 0..11 in the given bank. */
export function trackForPad(pad: number, bank: number): number {
  if (pad === 10) return AUDIO_IN;
  if (pad === 11) return MASTER;
  return bank * PADS_PER_BANK + pad;
}

/** Track name as the manual numbers them: LP01–08, CL01–16, FR01–16. */
export function trackLabel(i: number): string {
  const kind = trackKind(i);
  if (kind === 'audioIn') return 'AUDIO IN';
  if (kind === 'master') return 'MASTER';
  const bank = bankOf(i);
  const pad = i % PADS_PER_BANK;
  const [prefix, n] =
    kind === 'loop' ? ['LP', bank * 2 + pad + 1]
    : kind === 'composed' ? ['CL', bank * 4 + pad - 1]
    : ['FR', bank * 4 + pad - 5];
  return `${prefix}${String(n).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Note values used for QUANTIZE, groove RESOLUTION and ROLL rate.

export interface NoteValue { label: string; ticks: number }

export const NOTE_VALUES: NoteValue[] = [
  { label: '1/2', ticks: PPQ * 2 },
  { label: '1/3', ticks: (PPQ * 4) / 3 },
  { label: '1/4', ticks: PPQ },
  { label: '1/6', ticks: (PPQ * 2) / 3 },
  { label: '1/8', ticks: PPQ / 2 },
  { label: '1/12', ticks: PPQ / 3 },
  { label: '1/16', ticks: PPQ / 4 },
  { label: '1/24', ticks: PPQ / 6 },
  { label: '1/32', ticks: PPQ / 8 },
  { label: '1/48', ticks: PPQ / 12 },
  { label: '1/64', ticks: PPQ / 16 },
  { label: '1/96', ticks: PPQ / 24 },
];
export const note = (label: string) => NOTE_VALUES.find((n) => n.label === label)!;

/** Quantize choices; null = off (the power-on default). */
export const QUANTIZE_VALUES: (NoteValue | null)[] = [
  null, note('1/4'), note('1/6'), note('1/8'), note('1/12'), note('1/16'), note('1/24'), note('1/32'),
];
/** Groove resolution: quarter, eighth, sixteenth or 32nd (p.202). */
export const GROOVE_RES_VALUES: NoteValue[] = [note('1/4'), note('1/8'), note('1/16'), note('1/32')];
export const ROLL_VALUES: NoteValue[] = NOTE_VALUES.slice(2);

// ---------------------------------------------------------------------------
// Songs, tracks, events.

export interface Sample {
  buffer: AudioBuffer;
  name: string;
  /** Playback span in frames (SAMPLE | START POINT / END POINT). */
  start: number;
  end: number;
  rate: 44100 | 22050 | 11025;
  bits: 16 | 8;
}

export interface LoopNote { tick: number; gate: number; velocity: number }

export type SeqEvent =
  | { type: 'note'; tick: number; track: number; gate: number; velocity: number }
  | { type: 'knob'; tick: number; track: number; fn: string; value: number }
  | { type: 'mute'; tick: number; track: number; muted: boolean }
  | { type: 'restart'; tick: number; track: number }
  | { type: 'scene'; tick: number; track: number; scene: number }
  | { type: 'grooveRes'; tick: number; track: number; res: number }
  /** A held ROLL: overrides the track's other playback for `length` ticks. */
  | { type: 'roll'; tick: number; track: number; length: number; rate: number; velocity: number };

export interface Scene {
  knobs: Record<number, Record<string, number>>;
  mutes: Record<number, boolean>;
  grooveRes: Record<number, number>;
}

// ---------------------------------------------------------------------------

/**
 * Pick a loop length (beats) for a LOOP-track sample. Musically "round" lengths are preferred
 * when their implied tempo is near the song tempo; otherwise the closest implied tempo wins.
 * Returns null when no length gives a tempo within 40–299.9 (CANNOT FIND LOOP).
 */
export function fitLoop(seconds: number, bpm: number): number | null {
  const implied = (beats: number) => (60 * beats) / seconds;
  const valid = (beats: number) => implied(beats) >= BPM_MIN && implied(beats) <= BPM_MAX;
  const near = (beats: number) => Math.abs(Math.log(implied(beats) / bpm)) < Math.log(1.2);
  const preferred = [4, 8, 2, 16, 1, 32, 64, 128].find((b) => valid(b) && near(b));
  if (preferred) return preferred;
  let best: number | null = null;
  for (let beats = 1; beats <= 128; beats++) {
    if (valid(beats) && (best === null || Math.abs(implied(beats) - bpm) < Math.abs(implied(best) - bpm))) best = beats;
  }
  return best;
}
