import { Injectable, computed, inject, signal } from '@angular/core';
import { AudioEngine } from './audio/audio-engine';
import { KNOB_FNS, KnobFn, defaultKnobs, fromUnit, supports, toUnit } from './core/knob-functions';
import {
  BPM_MAX, BPM_MIN, GROOVE_RES_VALUES, PADS_PER_BANK, PPQ, PadFn, QUANTIZE_VALUES,
  ROLL_VALUES, SONG_COUNT, Sample, TICKS_PER_MEASURE, isSampleTrack, note, trackForPad, trackLabel,
} from './core/model';
import { Sequencer } from './core/sequencer';
import { Track } from './core/song';

export type Screen = 'main' | 'function' | 'job' | 'sampling';
export type Blink = 'measure' | 'bpm' | 'note' | null;
export type JobGroup = 'song' | 'trackSet' | 'trackEdit' | 'eventEdit' | 'sample' | 'resample' | 'disk' | 'system';

export const JOB_GROUP_LABEL: Record<JobGroup, string> = {
  song: 'SONG', trackSet: 'TRACK SET', trackEdit: 'TRACK EDIT', eventEdit: 'EVENT EDIT',
  sample: 'SAMPLE', resample: 'RESAMPLE', disk: 'DISK', system: 'SYSTEM',
};

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
}

const HOLD_MS = 1500;

/**
 * Front-panel behaviour: screens, pads, knobs and buttons, translated into Sequencer /
 * AudioEngine calls following the SU700 Owner's Manual.
 */
@Injectable({ providedIn: 'root' })
export class UnitController {
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

  /** Tracks under the 12 knobs / pads for the current bank. */
  readonly padTracks = computed(() => Array.from({ length: 12 }, (_, p) => trackForPad(p, this.bank())));

  /** Knob function each knob currently controls. */
  private knobFnFor(track: Track): KnobFn {
    return this.screen() === 'function' ? this.knobFn() : track.mainKnob();
  }

  /** 0..1 knob positions for the 12 knobs. */
  readonly knobPositions = computed(() =>
    this.padTracks().map((i) => {
      const t = this.seq.track(i);
      const fn = this.knobFnFor(t);
      return supports(fn, t.kind) ? toUnit(fn, t.kind, t.knobs()[fn]) : 0;
    }),
  );

  readonly display = computed<DisplayModel>(() => this.buildDisplay());

  constructor() {
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
    if (!supports(fn, t.kind) || this.pitchLocked(t, fn)) return;
    this.seq.setKnob(i, fn, fromUnit(fn, t.kind, unit));
  }

  /** Double-click a knob: back to that function's default. */
  resetKnob(pos: number): void {
    const i = this.padTracks()[pos];
    const t = this.seq.track(i);
    const fn = this.knobFnFor(t);
    if (supports(fn, t.kind)) this.seq.setKnob(i, fn, KNOB_FNS[fn].def(t.kind));
  }

  selectKnobFn(fn: KnobFn): void {
    if (this.screen() === 'sampling') return;
    if (this.screen() === 'job') return; // TRACK SET | MAIN will consume these once jobs exist
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
    this.lastTrack.set(i);
    if (this.screen() === 'job') return;

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
    if (this.screen() === 'sampling' || this.screen() === 'job') return;
    this.screen.set('function');
    this.padFn.set(fn);
    this.lastFnKind = 'pad';
  }

  /** ROLL works only while held; releasing returns to PLAY (p.167). */
  setRollHeld(down: boolean): void {
    if (this.screen() === 'sampling' || this.screen() === 'job') return;
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
  }

  // =====================================================================
  // Display-area buttons, dial, OK / CANCEL, cursor

  pressBlink(which: Exclude<Blink, null>): void {
    if (this.screen() === 'sampling' || this.screen() === 'job') return;
    this.screen.set('function');
    this.blink.update((b) => (b === which ? null : which));
  }

