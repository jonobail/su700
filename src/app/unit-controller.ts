import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AudioEngine } from './audio/audio-engine';
import {
  EFFECT_RES, EFFECT_RES_DEFAULT, EffectBlock, SetupPage, cloneEffects, connectable, connectedElsewhere, dialPage,
  effectDef, effectKnobActive, isInsertion, pageView, setupPages, toggleConnection,
} from './core/effects';
import { KNOB_FNS, KnobFn, defaultKnobs, fromUnit, supports, toUnit } from './core/knob-functions';
import {
  BPM_MAX, BPM_MIN, GROOVE_RES_VALUES, MASTER, PADS_PER_BANK, PPQ, PadFn, QUANTIZE_VALUES,
  ROLL_VALUES, SONG_COUNT, Sample, fitLoop, isSampleTrack, locate, note, trackForPad, trackLabel,
} from './core/model';
import { Sequencer } from './core/sequencer';
import { Track } from './core/song';
import { JOB_GROUP_LABEL, JobGroup, JobHost, Jobs, loadSystem, saveSystem } from './jobs';
import {
  EventClearJob, EventCopyJob, EventInitJob, LocationValueJob, MeasuresJob, NoteClearJob, TrackCopyJob, TrackInitJob,
} from './jobs-edit';
import { MtcOffsetJob, SongCopyJob, SongInitJob, SongNameJob } from './jobs-song';

export type Screen = 'main' | 'function' | 'job' | 'sampling' | 'effect';

/** EFFECT SETUP screens (p.214–219): CLEAR n waits for OK; SETUP n pages through the block. */
interface EffectScreen {
  mode: 'clear' | 'setup';
  block: number;
  page: number;
  /** Track waiting on REPLACE? (already connected to another insertion block). */
  replace: number | null;
}

const EFFECT_FNS: KnobFn[] = ['effect1', 'effect2', 'effect3'];
const effectIndex = (fn: KnobFn) => EFFECT_FNS.indexOf(fn);
export type Blink = 'measure' | 'bpm' | 'note' | null;

type SampleRate = 44100 | 22050 | 11025;
type ChannelMode = 'STEREO' | 'L+R' | 'MONO L' | 'MONO R';
const RATES: SampleRate[] = [44100, 22050, 11025];
const CHANNEL_MODES: ChannelMode[] = ['STEREO', 'L+R', 'MONO L', 'MONO R'];

interface SamplingState {
  step: 'select' | 'replace' | 'params' | 'recording' | 'cannotLoop' | 'wait';
  target: number;
  cursor: 0 | 1 | 2;
}

export interface MeterCell {
  /** 0..1 bar height; for bipolar functions 0.5 is centre. */
  value: number | null;
  bipolar: boolean;
  /** Brackets shown when the track is not muted. */
  bracket: boolean;
  selected: boolean;
  hasSample: boolean;
  /** Track holds sequence data (shown on track-selection job screens, p.244). */
  hasSeq?: boolean;
}

export interface DisplayModel {
  top: string;
  value: string;
  bank: number;
  rec: boolean;
  padFn: PadFn | null;
  meters: MeterCell[];
  input: [number, number] | null;
  clip: boolean;
  measure: string;
  bpm: string;
  note: string;
  blink: Blink;
  blinkTop: boolean;
  blinkValue: boolean;
  topRange?: [number, number];
  valueRange?: [number, number];
}

const HOLD_MS = 1500;

/**
 * Front-panel behaviour: screens, pads, knobs and buttons, translated into Sequencer /
 * AudioEngine calls following the SU700 Owner's Manual.
 */
@Injectable({ providedIn: 'root' })
export class UnitController implements JobHost {
  readonly engine = inject(AudioEngine);
  readonly seq = inject(Sequencer);

  readonly screen = signal<Screen>('main');
  readonly bank = signal(0);
  readonly knobFn = signal<KnobFn>('level');
  readonly padFn = signal<Exclude<PadFn, 'roll'>>('play');
  readonly rollHeld = signal(false);
  /** Whether a knob-function or pad-function button was pressed last (decides the NOTE area). */
  private lastFnKind: 'knob' | 'pad' = 'knob';
  readonly rollRate = signal(ROLL_VALUES.indexOf(note('1/16')));
  readonly lastTrack = signal(0);
  readonly blink = signal<Blink>(null);
  readonly sceneMarker = signal<'scene' | 'marker'>('scene');
  readonly held = signal<ReadonlySet<number>>(new Set());
  readonly jobGroup = signal<JobGroup | null>(null);
  readonly sampling = signal<SamplingState | null>(null);
  readonly fx = signal<EffectScreen | null>(null);
  readonly sampleRate = signal<SampleRate>(44100);
  readonly sampleBits = signal<16 | 8>(16);
  readonly sampleChannels = signal<ChannelMode>('STEREO');
  readonly inputLevels = signal<[number, number]>([0, 0]);
  readonly recordedSec = signal(0);

  // Buttons that act as modifiers while held.
  readonly knobResetHeld = signal(false);
  readonly noteDelHeld = signal(false);
  readonly initHeld = signal(false);
  readonly ribbonTrackHeld = signal(false);
  /** Pad position (0..11) the ribbon follows; sample pads follow the current bank. */
  readonly ribbonPad = signal(0);
  readonly ribbonFn = signal<KnobFn | 'scratch'>('scratch');

