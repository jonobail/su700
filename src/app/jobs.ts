import { WritableSignal, signal } from '@angular/core';
import { AudioEngine } from './audio/audio-engine';
import { ALL_KNOB_FNS, KNOB_FNS, KnobFn, supports } from './core/knob-functions';
import {
  BPM_MAX, BPM_MIN, BpmTracking, FilterType, LfoWave, MainPadFn, PADS_PER_BANK, PPQ, Sample,
  bankOf, isSampleTrack, trackLabel,
} from './core/model';
import { Sequencer } from './core/sequencer';
import { Track } from './core/song';
import {
  MONO_MODES, composedMinLength, impliedBpm, loopLengthRange, lowerRates, normalize, reverse, toEightBit, toMono,
  trim, zeroCross,
} from './core/wave';

/*
 * Jobs (Owner's Manual ch. 10): group selector → job selector → dial / cursor / OK / CANCEL.
 * TRACK SET, SAMPLE and SYSTEM | SETUP live here; SONG, TRACK EDIT and EVENT EDIT are `Job`
 * objects in jobs-song.ts and jobs-edit.ts.
 */

export type JobGroup = 'song' | 'trackSet' | 'trackEdit' | 'eventEdit' | 'sample' | 'resample' | 'disk' | 'system';

export const JOB_GROUP_LABEL: Record<JobGroup, string> = {
  song: 'SONG', trackSet: 'TRACK SET', trackEdit: 'TRACK EDIT', eventEdit: 'EVENT EDIT',
  sample: 'SAMPLE', resample: 'RESAMPLE', disk: 'DISK', system: 'SYSTEM',
};

type JobId =
  | 'main' | 'filterType' | 'noteAssign' | 'trackSetup'
  | 'startPoint' | 'endPoint' | 'process' | 'deleteSample'
  | 'systemSetup'
  | 'songName' | 'songCopy' | 'songInit' | 'mtcOffset'
  | 'trackCopy' | 'trackInit' | 'eventCopy' | 'eventInit'
  | 'locationValue' | 'noteClear' | 'eventClear' | 'measures';

/** Job selectors down the left of the grid, per group; null = not built yet. */
const JOB_ROWS: Partial<Record<JobGroup, (JobId | null)[]>> = {
  song: ['songName', 'songCopy', 'songInit', 'mtcOffset'],
  trackSet: ['main', 'filterType', 'noteAssign', 'trackSetup'],
  trackEdit: ['trackCopy', 'trackInit', 'eventCopy', 'eventInit'],
  eventEdit: ['locationValue', 'noteClear', 'eventClear', 'measures'],
  sample: ['startPoint', 'endPoint', 'process', 'deleteSample'],
  system: ['systemSetup', null, null, null],
};

/** A self-contained job. Created once, so its job-flow selections persist between openings (p.227). */
export interface Job {
  /** The job selector was pressed: back to the top level. */
  enter(): void;
  view(): JobView;
  /** Tracks the pads and bank selectors may select right now. */
  accepts?(i: number): boolean;
  /** Whether a pad press should also sound the track. */
  sounds?(i: number): boolean;
  dial?(step: number): void;
  cursor?(dir: -1 | 1): void;
  ok(): void;
  /** CANCEL: return true after moving back a level, false to leave the job. */
  back?(): boolean;
  knobFn?(fn: KnobFn): boolean;
  padFn?(fn: MainPadFn): boolean;
  scene?(n: number): boolean;
  /** REW (-1) / FF (+1). */
  transport?(dir: -1 | 1): void;
  /** The JOB-section key below the knob functions ([DEFAULT] in the manual). */
  defaultKey?(): void;
  nameKey?(key: 'insert' | 'delete'): void;
  /** Leaving without OK: drop anything not yet committed. */
  abort?(): void;
}

/** What a `Job` gets to work with. */
export interface JobContext {
  readonly host: JobHost;
  /** Move the selection to the nearest track the job accepts. */
  coerce(): void;
}