  dial(step: number): void {
    const s = this.sampling();
    if (s) return this.samplingDial(s, step);
    if (this.screen() === 'job') return;

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
    if (supports(fn, t.kind) && !this.pitchLocked(t, fn)) this.seq.setKnob(t.index, fn, t.knobs()[fn] + step);
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
      this.exitJob();
      return;
    }
    this.toMain();
  }

  pressCancel(): void {
    const s = this.sampling();
    if (s) return void this.samplingCancel(s);
    this.pendingSong.set(null);
    if (this.screen() === 'job') {
      this.exitJob();
      return;
    }
    if (this.seq.mode() === 'recStandby') this.seq.pressStop();
    this.toMain();
  }

  pressCursor(dir: -1 | 1): void {
    const s = this.sampling();
    if (s?.step === 'params') this.sampling.set({ ...s, cursor: ((s.cursor + dir + 3) % 3) as 0 | 1 | 2 });
  }

  private toMain(): void {
    this.screen.set('main');
    this.blink.set(null);
  }

  // =====================================================================
  // Jobs (group + job selector). Individual jobs are still to be built.

  pressJobGroup(g: JobGroup): void {
    if (this.sampling()) return;
    if (this.seq.mode() !== 'playStandby') {
      this.show('STOP SEQ', 'FIRST');
      return;
    }
    this.jobGroup.set(g);
    this.screen.set('job');
    this.blink.set(null);
  }

  pressJob(label: string): void {
    if (this.screen() !== 'job' || !label) return;
    this.show(label, 'NOT YET');
  }

  private exitJob(): void {
    this.jobGroup.set(null);
    this.toMain();
    this.seq.setPosition(0); // leaving job mode returns to 001:1 (p.146)
  }

  // =====================================================================
  // Transport

  pressTransport(id: 'rec' | 'top' | 'stop' | 'play'): void {
    if (this.sampling() || this.screen() === 'job') return;
    this.engine.resume();
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
    if (!down || this.sampling() || this.screen() === 'job') return;
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
    if (v === null || !supports(fn, t.kind)) return;
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
  private noteContext(): 'roll' | 'groove' | 'quantize' | null {
    if (this.screen() !== 'function') return null;
    if (this.rollHeld()) return 'roll';
    const fn = KNOB_FNS[this.knobFn()];
    if (this.lastFnKind === 'pad') return 'quantize';
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
    }
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
    const measure = Math.floor(pos / TICKS_PER_MEASURE) + (pos < 0 ? 0 : 1);
    const beat = Math.floor((((pos % TICKS_PER_MEASURE) + TICKS_PER_MEASURE) % TICKS_PER_MEASURE) / PPQ) + 1;
    const base: DisplayModel = {
      top: '', value: '', bank: this.bank(), rec: seq.mode() === 'rec' || seq.mode() === 'recStandby',
      padFn: null, meters: [], input: null, clip: performance.now() < this.clipUntil,
      measure: `${pos < 0 ? '-' : ''}${String(Math.abs(measure)).padStart(pos < 0 ? 2 : 3, '0')}:${beat}`,
      bpm: (this.tapBpm() ?? seq.bpm).toFixed(1), note: '', blink: this.blink(), blinkTop: false,
    };
    if (this.tapBpm() !== null) base.blink = 'bpm';

    const meterFor = (fn: KnobFn | null) =>
      tracks.map<MeterCell>((t) => {
        const ok = fn && supports(fn, t.kind) && !this.pitchLocked(t, fn);
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
      return { ...base, top: f?.top ?? (g ? JOB_GROUP_LABEL[g] : ''), value: f?.value ?? 'SELECT JOB', meters: meterFor(null) };
    }

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
    const value = !supports(fn, last.kind) ? '***' : locked ? '---' : def.format(last.knobs()[fn]);
    const ctx = this.noteContext();
    let noteText = '';
    if (ctx === 'roll') noteText = `ROLL=${ROLL_VALUES[this.rollRate()].label}`;
    else if (ctx === 'groove') noteText = isSampleTrack(last.index) ? `RES=${GROOVE_RES_VALUES[last.grooveRes()].label}` : '';
    else if (ctx === 'quantize') noteText = `Q=${QUANTIZE_VALUES[seq.quantize()]?.label ?? 'OFF'}`;
    return {
      ...base,
      top: f?.top ?? def.screen,
      value: f?.value ?? `${trackLabel(last.index)} ${value}`,
      padFn: this.rollHeld() ? 'play' : this.padFn(),
      meters: meterFor(fn),
      note: noteText,
    };
  }

  private songName(n: number): string {
    return this.seq.songAt(n).name();
  }
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