  private readonly flash = signal<{ top: string; value: string } | null>(null);
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSong = signal<number | null>(null);
  private tapBpm = signal<number | null>(null);
  private taps: number[] = [];
  private tapTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private noteDelStart = new Map<number, number>();
  private clipUntil = 0;
  private scratch: { track: number; pos: number; time: number } | null = null;

  readonly song = this.seq.song;
  readonly jobs = new Jobs(this, (ctx) => ({
    songName: new SongNameJob(ctx), songCopy: new SongCopyJob(ctx), songInit: new SongInitJob(ctx), mtcOffset: new MtcOffsetJob(ctx),
    trackCopy: new TrackCopyJob(ctx), trackInit: new TrackInitJob(ctx), eventCopy: new EventCopyJob(ctx), eventInit: new EventInitJob(ctx),
    locationValue: new LocationValueJob(ctx), noteClear: new NoteClearJob(ctx), eventClear: new EventClearJob(ctx),
    measures: new MeasuresJob(ctx),
  }));

  /** Tracks under the 12 knobs / pads for the current bank. */
  readonly padTracks = computed(() => Array.from({ length: 12 }, (_, p) => trackForPad(p, this.bank())));

  /** Knob function each knob currently controls. */
  private knobFnFor(track: Track): KnobFn {
    const fx = this.fx();
    if (this.screen() === 'effect' && fx) return EFFECT_FNS[fx.block];
    return this.screen() === 'function' ? this.knobFn() : track.mainKnob();
  }

  private block(i: number): EffectBlock {
    return this.song().effects()[i];
  }

  /** Whether a knob function does anything on a track right now. */
  private usable(fn: KnobFn, t: Track): boolean {
    if (!supports(fn, t.kind) || this.pitchLocked(t, fn)) return false;
    const e = effectIndex(fn);
    return e < 0 || effectKnobActive(this.block(e), t.index);
  }

  /** 0..1 knob positions for the 12 knobs. */
  readonly knobPositions = computed(() =>
    this.padTracks().map((i) => {
      const t = this.seq.track(i);
      const fn = this.knobFnFor(t);
      return this.usable(fn, t) ? toUnit(fn, t.kind, t.knobs()[fn]) : 0;
    }),
  );

  readonly display = computed<DisplayModel>(() => this.buildDisplay());