/** What the controller exposes to the jobs. */
export interface JobHost {
  readonly seq: Sequencer;
  readonly engine: AudioEngine;
  readonly lastTrack: WritableSignal<number>;
  readonly bank: WritableSignal<number>;
  readonly ribbonFn: WritableSignal<KnobFn | 'scratch'>;
  show(top: string, value: string, ms?: number): void;
  /** Back to the main screen (and 001:1). */
  leaveJob(): void;
}

export interface JobView {
  top: string;
  value: string;
  blinkTop?: boolean;
  blinkValue?: boolean;
  /** Flash only these characters [from, to) of a line (a cursor or a selected field). */
  topRange?: [number, number];
  valueRange?: [number, number];
  note?: string;
  /** Track under the meter brackets, or null for jobs that don't select one. */
  track: number | null;
}

// ---- TRACK SET ----
const FILTER_TYPES: FilterType[] = ['LPF', 'BPF', 'HPF', 'BEF'];
const LFO_WAVES: LfoWave[] = ['sawDown', 'sawUp', 'triangle', 'square'];
const LFO_LABEL: Record<LfoWave, string> = { sawDown: 'SAW DOWN', sawUp: 'SAW UP', triangle: 'TRIANGLE', square: 'SQUARE' };
const BPM_LABEL: Record<BpmTracking, string> = { slice: 'SLICE', normal: 'NORMAL', pitch: 'CHNG PITCH' };
const PAD_LABEL: Record<MainPadFn, string> = { play: 'PLAY', mute: 'ON/MUTE', roll: 'ROLL', restart: 'LOOPRST', none: 'NONE' };

/** Main pad functions each track type accepts (p.231). */
function mainPads(t: Track): MainPadFn[] {
  if (t.kind === 'audioIn') return ['none', 'mute'];
  if (t.kind === 'master') return ['none', 'mute', 'restart'];
  return ['play', 'mute', 'restart'];
}

/** TRACK SET | SETUP parameters (OUTPUT TO needs the AIEB1 board, so it never shows). */
type SetupParam = 'bpm' | 'length' | 'lfo';
const SETUP_PARAMS: SetupParam[] = ['bpm', 'length', 'lfo'];
const SETUP_LABEL: Record<SetupParam, [string, string]> = {
  bpm: ['BPM TRACKING', 'BPM TRK'], length: ['LOOP LENGTH', 'LOOP LN'], lfo: ['LFO WAVE', 'LFO WAV'],
};
const setupApplies = (p: SetupParam, t: Track) =>
  p === 'length' ? t.kind === 'loop' || t.kind === 'composed' : isSampleTrack(t.index);

// ---- SAMPLE | PROCESS ----
type ProcessJob = 'trim' | 'reverse' | 'normalize' | 'freq' | 'bit' | 'mono';
const PROCESS_JOBS: ProcessJob[] = ['trim', 'reverse', 'normalize', 'freq', 'bit', 'mono'];
const PROCESS_LABEL: Record<ProcessJob, string> = {
  trim: 'TRIM', reverse: 'REVERSE', normalize: 'NORMALIZE', freq: 'FREQ.CONVERT', bit: 'BIT CONVERT', mono: 'STEREO>MONO',
};

// ---- SYSTEM | SETUP ----
type SystemParam = 'metronome' | 'countdown' | 'recMode' | 'padSens' | 'audioIn' | 'ribbon';
const SYSTEM_PARAMS: SystemParam[] = ['metronome', 'countdown', 'recMode', 'padSens', 'audioIn', 'ribbon'];
const SYSTEM_LABEL: Record<SystemParam, string> = {
  metronome: 'METRONOME', countdown: 'COUNTDOWN', recMode: 'REC MODE', padSens: 'PAD SENS',
  audioIn: 'AUDIO IN', ribbon: 'RIBBON FUNC',
};
const CLICKS = ['off', 'rec', 'recPlay'] as const;
const CLICK_LABEL = { off: 'OFF', rec: 'REC', recPlay: 'REC/PLAY' };
const AUDIO_INS = ['LINE', 'MIC', 'OFF'] as const;
/** The 17 ribbon functions plus SCRATCH, in the manual's order (p.303). */
export const RIBBON_FNS: (KnobFn | 'scratch')[] = [
  'level', 'pan', 'pitch', 'attack', 'release', 'length', 'lfoSpeed', 'lfoAmp', 'lfoFilter', 'lfoPitch',
  'eqHiGain', 'eqLoGain', 'cutoff', 'resonance', 'effect1', 'effect2', 'effect3', 'scratch',
];

type ProcessStep = 'select' | 'confirm' | 'busy' | 'finished';

const cycle = <T>(list: readonly T[], cur: T, step: number) =>
  list[(((list.indexOf(cur) + step) % list.length) + list.length) % list.length];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class Jobs {
  readonly job = signal<JobId | null>(null);

  // Job-flow selections the unit remembers while powered (p.227).
  private readonly mainField = signal<'knob' | 'pad'>('knob');
  private readonly setupParam = signal<SetupParam>('bpm');
  private readonly setupLevel = signal<1 | 2>(1);
  /** SAMPLE START/END POINT: the dial moves the value by 10^stepExp frames. */
  private readonly stepExp = signal(2);
  private readonly processJob = signal<ProcessJob>('trim');
  private readonly processStep = signal<ProcessStep>('select');
  private readonly normalizeRate = signal(100);
  private readonly freqTarget = signal(0);
  private readonly monoMode = signal(2);
  /** Waveform before the process ran, for CANCEL on the FINISHED screen. */
  private original: { track: number; sample: Sample } | null = null;
  private readonly deleteSure = signal(false);
  private readonly systemParam = signal<SystemParam>('metronome');
  private readonly systemLevel = signal<1 | 2>(1);
  private readonly metronomePage = signal<0 | 1>(0);

  private readonly objects: Partial<Record<JobId, Job>>;

  constructor(private readonly host: JobHost, make: (ctx: JobContext) => Partial<Record<JobId, Job>>) {
    this.objects = make({ host, coerce: () => this.coerceTrack() });
  }

  /** The open job, when it's one of the `Job` objects. */
  private active(): Job | undefined {
    const id = this.job();
    return id ? this.objects[id] : undefined;
  }

  /** Job selector press. Returns false when the job isn't built yet. */
  open(group: JobGroup, row: number): boolean {
    const id = JOB_ROWS[group]?.[row] ?? null;
    if (!id) return false;
    this.abort();
    this.job.set(id);
    const obj = this.objects[id];
    if (obj) {
      obj.enter();
      this.coerceTrack();
      return true;
    }
    this.setupLevel.set(1);
    this.systemLevel.set(1);
    this.metronomePage.set(0);
    this.processStep.set('select');
    this.deleteSure.set(false);
    this.coerceTrack();
    if (id === 'process') this.host.show('PROCESS', '', 700);
    return true;
  }

  /** Leaving job mode (group change, OK/CANCEL out): an unconfirmed process result is dropped. */
  abort(): void {
    this.active()?.abort?.();
    if (this.original) {
      const t = this.track(this.original.track);
      t.sample.set(this.original.sample);
      this.host.engine.applyTrack(t);
      this.original = null;
    }
    this.job.set(null);
  }

  private track(i = this.host.lastTrack()): Track {
    return this.host.seq.track(i);
  }

  /** Tracks the current job can select. */
  private accepts(i: number): boolean {
    const obj = this.active();
    if (obj) return obj.accepts?.(i) ?? false;
    const t = this.track(i);
    switch (this.job()) {
      case 'main':
        return true;
      case 'filterType':
      case 'noteAssign':
      case 'startPoint':
      case 'endPoint':
      case 'deleteSample':
        return isSampleTrack(i);
      case 'process':
        return isSampleTrack(i) && (this.processStep() === 'select' || this.processStep() === 'confirm');
      case 'trackSetup':
        return this.setupLevel() === 1 ? isSampleTrack(i) : setupApplies(this.setupParam(), t);
      default:
        return false;
    }
  }

  /**
   * Keep the bracketed track valid for the job: if it isn't, move to the nearest track that is
   * (FILTER TYPE from AUDIO IN / MASTER lands on the bank's fourth FREE track, p.234).
   */
  private coerceTrack(): void {
    const cur = this.host.lastTrack();
    if (!this.job() || this.accepts(cur)) return;
    const bank = isSampleTrack(cur) ? bankOf(cur) : this.host.bank();
    const pad = isSampleTrack(cur) ? cur % PADS_PER_BANK : PADS_PER_BANK - 1;
    const order = Array.from({ length: 40 }, (_, i) => i).sort((a, b) =>
      (bankOf(a) !== bank ? 100 : 0) + Math.abs((a % PADS_PER_BANK) - pad) -
      ((bankOf(b) !== bank ? 100 : 0) + Math.abs((b % PADS_PER_BANK) - pad)) || b - a);
    const next = order.find((i) => this.accepts(i));
    if (next !== undefined) {
      this.host.lastTrack.set(next);
      this.host.bank.set(bankOf(next));
    }
  }

  /** Bank selector while a job is open. */
  bankChanged(): void {
    this.coerceTrack();
  }

  /** Pad press while a job is open. Returns true when the pad should sound (SAMPLE jobs). */
  pad(i: number): boolean {
    // FINISHED: audition the processed waveform before keeping it (p.265).
    if (this.job() === 'process' && this.processStep() === 'finished') return i === this.original?.track;
    if (!this.accepts(i)) return false;
    this.host.lastTrack.set(i);
    const obj = this.active();
    if (obj) return obj.sounds?.(i) ?? false;
    const id = this.job();
    return id === 'startPoint' || id === 'endPoint' || id === 'process' || id === 'deleteSample';
  }

  // =====================================================================
  // Controls

  dial(step: number): void {
    const obj = this.active();
    if (obj) return obj.dial?.(step);
    const t = this.track();
    switch (this.job()) {
      case 'main':
        if (this.mainField() === 'knob') {
          const fns = ALL_KNOB_FNS.filter((f) => supports(f, t.kind));
          t.mainKnob.set(cycle(fns, t.mainKnob(), step));
        } else {
          t.mainPad.set(cycle(mainPads(t), t.mainPad(), step));
        }
        return;
      case 'filterType':
        t.filterType.set(cycle(FILTER_TYPES, t.filterType(), step));
        this.host.engine.applyTrack(t);
        return;
      case 'noteAssign':
        t.noteAssign.set(t.noteAssign() === 'multi' ? 'single' : 'multi');
        return;
      case 'trackSetup':
        if (this.setupLevel() === 1) this.setupParam.set(cycle(SETUP_PARAMS, this.setupParam(), step));
        else this.setupDial(t, step);
        return;
      case 'startPoint':
      case 'endPoint':
        this.pointDial(t, step);
        return;
      case 'process':
        this.processDial(t, step);
        return;
      case 'systemSetup':
        if (this.systemLevel() === 1) this.systemParam.set(cycle(SYSTEM_PARAMS, this.systemParam(), step));
        else this.systemDial(step);
        return;
    }
  }

  cursor(dir: -1 | 1): void {
    const obj = this.active();
    if (obj) return obj.cursor?.(dir);
    switch (this.job()) {
      case 'main':
        this.mainField.set(this.mainField() === 'knob' ? 'pad' : 'knob');
        return;
      case 'startPoint':
      case 'endPoint':
        // ◀ widens the increment, ▶ narrows it (p.261).
        this.stepExp.set(clamp(this.stepExp() - dir, 0, 7));
        return;
      case 'systemSetup':
        if (this.systemLevel() === 2 && this.systemParam() === 'metronome') this.metronomePage.set(dir > 0 ? 1 : 0);
        return;
    }
  }

  ok(): void {
    const obj = this.active();
    if (obj) return obj.ok();
    const t = this.track();
    switch (this.job()) {
      case 'trackSetup':
        if (this.setupLevel() === 1) {
          this.setupLevel.set(2);
          this.coerceTrack();
        } else this.host.leaveJob();
        return;
      case 'process':
        return void this.processOk(t);
      case 'deleteSample':
        if (!t.sample()) return;
        if (!this.deleteSure()) return this.deleteSure.set(true);
        this.deleteSample(t);
        this.host.leaveJob();
        return;
      case 'systemSetup':
        if (this.systemLevel() === 1) {
          this.systemLevel.set(2);
          this.metronomePage.set(0);
        } else this.host.leaveJob();
        return;
      default:
        this.host.leaveJob();
    }
  }

  cancel(): void {
    const obj = this.active();
    if (obj) {
      if (!obj.back?.()) this.host.leaveJob();
      return;
    }
    switch (this.job()) {
      case 'trackSetup':
        if (this.setupLevel() === 2) return this.setupLevel.set(1);
        break;
      case 'process': {
        const s = this.processStep();
        if (s === 'busy') return;
        if (s === 'confirm') return this.processStep.set('select');
        break; // FINISHED: CANCEL keeps the original (abort restores it)
      }
      case 'deleteSample':
        if (this.deleteSure()) return this.deleteSure.set(false);
        break;
      case 'systemSetup':
        if (this.systemLevel() === 2) return this.systemLevel.set(1);
        break;
    }
    this.host.leaveJob();
  }

  /** Knob-function key while a job is open. Returns true if the job used it. */
  knobFn(fn: KnobFn): boolean {
    const obj = this.active();
    if (obj) return obj.knobFn?.(fn) ?? false;
    const t = this.track();
    if (this.job() === 'main') {
      if (supports(fn, t.kind)) t.mainKnob.set(fn);
      this.mainField.set('knob');
      return true;
    }
    if (this.job() === 'systemSetup' && this.systemLevel() === 2 && this.systemParam() === 'ribbon') {
      if (RIBBON_FNS.includes(fn)) this.host.ribbonFn.set(fn);
      return true;
    }
    return false;
  }

  /** Pad-function key while a job is open. */
  padFn(fn: MainPadFn): boolean {
    const obj = this.active();
    if (obj) return obj.padFn?.(fn) ?? false;
    if (this.job() !== 'main') return false;
    const t = this.track();
    if (mainPads(t).includes(fn)) t.mainPad.set(fn);
    this.mainField.set('pad');
    return true;
  }

  /** Scene key while a job is open. */
  scene(n: number): boolean {
    return this.active()?.scene?.(n) ?? false;
  }

  transport(dir: -1 | 1): void {
    this.active()?.transport?.(dir);
  }

  defaultKey(): void {
    this.active()?.defaultKey?.();
  }

  nameKey(key: 'insert' | 'delete'): void {
    this.active()?.nameKey?.(key);
  }

  // =====================================================================
  // TRACK SET | SETUP

  private setupDial(t: Track, step: number): void {
    switch (this.setupParam()) {
      case 'bpm':
        t.bpmTracking.set(cycle<BpmTracking>(t.kind === 'loop' ? ['slice', 'pitch'] : ['normal', 'pitch'], t.bpmTracking(), step));
        return;
      case 'lfo':
        t.lfoWave.set(cycle(LFO_WAVES, t.lfoWave(), step));
        return;
      case 'length': {
        const r = this.lengthRange(t);
        const len = clamp(t.loopLength() + step, r.min, r.max);
        t.loopLength.set(len);
        const span = spanSec(t);
        if (t.kind === 'loop' && span) t.refBpm.set(impliedBpm(span, len));
      }
    }
  }

  private lengthRange(t: Track): { min: number; max: number } {
    if (t.kind === 'composed') return { min: composedMinLength(t.loopNotes(), PPQ), max: 128 };
    const span = spanSec(t);
    return (span && loopLengthRange(span, BPM_MIN, BPM_MAX)) || { min: 1, max: 128 };
  }

  // =====================================================================
  // SAMPLE | START POINT / END POINT

  private pointDial(t: Track, step: number): void {
    const s = t.sample();
    if (!s) return;
    const ch = s.buffer.getChannelData(0);
    const move = step * Math.pow(10, this.stepExp());
    const dir = step > 0 ? 1 : -1;
    if (this.job() === 'startPoint') {
      const start = zeroCross(ch, clamp(s.start + move, 0, s.end - 1), dir);
      t.sample.set({ ...s, start: clamp(start, 0, s.end - 1) });
    } else {
      const end = zeroCross(ch, clamp(s.end + move, s.start + 1, s.buffer.length), dir);
      t.sample.set({ ...s, end: clamp(end, s.start + 1, s.buffer.length) });
    }
  }

  // =====================================================================
  // SAMPLE | PROCESS

  /** Why the selected sample can't take the process, if it can't. */
  private processBlock(t: Track): 'NO SAMPLE' | 'IMPOSSIBLE' | null {
    const s = t.sample();
    if (!s) return 'NO SAMPLE';
    const job = this.processJob();
    if (job === 'freq' && !lowerRates(s.rate).length) return 'IMPOSSIBLE';
    if (job === 'bit' && s.bits === 8) return 'IMPOSSIBLE';
    if (job === 'mono' && s.buffer.numberOfChannels < 2) return 'IMPOSSIBLE';
    return null;
  }

  private processDial(t: Track, step: number): void {
    if (this.processStep() === 'select') return this.processJob.set(cycle(PROCESS_JOBS, this.processJob(), step));
    if (this.processStep() !== 'confirm') return;
    switch (this.processJob()) {
      case 'normalize':
        return this.normalizeRate.set(clamp(this.normalizeRate() + step, 100, 200));
      case 'freq': {
        const n = lowerRates(t.sample()?.rate ?? 0).length;
        if (n) this.freqTarget.set(clamp(this.freqTarget() + step, 0, n - 1));
        return;
      }
      case 'mono':
        return this.monoMode.set(((this.monoMode() + step) % 4 + 4) % 4);
    }
  }

  private async processOk(t: Track): Promise<void> {
    switch (this.processStep()) {
      case 'select':
        if (!this.processBlock(t)) this.processStep.set('confirm');
        else this.host.show(PROCESS_LABEL[this.processJob()], this.processBlock(t)!);
        return;
      case 'confirm': {
        const s = t.sample();
        if (!s || this.processBlock(t)) return;
        this.processStep.set('busy');
        const result = await this.runProcess(s);
        if (this.job() !== 'process') return; // left the job meanwhile
        t.sample.set(result);
        this.host.engine.applyTrack(t);
        if (this.processJob() === 'trim') {
          this.host.leaveJob(); // TRIM finishes straight away (p.263)
          return;
        }
        this.original = { track: t.index, sample: s };
        this.processStep.set('finished');
        return;
      }
      case 'finished':
        this.original = null; // keep the new waveform
        this.host.leaveJob();
    }
  }

  private async runProcess(s: Sample): Promise<Sample> {
    const chs = channels(s.buffer);
    const rate = s.buffer.sampleRate;
    const len = s.buffer.length;
    switch (this.processJob()) {
      case 'trim':
        return { ...s, buffer: toBuffer(trim(chs, s.start, s.end), rate), start: 0, end: s.end - s.start };
      case 'reverse':
        return { ...s, buffer: toBuffer(reverse(chs), rate), start: len - s.end, end: len - s.start };
      case 'normalize':
        return { ...s, buffer: toBuffer(normalize(chs, this.normalizeRate()), rate) };
      case 'bit':
        return { ...s, bits: 8, buffer: toBuffer(toEightBit(chs), rate) };
      case 'mono':
        return { ...s, buffer: toBuffer(toMono(chs, MONO_MODES[this.monoMode()]), rate) };
      case 'freq': {
        const target = lowerRates(s.rate)[this.freqTarget()] as Sample['rate'];
        const ratio = target / s.rate;
        const buffer = await resample(s.buffer, rate * ratio);
        const k = buffer.length / len;
        return {
          ...s, rate: target, buffer,
          start: Math.round(s.start * k), end: Math.min(buffer.length, Math.round(s.end * k)),
        };
      }
    }
  }

  // =====================================================================
  // SAMPLE | DELETE: the sample and every sequence event on the track (p.271).

  private deleteSample(t: Track): void {
    const i = t.index;
    this.host.engine.killVoices(i);
    t.sample.set(null);
    t.loopNotes.set([]);
    this.host.seq.song().events.update((es) => es.filter((e) => e.track !== i));
    this.host.show('DELETED', trackLabel(i));
  }

  // =====================================================================
  // SYSTEM | SETUP

  private systemDial(step: number): void {
    const seq = this.host.seq;
    switch (this.systemParam()) {
      case 'metronome':
        if (this.metronomePage() === 0) seq.metronome.set(cycle(CLICKS, seq.metronome(), step));
        return; // OUT is fixed at STEREO without the AIEB1 board
      case 'countdown':
        return seq.countdown.set(clamp(seq.countdown() + step, 0, 2));
      case 'recMode':
        return seq.recMode.set(seq.recMode() === 'replace' ? 'overdub' : 'replace');
      case 'padSens':
        return seq.padSens.set(!seq.padSens());
      case 'audioIn':
        return this.host.engine.setAudioInSource(cycle(AUDIO_INS, this.host.engine.audioInSource(), step));
      case 'ribbon':
        return this.host.ribbonFn.set(cycle(RIBBON_FNS, this.host.ribbonFn(), step));
    }
  }

  // =====================================================================
  // Display

  view(): JobView {
    const obj = this.active();
    if (obj) return obj.view();
    const t = this.track();
    const label = trackLabel(t.index);
    const seq = this.host.seq;
    switch (this.job()) {
      case 'main':
        return {
          top: this.mainField() === 'knob' ? 'MAIN KNOB' : 'MAIN PAD',
          value: this.mainField() === 'knob' ? KNOB_FNS[t.mainKnob()].screen : PAD_LABEL[t.mainPad()],
          blinkValue: true, track: t.index,
        };
      case 'filterType':
        return { top: 'FILTER TYPE', value: `${label} ${t.filterType()}`, track: t.index };
      case 'noteAssign':
        return { top: 'NOTE ASSIGN', value: `${label} ${t.noteAssign().toUpperCase()}`, track: t.index };
      case 'trackSetup': {
        const p = this.setupParam();
        if (this.setupLevel() === 1) return { top: 'TRACK SETUP', value: SETUP_LABEL[p][0], blinkValue: true, track: t.index };
        const top = `${SETUP_LABEL[p][1]} ${label}`;
        if (p === 'bpm') return { top, value: BPM_LABEL[t.bpmTracking()], track: t.index };
        if (p === 'lfo') return { top, value: LFO_LABEL[t.lfoWave()], track: t.index };
        const span = spanSec(t);
        return {
          top, value: `LENGTH=${String(t.loopLength()).padStart(3, '0')}`, track: t.index,
          note: t.kind === 'loop' && span ? `BPM=${impliedBpm(span, t.loopLength()).toFixed(1)}` : '',
        };
      }
      case 'startPoint':
      case 'endPoint': {
        const s = t.sample();
        const start = this.job() === 'startPoint';
        if (!s) return { top: start ? 'START POINT' : 'END POINT', value: 'NO SAMPLE', track: t.index };
        return {
          top: `${start ? 'START' : 'END'} ${label}`,
          value: String(start ? s.start : s.end).padStart(8, '0'),
          valueRange: [0, 8 - this.stepExp()],
          note: `STEP=${Math.pow(10, this.stepExp())}`, track: t.index,
        };
      }
      case 'process':
        return this.processView(t);
      case 'deleteSample': {
        const s = t.sample();
        if (this.deleteSure()) return { top: 'ARE YOU', value: 'SURE?', blinkValue: true, track: t.index };
        return { top: 'DELETE', value: s ? s.name : 'NO SAMPLE', track: t.index };
      }
      case 'systemSetup': {
        const p = this.systemParam();
        if (this.systemLevel() === 1) return { top: 'SYSTEM SETUP', value: SYSTEM_LABEL[p], blinkValue: true, track: null };
        switch (p) {
          case 'metronome':
            return this.metronomePage() === 0
              ? { top: 'CLICK      >', value: CLICK_LABEL[seq.metronome()], track: null }
              : { top: '<        OUT', value: 'STEREO', track: null };
          case 'countdown':
            return { top: 'COUNTDOWN', value: String(seq.countdown()).padStart(2, '0'), track: null };
          case 'recMode':
            return { top: 'REC MODE', value: seq.recMode().toUpperCase(), track: null };
          case 'padSens':
            return { top: 'PAD SENS', value: seq.padSens() ? 'ON' : 'OFF', track: null };
          case 'audioIn':
            return { top: 'AUDIO IN', value: this.host.engine.audioInSource(), track: null };
          case 'ribbon': {
            const fn = this.host.ribbonFn();
            return { top: 'RIBBON FUNC', value: fn === 'scratch' ? 'SCRATCH' : KNOB_FNS[fn].screen, track: null };
          }
        }
      }
    }
    return { top: '', value: '', track: null };
  }

  private processView(t: Track): JobView {
    const job = this.processJob();
    const name = PROCESS_LABEL[job];
    const s = t.sample();
    switch (this.processStep()) {
      case 'select':
        return { top: 'PROCESS', value: name, blinkValue: true, track: t.index };
      case 'busy':
        return { top: 'PROCESSING', value: '', track: t.index };
      case 'finished':
        return { top: 'FINISHED', value: s?.name ?? '', note: 'OK=KEEP', track: t.index };
    }
    const block = this.processBlock(t);
    if (block || !s) return { top: name, value: block ?? 'NO SAMPLE', track: t.index };
    switch (job) {
      case 'normalize':
        return { top: `RATE=${this.normalizeRate()}%`, value: s.name, blinkTop: true, track: t.index };
      case 'freq': {
        const to = lowerRates(s.rate)[this.freqTarget()];
        return { top: `${Math.round(s.rate / 1000)}K>${Math.round(to / 1000)}K`, value: s.name, blinkTop: true, track: t.index };
      }
      case 'bit':
        return { top: '16BIT>8BIT', value: s.name, track: t.index };
      case 'mono':
        return { top: `CH=${MONO_MODES[this.monoMode()]}`, value: s.name, blinkTop: true, track: t.index };
      default:
        return { top: name, value: s.name, track: t.index };
    }
  }
}