  constructor() {
    loadSystem(this);
    effect(() => saveSystem(this));
    const frame = () => {
      const s = this.sampling();
      if (s && (s.step === 'params' || s.step === 'recording')) {
        const peaks = this.engine.inputPeaks();
        this.inputLevels.set(peaks);
        if (peaks[0] >= 0.99 || peaks[1] >= 0.99) this.clipUntil = performance.now() + 800;
        if (s.step === 'recording') this.recordedSec.set(this.engine.recordedSeconds());
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // =====================================================================
  // Knobs

  turnKnob(pos: number, unit: number): void {
    if (this.screen() === 'job' || this.screen() === 'sampling') return;
    const i = this.padTracks()[pos];
    const t = this.seq.track(i);
    const fn = this.knobFnFor(t);
    this.lastTrack.set(i);
    if (!this.usable(fn, t)) return;
    this.seq.setKnob(i, fn, fromUnit(fn, t.kind, unit));
  }

  /** Double-click a knob: back to that function's default. */
  resetKnob(pos: number): void {
    const i = this.padTracks()[pos];
    const t = this.seq.track(i);
    const fn = this.knobFnFor(t);
    if (this.usable(fn, t)) this.seq.setKnob(i, fn, KNOB_FNS[fn].def(t.kind));
  }

  selectKnobFn(fn: KnobFn): void {
    if (this.screen() === 'sampling') return;
    this.leaveEffect(); // any other knob-function button cancels CLEAR / leaves SETUP (p.215)
    if (this.screen() === 'job') {
      this.jobs.knobFn(fn);
      return;
    }
    this.screen.set('function');
    this.knobFn.set(fn);
    this.lastFnKind = 'knob';
    if (this.blink() === 'note' && !this.noteContext()) this.blink.set(null);
  }

  // =====================================================================
  // Pads

  padDown(pos: number, velocity = 127): void {
    this.engine.resume();
    this.held.update((s) => new Set(s).add(pos));
    const i = this.padTracks()[pos];
    const t = this.seq.track(i);
    if (this.fx()?.replace != null) return; // REPLACE? waits for OK / CANCEL

    if (this.ribbonTrackHeld()) {
      this.ribbonPad.set(pos);
      return;
    }
    const s = this.sampling();
    if (s) {
      if (s.step === 'select' && isSampleTrack(i)) {
        this.sampling.set({ ...s, target: i });
        this.lastTrack.set(i);
      }
      return;
    }
    if (this.screen() === 'job') {
      if (this.jobs.pad(i)) this.seq.noteOn(i, velocity); // SAMPLE jobs: listen while editing
      return;
    }
    this.lastTrack.set(i);
    const fx = this.fx();
    if (this.screen() === 'effect' && fx) return this.effectPad(fx, i, velocity);

    if (this.knobResetHeld()) {
      if (this.seq.mode() === 'play' || this.seq.mode() === 'playStandby') {
        t.knobs.set(defaultKnobs(t.kind));
        this.engine.applyTrack(t);
        this.show('KNOB RESET', trackLabel(i));
      }
      return;
    }
    if (this.noteDelHeld() && this.seq.recording() && (t.kind === 'composed' || t.kind === 'free')) {
      this.noteDelStart.set(i, this.seq.tickAt(this.engine.now));
      return;
    }

    const fn = this.screen() === 'function' ? (this.rollHeld() ? 'roll' : this.padFn()) : t.mainPad();
    switch (fn) {
      case 'play':
        this.seq.noteOn(i, velocity);
        break;
      case 'mute':
        this.seq.toggleMute(i);
        break;
      case 'roll':
        this.seq.rollOn(i, ROLL_VALUES[this.rollRate()].ticks, velocity);
        break;
      case 'restart':
        this.seq.restartLoop(i);
        break;
    }
  }

  padUp(pos: number): void {
    this.held.update((s) => {
      const n = new Set(s);
      n.delete(pos);
      return n;
    });
    const i = this.padTracks()[pos];
    const delFrom = this.noteDelStart.get(i);
    if (delFrom !== undefined) {
      this.noteDelStart.delete(i);
      this.deleteNotes(i, delFrom, this.seq.tickAt(this.engine.now));
      return;
    }
    this.seq.noteOff(i);
    this.seq.rollOff(i);
  }

  selectPadFn(fn: Exclude<PadFn, 'roll'>): void {
    if (this.screen() === 'job') {
      this.jobs.padFn(fn);
      return;
    }
    if (this.screen() === 'sampling') return;
    this.leaveEffect();
    this.screen.set('function');
    this.padFn.set(fn);
    this.lastFnKind = 'pad';
  }

  /** ROLL works only while held; releasing returns to PLAY (p.167). */
  setRollHeld(down: boolean): void {
    if (this.screen() === 'job') {
      if (down) this.jobs.padFn('roll');
      return;
    }
    if (this.screen() === 'sampling') return;
    if (down) this.leaveEffect();
    this.rollHeld.set(down);
    if (down) this.screen.set('function');
    else this.padFn.set('play');
  }

  selectBank(b: number): void {
    this.bank.set(b);
    const s = this.sampling();
    if (s?.step === 'select') {
      const target = b * PADS_PER_BANK + (s.target % PADS_PER_BANK);
      this.sampling.set({ ...s, target });
      this.lastTrack.set(target);
    } else if (isSampleTrack(this.lastTrack())) {
      this.lastTrack.set(b * PADS_PER_BANK + (this.lastTrack() % PADS_PER_BANK));
    }
    if (this.screen() === 'job') this.jobs.bankChanged();
  }

  // =====================================================================
  // Display-area buttons, dial, OK / CANCEL, cursor

  pressBlink(which: Exclude<Blink, null>): void {
    if (this.screen() === 'sampling' || this.screen() === 'job' || this.screen() === 'effect') return;
    this.screen.set('function');
    this.blink.update((b) => (b === which ? null : which));
  }

  dial(step: number): void {
    const s = this.sampling();
    if (s) return this.samplingDial(s, step);
    if (this.screen() === 'job') return this.jobs.dial(step);
    const fx = this.fx();
    if (this.screen() === 'effect' && fx) return this.effectDial(fx, step);

    switch (this.blink()) {
      case 'measure':
        this.seq.nudge(step * 4);
        return;
      case 'bpm':
        this.seq.setBpm(this.seq.bpm + step);
        return;
      case 'note':
        this.noteDial(step);
        return;
    }
    if (this.screen() === 'main' && this.seq.mode() === 'playStandby') {
      const cur = this.pendingSong() ?? this.song().number - 1;
      this.pendingSong.set((cur + step + SONG_COUNT) % SONG_COUNT);
      return;
    }
    // Function screen: step the value on the last-touched track.
    const t = this.seq.track(this.lastTrack());
    const fn = this.knobFnFor(t);
    if (this.usable(fn, t)) this.seq.setKnob(t.index, fn, t.knobs()[fn] + step);
  }

  pressOk(): void {
    const s = this.sampling();
    if (s) return void this.samplingOk(s);
    if (this.tapBpm() !== null) {
      this.seq.setBpm(this.tapBpm()!);
      this.tapBpm.set(null);
      return;
    }
    if (this.pendingSong() !== null) {
      this.seq.selectSong(this.pendingSong()!);
      this.pendingSong.set(null);
      return;
    }
    if (this.screen() === 'job') {
      if (this.jobs.job()) this.jobs.ok();
      else this.leaveJob();
      return;
    }
    const fx = this.fx();
    if (this.screen() === 'effect' && fx) return this.effectOk(fx);
    this.toMain();
  }

  pressCancel(): void {
    const s = this.sampling();
    if (s) return void this.samplingCancel(s);
    this.pendingSong.set(null);
    if (this.screen() === 'job') {
      if (this.jobs.job()) this.jobs.cancel();
      else this.leaveJob();
      return;
    }
    const fx = this.fx();
    if (fx?.replace != null) {
      this.fx.set({ ...fx, replace: null }); // leave the track's connection as it was
      return;
    }
    this.leaveEffect();
    if (this.seq.mode() === 'recStandby') this.seq.pressStop();
    this.toMain();
  }

  pressCursor(dir: -1 | 1): void {
    if (this.screen() === 'job') return this.jobs.cursor(dir);
    const fx = this.fx();
    if (this.screen() === 'effect' && fx?.mode === 'setup' && fx.replace === null) {
      const pages = setupPages(fx.block, this.block(fx.block));
      this.fx.set({ ...fx, page: Math.min(pages.length - 1, Math.max(0, fx.page + dir)) });
      return;
    }
    const s = this.sampling();
    if (s?.step === 'params') this.sampling.set({ ...s, cursor: ((s.cursor + dir + 3) % 3) as 0 | 1 | 2 });
  }

  private toMain(): void {
    this.fx.set(null);
    this.screen.set('main');
    this.blink.set(null);
  }

  // =====================================================================
  // Jobs (group + job selector); the jobs themselves live in jobs.ts.

  pressJobGroup(g: JobGroup): void {
    if (this.sampling()) return;
    if (this.seq.mode() !== 'playStandby') {
      this.show('STOP SEQ', 'FIRST');
      return;
    }
    this.jobs.abort();
    this.fx.set(null);
    this.jobGroup.set(g);
    this.screen.set('job');
    this.blink.set(null);
  }

  /** JOB / NAME keys below the knob functions while a job is open. Returns false outside jobs. */
  pressJobKey(action: 'KNOB RESET' | 'NOTE DEL' | 'INSERT' | 'DELETE'): boolean {
    if (this.screen() !== 'job') return false;
    if (action === 'INSERT' || action === 'DELETE') this.jobs.nameKey(action === 'INSERT' ? 'insert' : 'delete');
    else this.jobs.defaultKey();
    return true;
  }

  /** Job selector (row of the grid) within the current group. */
  pressJob(row: number, label: string): void {
    const g = this.jobGroup();
    if (this.screen() !== 'job' || !g || !label) return;
    if (!this.jobs.open(g, row)) this.show(label, 'NOT YET');
  }

  leaveJob(): void {
    this.jobs.abort();
    this.jobGroup.set(null);
    this.toMain();
    this.seq.setPosition(0); // leaving job mode returns to 001:1 (p.146)
  }

  // =====================================================================
  // Transport

  pressTransport(id: 'rec' | 'top' | 'stop' | 'play'): void {
    if (this.sampling() || this.screen() === 'job') return;
    this.engine.resume();
    if (id === 'rec' && this.screen() === 'effect') this.toMain(); // SETUP / CLEAR are PLAY-only screens
    switch (id) {
      case 'rec':
        this.seq.pressRec();
        break;
      case 'top':
        this.seq.toTop();
        break;
      case 'stop':
        this.seq.pressStop();
        break;
      case 'play':
        if (this.seq.mode() === 'recStandby') this.screen.set('function'); // REC shows a function screen
        this.seq.pressPlay();
        break;
    }
  }

  /** FF / REW: hold to scan through the song. */
  scan(dir: -1 | 1, down: boolean): void {
    const key = `scan${dir}`;
    clearInterval(this.holdTimers.get(key));
    this.holdTimers.delete(key);
    if (this.screen() === 'job') {
      if (down) this.jobs.transport(dir); // LOCATION & VALUE steps through events
      return;
    }
    if (!down || this.sampling()) return;
    this.seq.nudge(dir);
    this.holdTimers.set(key, setInterval(() => this.seq.nudge(dir), 90));
  }

  pressUndo(): void {
    const r = this.seq.pressUndo();
    if (r) this.show(r, '');
  }

  // =====================================================================
  // Scenes / markers: tap to recall or jump, hold ~1.5 s to store.

  scenePress(n: number, down: boolean): void {
    if (this.screen() === 'job') {
      if (down) this.jobs.scene(n);
      return;
    }
    const key = `scene${n}`;
    if (down) {
      this.holdTimers.set(key, setTimeout(() => {
        this.holdTimers.delete(key);
        if (this.sceneMarker() === 'marker') {
          if (this.seq.storeMarker(n)) this.show('MARKER', 'STORED');
        } else if (this.initHeld()) {
          if (this.seq.initScene(n)) this.show('INITIALIZED', '');
        } else if (this.seq.storeScene(n)) this.show('SCENE', 'STORED');
      }, HOLD_MS));
      return;
    }
    const pending = this.holdTimers.get(key);
    if (!pending) return; // the hold already fired
    clearTimeout(pending);
    this.holdTimers.delete(key);
    if (this.initHeld()) return;
    // The change happens on release (p.179).
    if (this.sceneMarker() === 'marker') this.seq.jumpMarker(n);
    else this.seq.recallScene(n);
  }

  // =====================================================================
  // Tempo

  /** BPM COUNTER: tap along; press OK to keep the detected tempo (p.17). */
  tapTempo(): void {
    const now = performance.now();
    this.taps = [...this.taps.filter((t) => now - t < 2500), now].slice(-6);
    if (this.taps.length < 2) return;
    const avg = (this.taps.at(-1)! - this.taps[0]) / (this.taps.length - 1);
    this.tapBpm.set(Math.round(Math.min(BPM_MAX, Math.max(BPM_MIN, 60_000 / avg)) * 10) / 10);
    if (this.tapTimer) clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => this.tapBpm.set(null), 4000);
  }

  // =====================================================================
  // Ribbon

  private ribbonTrack(): number {
    return trackForPad(this.ribbonPad(), this.bank());
  }

  ribbon(v: number | null): void {
    const i = this.ribbonTrack();
    const t = this.seq.track(i);
    const fn = this.ribbonFn();
    if (fn === 'scratch') return this.doScratch(t, v);
    if (v === null || !this.usable(fn, t)) return;
    this.lastTrack.set(i);
    this.seq.setKnob(i, fn, fromUnit(fn, t.kind, v));
  }

  /** SCRATCH: the first part of the sample is mapped along the ribbon from the bottom (p.173). */
  private doScratch(t: Track, v: number | null): void {
    const s = t.sample();
    if (!s || v === null) {
      this.scratch = null;
      return;
    }
    const span = Math.min(1.5, (s.end - s.start) / s.buffer.sampleRate);
    const pos = s.start / s.buffer.sampleRate + v * span;
    const now = this.engine.now;
    const prev = this.scratch;
    this.scratch = { track: t.index, pos, time: now };
    if (!prev || prev.track !== t.index) return;
    const delta = pos - prev.pos;
    const dt = Math.max(0.01, now - prev.time);
    if (Math.abs(delta) < 0.002) return;
    const rate = Math.min(4, Math.max(0.1, Math.abs(delta) / dt));
    const buffer = delta > 0 ? s.buffer : reversed(s, this.engine.ctx);
    const offset = delta > 0 ? prev.pos : s.buffer.duration - prev.pos;
    this.engine.killVoices(t.index, (x) => x.opts.source === 'roll');
    this.engine.play(t, s.buffer, {
      when: now, offset, duration: Math.abs(delta), rate, velocity: 127, buffer,
      attack: 0.003, gateEnd: now + Math.abs(delta) / rate, release: 0.01, source: 'roll',
    });
  }

  // =====================================================================
  // Sampling (p.156–159)

  async pressSampling(): Promise<void> {
    this.engine.resume();
    const s = this.sampling();
    if (!s) {
      if (this.seq.mode() !== 'playStandby' || this.screen() === 'job') {
        this.show('STOP SEQ', 'FIRST');
        return;
      }
      this.fx.set(null);
      const last = this.lastTrack();
      const target = isSampleTrack(last) ? last : this.bank() * PADS_PER_BANK;
      this.sampling.set({ step: 'select', target, cursor: 0 });
      this.screen.set('sampling');
      return;
    }
    if (s.step === 'params') {
      if (!this.engine.source()) {
        this.show('NO AUDIO IN', 'LOAD SOURCE');
        return;
      }
      if (!this.engine.sourcePlaying()) this.engine.playSource();
      await this.engine.startRecording();
      this.sampling.set({ ...s, step: 'recording' });
      return;
    }
    if (s.step === 'recording') {
      this.sampling.set({ ...s, step: 'wait' });
      const raw = await this.engine.stopRecording();
      if (!raw) return this.finishSampling();
      const buffer = await convert(raw, this.sampleRate(), this.sampleBits(), this.sampleChannels());
      this.assignSample(s.target, buffer, this.sampleRate(), this.sampleBits());
    }
  }

  /** Put audio on a track (sampling, or importing straight from the source tray). */
  assignSample(i: number, buffer: AudioBuffer, rate: SampleRate = 44100, bits: 16 | 8 = 16): void {
    const t = this.seq.track(i);
    const s = this.sampling();
    if (t.kind === 'loop') {
      const beats = fitLoop(buffer.duration, this.seq.bpm);
      if (beats === null) {
        if (s) this.sampling.set({ ...s, step: 'cannotLoop' });
        else this.show('CANNOT FIND', 'LOOP');
        return;
      }
      t.loopLength.set(beats);
      t.refBpm.set((60 * beats) / buffer.duration);
    } else {
      t.refBpm.set(this.seq.bpm);
    }
    const kind = t.kind === 'loop' ? 'LP' : t.kind === 'composed' ? 'CL' : 'FR';
    const sample: Sample = {
      buffer, rate, bits, start: 0, end: buffer.length,
      name: `S${String(this.song().number).padStart(2, '0')}${kind}${trackLabel(i).slice(2)}`,
    };
    t.sample.set(sample);
    this.engine.applyTrack(t);
    if (s) this.finishSampling();
    this.show(sample.name, `${buffer.duration.toFixed(2)}S`);
  }

  private finishSampling(): void {
    this.sampling.set(null);
    this.screen.set('main');
    this.seq.setPosition(0); // back to PLAY STANDBY at 001:1 (p.147)
  }

  private samplingOk(s: SamplingState): void {
    switch (s.step) {
      case 'select':
        this.sampling.set({ ...s, step: this.seq.track(s.target).sample() ? 'replace' : 'params' });
        return;
      case 'replace':
        this.sampling.set({ ...s, step: 'params' });
        return;
      case 'cannotLoop':
        this.finishSampling();
        return;
    }
  }

  private async samplingCancel(s: SamplingState): Promise<void> {
    switch (s.step) {
      case 'select':
        this.sampling.set(null);
        this.screen.set('main');
        return;
      case 'replace':
      case 'params':
        this.sampling.set({ ...s, step: 'select' });
        return;
      case 'recording':
        await this.engine.stopRecording(true);
        this.sampling.set({ ...s, step: 'select' });
        return;
      case 'cannotLoop':
        this.finishSampling();
        return;
    }
  }

  private samplingDial(s: SamplingState, step: number): void {
    if (s.step !== 'params') return;
    const cycle = <T>(list: T[], cur: T) => list[(list.indexOf(cur) + step + list.length) % list.length];
    if (s.cursor === 0) this.sampleRate.set(cycle(RATES, this.sampleRate()));
    if (s.cursor === 1) this.sampleBits.set(this.sampleBits() === 16 ? 8 : 16);
    if (s.cursor === 2) this.sampleChannels.set(cycle(CHANNEL_MODES, this.sampleChannels()));
  }

  // =====================================================================
  // Helpers

  show(top: string, value: string, ms = 1300): void {
    this.flash.set({ top, value });
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.flash.set(null), ms);
  }

  /** PITCH, LENGTH and GROOVE are disabled on LOOP tracks set to CHNG PITCH (p.198, 237). */
  private pitchLocked(t: Track, fn: KnobFn): boolean {
    return t.kind === 'loop' && t.bpmTracking() === 'pitch' &&
      (fn === 'pitch' || fn === 'length' || !!KNOB_FNS[fn].grooveRes);
  }

  /** What the dial edits when NOTE is blinking. */
  private noteContext(): 'roll' | 'groove' | 'quantize' | 'fxRes' | null {
    if (this.screen() !== 'function') return null;
    if (this.rollHeld()) return 'roll';
    const fn = KNOB_FNS[this.knobFn()];
    if (this.lastFnKind === 'pad') return 'quantize';
    const e = effectIndex(this.knobFn());
    if (e >= 0) return effectDef(this.block(e).type).sync ? 'fxRes' : null;
    if (fn.grooveRes) return 'groove';
    return fn.quantized ? 'quantize' : null;
  }

  private noteDial(step: number): void {
    switch (this.noteContext()) {
      case 'roll':
        this.rollRate.update((r) => Math.min(ROLL_VALUES.length - 1, Math.max(0, r + step)));
        return;
      case 'groove': {
        // Only settable from the GRV TIMING screen (p.202).
        if (this.knobFn() !== 'grvTiming') return;
        const t = this.seq.track(this.lastTrack());
        if (!isSampleTrack(t.index)) return;
        this.seq.setGrooveRes(t.index, Math.min(GROOVE_RES_VALUES.length - 1, Math.max(0, t.grooveRes() + step)));
        return;
      }
      case 'quantize':
        this.seq.quantize.update((q) => Math.min(QUANTIZE_VALUES.length - 1, Math.max(0, q + step)));
        return;
      case 'fxRes': {
        // Set only here, never recorded: store it in a scene to change it during a song (p.192).
        const e = effectIndex(this.knobFn());
        const next = cloneEffects(this.song().effects());
        next[e].res = Math.min(EFFECT_RES.length - 1, Math.max(0, next[e].res + step));
        this.song().effects.set(next);
      }
    }
  }

  // =====================================================================
  // EFFECT SETUP: CLEAR 1–3 and SETUP 1–3 (p.214–219)

  private fxAllowed(): boolean {
    const m = this.seq.mode();
    if (this.sampling() || this.screen() === 'job') return false;
    if (m === 'play' || m === 'playStandby') return true;
    this.show('NOT IN REC', '');
    return false;
  }

  pressClear(block: number): void {
    if (!this.fxAllowed()) return;
    this.fx.set({ mode: 'clear', block, page: 0, replace: null });
    this.screen.set('effect');
    this.blink.set(null);
  }

  pressSetup(block: number): void {
    if (!this.fxAllowed()) return;
    this.fx.set({ mode: 'setup', block, page: 0, replace: null });
    this.screen.set('effect');
    this.blink.set(null);
  }

  private leaveEffect(): void {
    if (this.screen() !== 'effect') return;
    this.fx.set(null);
    this.screen.set('main');
  }

  private effectPad(fx: EffectScreen, i: number, velocity: number): void {
    if (fx.mode === 'clear') {
      this.seq.toggleMute(i); // mutes can be operated on the CLEAR screen
      return;
    }
    const b = this.block(fx.block);
    if (isInsertion(b) && connectable(i)) {
      const setup = this.song().effects();
      if (!b.connected.includes(i) && connectedElsewhere(setup, fx.block, i) >= 0) {
        this.fx.set({ ...fx, replace: i });
        return;
      }
      this.song().effects.set(toggleConnection(setup, fx.block, i));
    }
    this.seq.noteOn(i, velocity); // pads always play on the setup screens
  }

  private effectDial(fx: EffectScreen, step: number): void {
    if (fx.mode !== 'setup' || fx.replace !== null) return;
    const page = setupPages(fx.block, this.block(fx.block))[fx.page];
    this.song().effects.set(dialPage(this.song().effects(), fx.block, page, step));
  }

  private effectOk(fx: EffectScreen): void {
    if (fx.replace !== null) {
      this.song().effects.set(toggleConnection(this.song().effects(), fx.block, fx.replace, true));
      this.fx.set({ ...fx, replace: null });
      return;
    }
    if (fx.mode === 'clear') {
      // System: every track's level → 0. Insertion: MASTER level → 0 and all tracks disconnected (p.215).
      const fn = EFFECT_FNS[fx.block];
      const ins = isInsertion(this.block(fx.block));
      for (const t of this.song().tracks) {
        if (ins ? t.index === MASTER : t.index !== MASTER) this.seq.setKnob(t.index, fn, 0, false);
      }
      const next = cloneEffects(this.song().effects());
      if (ins) next[fx.block].connected = [];
      next[fx.block].res = EFFECT_RES_DEFAULT;
      this.song().effects.set(next);
    }
    this.toMain();
  }

  private deleteNotes(i: number, from: number, to: number): void {
    const t = this.seq.track(i);
    if (t.kind === 'free') {
      this.song().events.update((es) => es.filter((e) => !(e.type === 'note' && e.track === i && e.tick >= from && e.tick <= to)));
    } else {
      const loopTicks = t.loopLength() * PPQ;
      const span = to - from;
      const a = ((from % loopTicks) + loopTicks) % loopTicks;
      t.loopNotes.update((ns) => ns.filter((n) => {
        if (span >= loopTicks) return false;
        const d = (((n.tick - a) % loopTicks) + loopTicks) % loopTicks;
        return d > span;
      }));
    }
    this.show('NOTE DEL', trackLabel(i));
  }

  private buildDisplay(): DisplayModel {
    const seq = this.seq;
    const song = this.song();
    const tracks = this.padTracks().map((i) => seq.track(i));
    const last = seq.track(this.lastTrack());
    const s = this.sampling();
    const pos = seq.position();
    const { measure, beat } = locate(song.meters(), pos);
    const base: DisplayModel = {
      top: '', value: '', bank: this.bank(), rec: seq.mode() === 'rec' || seq.mode() === 'recStandby',
      padFn: null, meters: [], input: null, clip: performance.now() < this.clipUntil,
      measure: `${pos < 0 ? '-' : ''}${String(Math.abs(measure)).padStart(pos < 0 ? 2 : 3, '0')}:${beat}`,
      bpm: (this.tapBpm() ?? seq.bpm).toFixed(1), note: '', blink: this.blink(), blinkTop: false, blinkValue: false,
    };
    if (this.tapBpm() !== null) base.blink = 'bpm';

    const meterFor = (fn: KnobFn | null) =>
      tracks.map<MeterCell>((t) => {
        const ok = fn && this.usable(fn, t);
        return {
          value: ok ? toUnit(fn!, t.kind, t.knobs()[fn!]) : null,
          bipolar: ok ? KNOB_FNS[fn!].min(t.kind) < 0 : false,
          bracket: !t.muted(),
          selected: t.index === this.lastTrack(),
          hasSample: !!t.sample(),
        };
      });

    if (s) {
      const target = seq.track(s.target);
      const withSel = tracks.map<MeterCell>((t) => ({
        value: null, bipolar: false, bracket: t.index === s.target, selected: t.index === s.target, hasSample: !!t.sample(),
      }));
      const rate = `${Math.round(this.sampleRate() / 1000)}K`;
      const params = [rate, `${this.sampleBits()}BIT`, this.sampleChannels()];
      switch (s.step) {
        case 'select':
          return { ...base, top: 'SELECT TRACK', value: trackLabel(s.target), meters: withSel, bank: Math.floor(s.target / 10) };
        case 'replace':
          return { ...base, top: 'REPLACE', value: 'SAMPLE?', meters: withSel, blinkTop: true };
        case 'params':
          return {
            ...base, top: params.map((p, i) => (i === s.cursor ? `[${p}]` : p)).join(' '),
            value: trackLabel(target.index), input: this.inputLevels(),
          };
        case 'recording':
          return { ...base, top: 'SAMPLING', value: `${this.recordedSec().toFixed(1)}S`, input: this.inputLevels(), rec: true };
        case 'wait':
          return { ...base, top: 'WAIT...', value: '' };
        case 'cannotLoop':
          return { ...base, top: 'CANNOT FIND', value: 'LOOP', blinkTop: true };
      }
    }

    const f = this.flash();
    if (this.screen() === 'job') {
      const g = this.jobGroup();
      if (!this.jobs.job()) {
        return { ...base, top: f?.top ?? (g ? JOB_GROUP_LABEL[g] : ''), value: f?.value ?? 'SELECT JOB', meters: meterFor(null) };
      }
      const v = this.jobs.view();
      const sel = v.track;
      return {
        ...base,
        top: f?.top ?? v.top,
        value: f?.value ?? v.value,
        blinkTop: !f && !!v.blinkTop,
        blinkValue: !f && !!v.blinkValue,
        topRange: f ? undefined : v.topRange,
        valueRange: f ? undefined : v.valueRange,
        note: v.note ?? '',
        bank: sel !== null && isSampleTrack(sel) ? Math.floor(sel / PADS_PER_BANK) : base.bank,
        meters: tracks.map<MeterCell>((t) => ({
          value: null, bipolar: false, bracket: t.index === sel, selected: t.index === sel, hasSample: !!t.sample(),
          hasSeq: sel !== null && song.hasSequence(t.index),
        })),
      };
    }

    const fx = this.fx();
    if (this.screen() === 'effect' && fx) return this.effectDisplay(base, fx, f, meterFor);

    if (this.screen() === 'main') {
      const n = this.pendingSong() ?? song.number - 1;
      const name = this.pendingSong() !== null ? this.songName(n) : song.name();
      return {
        ...base,
        top: f?.top ?? `${String(n + 1).padStart(2, '0')} ${name}`,
        value: f?.value ?? (this.pendingSong() !== null ? 'PRESS OK' : ''),
        blinkTop: this.pendingSong() !== null,
        meters: meterFor(last.mainKnob()),
      };
    }

    // Function screen
    const fn = this.knobFn();
    const def = KNOB_FNS[fn];
    const locked = this.pitchLocked(last, fn);
    const e = effectIndex(fn);
    const inactive = !supports(fn, last.kind) || (e >= 0 && !effectKnobActive(this.block(e), last.index));
    const value = inactive ? '***' : locked ? '---' : def.format(last.knobs()[fn]);
    const ctx = this.noteContext();
    let noteText = '';
    if (ctx === 'roll') noteText = `ROLL=${ROLL_VALUES[this.rollRate()].label}`;
    else if (ctx === 'groove') noteText = isSampleTrack(last.index) ? `RES=${GROOVE_RES_VALUES[last.grooveRes()].label}` : '';
    else if (ctx === 'quantize') noteText = `Q=${QUANTIZE_VALUES[seq.quantize()]?.label ?? 'OFF'}`;
    else if (ctx === 'fxRes') noteText = `RES=${EFFECT_RES[this.block(e).res]}`;
    return {
      ...base,
      // The EFFECT screens name the effect assigned to the block (p.211).
      top: f?.top ?? (e >= 0 ? this.block(e).type : def.screen),
      value: f?.value ?? `${trackLabel(last.index)} ${value}`,
      padFn: this.rollHeld() ? 'play' : this.padFn(),
      meters: meterFor(fn),
      note: noteText,
    };
  }

  private effectDisplay(
    base: DisplayModel, fx: EffectScreen, f: { top: string; value: string } | null,
    meterFor: (fn: KnobFn | null) => MeterCell[],
  ): DisplayModel {
    const b = this.block(fx.block);
    const def = effectDef(b.type);
    const meters = meterFor(EFFECT_FNS[fx.block]);
    const note = def.sync ? `RES=${EFFECT_RES[b.res]}` : '';
    if (fx.mode === 'clear') {
      return { ...base, top: f?.top ?? `CLEAR=${b.type}`, value: f?.value ?? 'PRESS OK', meters, note };
    }
    if (fx.replace !== null) {
      return { ...base, top: 'REPLACE?', value: trackLabel(fx.replace), blinkTop: true, meters, note };
    }
    // Insertion: brackets show the tracks connected to the block; MASTER has none (p.217).
    const cells = isInsertion(b)
      ? meters.map((m, p) => {
        const i = this.padTracks()[p];
        return { ...m, bracket: i !== MASTER && b.connected.includes(i) };
      })
      : meters;
    const pages = setupPages(fx.block, b);
    const page: SetupPage = pages[Math.min(fx.page, pages.length - 1)];
    const v = pageView(fx.block, b, page);
    // The manual's "(" / ")" page marks are the diagonal segments; DSEG14 draws those as "<" / ">" (p.218).
    const prev = fx.page > 0 ? '<' : '';
    const next = fx.page < pages.length - 1 ? '>' : '';
    return {
      ...base,
      top: f?.top ?? `${prev}${v.name}`,
      value: f?.value ?? `${v.value}${next}`,
      meters: cells,
      note,
    };
  }

  private songName(n: number): string {
    return this.seq.songAt(n).name();
  }
}

// ---------------------------------------------------------------------------

/** Apply the sampling parameters: rate (via offline resampling), bit depth and channel mode. */
async function convert(raw: AudioBuffer, rate: SampleRate, bits: 16 | 8, mode: ChannelMode): Promise<AudioBuffer> {
  const channels = mode === 'STEREO' ? 2 : 1;
  const ctx = new OfflineAudioContext(channels, Math.max(1, Math.ceil(raw.duration * rate)), rate);
  const src = ctx.createBufferSource();
  const pre = new AudioBuffer({ numberOfChannels: channels, length: raw.length, sampleRate: raw.sampleRate });
  const [l, r] = [raw.getChannelData(0), raw.getChannelData(raw.numberOfChannels > 1 ? 1 : 0)];
  if (mode === 'STEREO') {
    pre.copyToChannel(l, 0);
    pre.copyToChannel(r, 1);
  } else {
    const out = new Float32Array(raw.length);
    for (let i = 0; i < out.length; i++) out[i] = mode === 'MONO L' ? l[i] : mode === 'MONO R' ? r[i] : (l[i] + r[i]) / 2;
    pre.copyToChannel(out, 0);
  }
  src.buffer = pre;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  if (bits === 8) {
    for (let c = 0; c < rendered.numberOfChannels; c++) {
      const d = rendered.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = Math.round(d[i] * 127) / 127;
    }
  }
  return rendered;
}

const reversedCache = new WeakMap<AudioBuffer, AudioBuffer>();
function reversed(s: Sample, ctx: BaseAudioContext): AudioBuffer {
  let r = reversedCache.get(s.buffer);
  if (!r) {
    r = ctx.createBuffer(s.buffer.numberOfChannels, s.buffer.length, s.buffer.sampleRate);
    for (let c = 0; c < r.numberOfChannels; c++) r.copyToChannel(s.buffer.getChannelData(c).slice().reverse(), c);
    reversedCache.set(s.buffer, r);
  }
  return r;
}