// ---------------------------------------------------------------------------

/** Seconds between the sample's start and end points at its own speed. */
function spanSec(t: Track): number {
  const s = t.sample();
  return s ? (s.end - s.start) / s.buffer.sampleRate : 0;
}

function channels(b: AudioBuffer): Float32Array[] {
  return Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).slice());
}

function toBuffer(chs: Float32Array[], sampleRate: number): AudioBuffer {
  const b = new AudioBuffer({ numberOfChannels: chs.length, length: Math.max(1, chs[0].length), sampleRate });
  chs.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return b;
}

/** FREQ. CONVERT: band-limited resample through an offline context. */
async function resample(b: AudioBuffer, rate: number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(b.numberOfChannels, Math.max(1, Math.ceil(b.duration * rate)), rate);
  const src = ctx.createBufferSource();
  src.buffer = b;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

// ---------------------------------------------------------------------------
// SYSTEM | SETUP settings live in "nonvolatile memory" (p.298): kept in localStorage.

const SYSTEM_KEY = 'su700.system';

export interface SystemSettings {
  metronome: 'off' | 'rec' | 'recPlay';
  countdown: number;
  recMode: 'replace' | 'overdub';
  padSens: boolean;
  audioIn: 'LINE' | 'MIC' | 'OFF';
  ribbon: KnobFn | 'scratch';
}

export function loadSystem(host: JobHost): void {
  let saved: Partial<SystemSettings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(SYSTEM_KEY) ?? '{}');
  } catch {
    return;
  }
  const { seq, engine } = host;
  if (CLICKS.includes(saved.metronome!)) seq.metronome.set(saved.metronome!);
  if ([0, 1, 2].includes(saved.countdown!)) seq.countdown.set(saved.countdown!);
  if (saved.recMode === 'replace' || saved.recMode === 'overdub') seq.recMode.set(saved.recMode);
  if (typeof saved.padSens === 'boolean') seq.padSens.set(saved.padSens);
  if (AUDIO_INS.includes(saved.audioIn!)) engine.setAudioInSource(saved.audioIn!);
  if (RIBBON_FNS.includes(saved.ribbon!)) host.ribbonFn.set(saved.ribbon!);
}

export function saveSystem(host: JobHost): void {
  const s: SystemSettings = {
    metronome: host.seq.metronome(), countdown: host.seq.countdown(), recMode: host.seq.recMode(),
    padSens: host.seq.padSens(), audioIn: host.engine.audioInSource(), ribbon: host.ribbonFn(),
  };
  try {
    localStorage.setItem(SYSTEM_KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: settings last for this session only */
  }
}
