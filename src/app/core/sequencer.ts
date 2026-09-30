import { Injectable, computed, inject, signal } from '@angular/core';
import { AudioEngine, Voice, attackSec, releaseSec } from '../audio/audio-engine';
import { KNOB_FNS, KnobFn, clampKnob, supports } from './knob-functions';
import {
  GROOVE_RES_VALUES, LoopNote, MASTER, PPQ, QUANTIZE_VALUES, SONG_COUNT, Scene, SeqEvent,
  TICKS_PER_MEASURE, TRACK_COUNT, BPM_MAX, BPM_MIN, isSampleTrack, locate,
} from './model';
import { Song, Track } from './song';

export type SeqMode = 'playStandby' | 'play' | 'recStandby' | 'rec';

interface Snapshot {
  events: SeqEvent[];
  loopNotes: LoopNote[][];
}

interface RecPass {
  start: number;
  events: SeqEvent[];
  /** Event keys entered this pass (REPLACE mode wipes older events with these keys). */
  keys: Set<string>;
  /** COMPOSED LOOP tracks whose phrase was cleared for this pass (REPLACE mode). */
  clearedLoops: Set<number>;
}

interface HeldNote {
  onTick: number;
  /** The recorded event/loop note, patched with the gate on release. */
  commit?: (gate: number) => void;
}

interface LiveRoll {
  start: number;
  next: number;
  rate: number;
  velocity: number;
}

const LOOKAHEAD = 0.15;
const PUMP_MS = 25;

const eventKey = (e: SeqEvent) =>
  e.type === 'knob' ? `knob:${e.track}:${e.fn}` : e.type === 'scene' ? 'scene' : `${e.type}:${e.track}`;

/**
 * The SU700 song sequencer: four modes (PLAY STANDBY, PLAY, REC STANDBY, REC),
 * a look-ahead scheduler for LOOP / COMPOSED LOOP / FREE playback, and recording.
 */
@Injectable({ providedIn: 'root' })
export class Sequencer {
  private readonly engine = inject(AudioEngine);
  private readonly songs: (Song | undefined)[] = new Array(SONG_COUNT);

  readonly song = signal<Song>(this.songAt(0));
  readonly mode = signal<SeqMode>('playStandby');
  readonly running = computed(() => this.mode() === 'play' || this.mode() === 'rec');
  /** Current song position in ticks (negative during the REC countdown). */
  readonly position = signal(0);
  /** Index into QUANTIZE_VALUES (0 = off). */
  readonly quantize = signal(0);
  readonly recMode = signal<'replace' | 'overdub'>('replace');
  readonly countdown = signal(2);
  readonly padSens = signal(true);
  /** SYSTEM | SETUP METRONOME CLICK (p.298). */
  readonly metronome = signal<'off' | 'rec' | 'recPlay'>('off');
  readonly undoState = signal<'none' | 'undo' | 'redo'>('none');

  private anchorTime = 0;
  private anchorTick = 0;
  private scheduledTo = 0;
  private resume = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loopAnchor = new Array<number>(TRACK_COUNT).fill(0);
  private pending: { time: number; fn: () => void }[] = [];
  private rec: RecPass | null = null;
  private undo: { before: Snapshot; after: Snapshot } | null = null;
  private held = new Map<number, HeldNote>();
  private liveRolls = new Map<number, LiveRoll>();
  /** COMPOSED LOOP notes recorded this pass, with the absolute tick already played live. */
  private fresh = new WeakMap<LoopNote, number>();

  constructor() {
    this.applyAll();
    const frame = () => {
      if (this.running()) this.position.set(Math.floor(this.tickAt(this.engine.now)));
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  get bpm(): number {
    return this.song().bpm();
  }

  track(i: number): Track {
    return this.song().tracks[i];
  }

  songAt(i: number): Song {
    return (this.songs[i] ??= new Song(i + 1));
  }

  selectSong(i: number): void {
    if (this.mode() !== 'playStandby') return;
    this.song.set(this.songAt(i));
    this.undo = null;
    this.undoState.set('none');
    this.setPosition(0);
    this.applyAll();
  }

  /** SONG | COPY (p.229): a full copy of song `from` becomes song `to`. */
  copySong(from: number, to: number, name: string): void {
    const dst = new Song(to + 1);
    dst.copyFrom(this.songAt(from), name);
    this.songs[to] = dst;
  }

  /** SONG | INIT (p.230): song `i` back to an empty song. */
  initSong(i: number): void {
    this.songs[i] = new Song(i + 1);
    if (this.song().number !== i + 1) return;
    for (let t = 0; t < TRACK_COUNT; t++) this.engine.killVoices(t);
    this.song.set(this.songs[i]!);
    this.undo = null;
    this.undoState.set('none');
    this.setPosition(0);
    this.applyAll();
  }

  /** Push every track's knob and mute state into the audio graph. */
  applyAll(): void {
    for (const t of this.song().tracks) {
      this.engine.applyTrack(t);
      this.engine.setMuted(t.index, t.muted());
    }
  }

  // =====================================================================
  // Transport

  pressPlay(): void {
    this.engine.resume();
    switch (this.mode()) {
      case 'playStandby':
        this.mode.set('play');
        this.start(this.position(), 0);
        break;
      case 'recStandby': {
        const from = Math.max(0, this.position());
        this.rec = { start: from, events: [], keys: new Set(), clearedLoops: new Set() };
        this.undo = { before: this.snapshot(), after: this.snapshot() };
        this.mode.set('rec');
        this.start(from, this.countdown() * TICKS_PER_MEASURE);
        break;
      }
    }
  }

  pressStop(): void {
    switch (this.mode()) {
      case 'play':
        this.halt();
        this.mode.set('playStandby');
        break;
      case 'rec': {
        const stopTick = this.tickAt(this.engine.now);
        this.halt();
        this.finishPass(stopTick);
        this.mode.set('playStandby');
        this.setPosition(this.rec!.start);
        this.rec = null;
        break;
      }
      case 'recStandby':
        this.mode.set('playStandby');
        break;
    }
  }

  pressRec(): void {
    if (this.mode() !== 'playStandby') return;
    // Entering REC STANDBY clears the undo memory (p.184).
    this.undo = null;
    this.undoState.set('none');
    this.mode.set('recStandby');
  }

  toTop(): void {
    if (this.mode() === 'rec') return;
    this.setPosition(0);
  }

  /** Move by whole beats (FF / REW, dial with MEASURE blinking). */
  nudge(beats: number): void {
    if (this.mode() === 'rec') return;
    this.setPosition(Math.max(0, this.beatFloor(this.position()) + beats * PPQ), this.mode() === 'play');
  }

  setPosition(tick: number, replayPassedEvents = false): void {
    const old = this.running() ? this.tickAt(this.engine.now) : this.position();
    if (replayPassedEvents && tick > old) {
      // In PLAY, knob and mute events passed over are reproduced, scene changes are not (p.164).
      for (const e of this.song().events()) {
        if (e.tick < old || e.tick >= tick) continue;
        if (e.type === 'knob') this.setKnob(e.track, e.fn as KnobFn, e.value, false);
        if (e.type === 'mute') this.setMuted(e.track, e.muted);
      }
    }
    this.position.set(tick);
    if (this.running()) {
      this.killScheduled();
      this.anchorTime = this.engine.now + 0.02;
      this.anchorTick = tick;
      this.scheduledTo = tick;
      this.resume = true;
    }
    if (tick === 0) this.recallScene(0, false); // the TOP scene
  }

  setBpm(bpm: number): void {
    const v = Math.round(Math.min(BPM_MAX, Math.max(BPM_MIN, bpm)) * 10) / 10;
    if (this.running()) {
      const now = this.engine.now;
      this.anchorTick = this.tickAt(now);
      this.anchorTime = now;
    }
    this.song().bpm.set(v);
  }

  pressUndo(): string | null {
    if (this.mode() !== 'playStandby' || !this.undo) return null;
    const redo = this.undoState() === 'redo';
    this.restore(redo ? this.undo.after : this.undo.before);
    this.undoState.set(redo ? 'undo' : 'redo');
    this.setPosition(0);
    return redo ? 'REDO' : 'UNDO';
  }

  private start(fromTick: number, leadIn: number): void {
    this.anchorTime = this.engine.now + 0.05;
    this.anchorTick = fromTick - leadIn;
    this.scheduledTo = this.anchorTick;
    this.resume = true;
    this.position.set(this.anchorTick);
    this.timer = setInterval(() => this.pump(), PUMP_MS);
    this.pump();
  }

  private halt(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.position.set(Math.max(0, Math.floor(this.tickAt(this.engine.now))));
    this.killScheduled();
    for (const i of this.liveRolls.keys()) this.rollOff(i);
    this.pending = [];
  }

  private killScheduled(): void {
    this.engine.cancelClicks();
    for (let i = 0; i < TRACK_COUNT; i++) this.engine.killVoices(i, (v) => v.opts.source !== 'live');
  }

  private spt(): number {
    return 60 / (this.bpm * PPQ);
  }

  tickAt(time: number): number {
    return this.anchorTick + (time - this.anchorTime) / this.spt();
  }

  timeAt(tick: number): number {
    return this.anchorTime + (tick - this.anchorTick) * this.spt();
  }

  private beatFloor(tick: number): number {
    return Math.floor(tick / PPQ) * PPQ;
  }

  // =====================================================================
  // Scheduler

  private pump(): void {
    const now = this.engine.now;
    const to = this.tickAt(now + LOOKAHEAD);
    if (to > this.scheduledTo) {
      this.scheduleWindow(this.scheduledTo, to);
      this.scheduledTo = to;
      this.resume = false;
    }
    const due = this.pending.filter((p) => p.time <= now + 0.03);
    if (due.length) {
      this.pending = this.pending.filter((p) => p.time > now + 0.03);
      for (const p of due) p.fn();
    }
  }

  private at(tick: number, fn: () => void): void {
    this.pending.push({ time: this.timeAt(tick), fn });
  }

  private scheduleWindow(from: number, to: number): void {
    this.scheduleClicks(from, to);
    if (to <= 0) return;
    from = Math.max(0, from);
    const song = this.song();
    const restarts = new Map<number, number[]>();

    for (const e of song.events()) {
      if (e.tick < from || e.tick >= to) continue;
      switch (e.type) {
        case 'note':
          if (!this.suppressed(e.track, e.tick)) this.playNote(this.track(e.track), e.tick, e.gate, e.velocity, 'song');
          break;
        case 'knob':
          this.at(e.tick, () => this.setKnob(e.track, e.fn as KnobFn, e.value, false));
          break;
        case 'mute':
          this.at(e.tick, () => this.setMuted(e.track, e.muted));
          break;
        case 'scene':
          this.at(e.tick, () => this.recallScene(e.scene, false));
          break;
        case 'grooveRes':
          this.at(e.tick, () => this.track(e.track).grooveRes.set(e.res));
          break;
        case 'restart': {
          const targets = e.track === MASTER ? this.loopingTracks() : [e.track];
          for (const t of targets) restarts.set(t, [...(restarts.get(t) ?? []), e.tick]);
          break;
        }
      }
      if (e.type === 'roll') this.scheduleRoll(e.track, e.tick, e.rate, e.velocity, from, to, e.tick + e.length);
    }
    // Recorded rolls that began before this window but are still sounding.
    for (const e of song.events()) {
      if (e.type === 'roll' && e.tick < from && e.tick + e.length > from) {
        this.scheduleRoll(e.track, e.tick, e.rate, e.velocity, from, to, e.tick + e.length);
      }
    }
    for (const [i, r] of this.liveRolls) this.scheduleLiveRoll(i, r, to);

    for (const t of song.tracks) {
      if (!t.sample() || (t.kind !== 'loop' && t.kind !== 'composed')) continue;
      let cur = from;
      for (const r of (restarts.get(t.index) ?? []).sort((a, b) => a - b)) {
        this.scheduleLoopTrack(t, cur, r);
        this.engine.killVoices(t.index, (v) => v.opts.source === 'song' || v.opts.source === 'loop', this.timeAt(r));
        this.loopAnchor[t.index] = r;
        cur = r;
      }
      this.scheduleLoopTrack(t, cur, to);
    }
  }

  /** Metronome: every beat, accented on the downbeat, from the start of the countdown (p.299). */
  private scheduleClicks(from: number, to: number): void {
    const m = this.metronome();
    if (m === 'off' || (m === 'rec' && this.mode() !== 'rec')) return;
    for (let b = Math.ceil(from / PPQ) * PPQ; b < to; b += PPQ) {
      const at = locate(this.song().meters(), b);
      this.engine.click(this.timeAt(b), at.beat === 1 && at.tick === 0);
    }
  }

  private loopingTracks(): number[] {
    return this.song().tracks.filter((t) => t.kind === 'loop' || t.kind === 'composed').map((t) => t.index);
  }

  private scheduleLoopTrack(t: Track, a: number, b: number): void {
    if (b <= a) return;
    const loopTicks = t.loopLength() * PPQ;
    const anchor = this.loopAnchor[t.index];
    if (t.kind === 'composed') {
      const notes = t.loopNotes();
      if (!notes.length) return;
      const res = GROOVE_RES_VALUES[t.grooveRes()].ticks;
      const k = t.knobs();
      for (let cs = anchor + Math.floor((a - anchor) / loopTicks) * loopTicks; cs < b; cs += loopTicks) {
        for (const n of notes) {
          const tick = cs + n.tick;
          if (tick < a || tick >= b || this.suppressed(t.index, tick)) continue;
          const played = this.fresh.get(n);
          if (played !== undefined && tick <= played) continue;
          const odd = Math.floor(n.tick / res) % 2 === 1;
          const shift = odd ? (k.grvTiming / 100) * res : 0;
          const vel = odd ? n.velocity + (k.grvVelocity * 127) / 100 : n.velocity;
          const gate = odd ? n.gate * (1 + k.grvGate / 100) : n.gate;
          this.playNote(t, tick + shift, gate, vel, 'song');
        }
      }
      return;
    }

    // LOOP track: plays continuously while the sequencer runs.
    const s = t.sample()!;
    const sr = s.buffer.sampleRate;
    const spanSec = (s.end - s.start) / sr;
    const startSec = s.start / sr;
    const spt = this.spt();

    if (t.bpmTracking() === 'pitch') {
      const rate = spanSec / (loopTicks * spt);
      let cs = anchor + Math.floor((a - anchor) / loopTicks) * loopTicks;
      if (cs < a && this.resume && !this.suppressed(t.index, a)) {
        const frac = (a - cs) / loopTicks;
        this.engine.play(t, s.buffer, {
          when: this.timeAt(a), offset: startSec + frac * spanSec, duration: spanSec * (1 - frac),
          rate, velocity: 127, attack: 0.004, source: 'loop',
        });
      }
      for (cs = cs < a ? cs + loopTicks : cs; cs < b; cs += loopTicks) {
        if (this.suppressed(t.index, cs)) continue;
        this.engine.play(t, s.buffer, {
          when: this.timeAt(cs), offset: startSec, duration: spanSec, rate, velocity: 127, source: 'loop',
        });
      }
      return;
    }

    // SLICE: cut the span into groove-resolution slices and place each on the beat grid.
    const k = t.knobs();
    const res = GROOVE_RES_VALUES[t.grooveRes()].ticks;
    const slices = Math.max(1, Math.round(loopTicks / res));
    const segSec = spanSec / slices;
    const single = t.noteAssign() === 'single';
    for (let m = Math.ceil((a - anchor) / res); anchor + m * res < b; m++) {
      const base = anchor + m * res;
      if (this.suppressed(t.index, base)) continue;
      const idx = ((m % slices) + slices) % slices;
      const odd = idx % 2 === 1;
      const tick = base + (odd ? (k.grvTiming / 100) * res : 0);
      let dur = segSec * (1 + k.length / 64) * (odd ? 1 + k.grvGate / 100 : 1);
      if (single) dur = Math.min(dur, res * spt);
      const offset = startSec + idx * segSec;
      dur = Math.max(0.005, Math.min(dur, s.buffer.duration - offset));
      const vel = Math.max(0, Math.min(127, 127 + (odd ? (k.grvVelocity * 127) / 100 : 0)));
      const when = this.timeAt(tick);
      this.engine.play(t, s.buffer, {
        when, offset, duration: dur, velocity: vel, gateEnd: when + dur - 0.006, release: 0.006,
        attack: idx === 0 ? attackSec(k.attack) : 0.003, source: 'loop',
      });
    }
  }

  /** Schedule a COMPOSED LOOP or FREE note. */
  private playNote(t: Track, tick: number, gate: number, velocity: number, source: 'song' | 'roll'): Voice | null {
    const s = t.sample();
    if (!s) return null;
    const when = this.timeAt(tick);
    if (t.noteAssign() === 'single') {
      this.engine.killVoices(t.index, (v) => v.opts.source === source, when);
    }
    const sr = s.buffer.sampleRate;
    const rate = t.bpmTracking() === 'pitch' ? this.bpm / t.refBpm() : undefined;
    return this.engine.play(t, s.buffer, {
      when, offset: s.start / sr, duration: (s.end - s.start) / sr,
      rate, velocity: Math.max(0, Math.min(127, velocity)),
      gateEnd: this.timeAt(tick + Math.max(1, gate)), source,
    });
  }

  private suppressed(track: number, tick: number): boolean {
    if (this.liveRolls.has(track)) return true;
    return this.song().events().some((e) => e.type === 'roll' && e.track === track && tick >= e.tick && tick < e.tick + e.length);
  }

  private scheduleRoll(track: number, start: number, rate: number, vel: number, a: number, b: number, end: number): void {
    const t = this.track(track);
    for (let tick = start + Math.ceil((a - start) / rate) * rate; tick < Math.min(b, end); tick += rate) {
      this.playNote(t, tick, rate * 0.9, vel, 'roll');
    }
  }

  private scheduleLiveRoll(track: number, r: LiveRoll, to: number): void {
    const t = this.track(track);
    for (; r.next < to; r.next += r.rate) this.playNote(t, r.next, r.rate * 0.9, r.velocity, 'roll');
  }

  // =====================================================================
  // Pads

  /** PLAY pad function: note-on. */
  noteOn(i: number, velocity: number): void {
    const t = this.track(i);
    const s = t.sample();
    if (!isSampleTrack(i) || !s) return;
    if (!this.padSens() || t.kind === 'loop') velocity = 127;
    const recording = this.recording();

    if (recording && t.kind !== 'loop') {
      const tick = this.recTick(true);
      if (t.kind === 'composed') this.recordLoopNote(t, tick, velocity);
      else {
        const ev: SeqEvent = { type: 'note', tick, track: i, gate: 1, velocity };
        this.addRecEvent(ev);
        this.held.set(i, { onTick: tick, commit: (g) => (ev.gate = g) });
      }
    }

    // Sound it now.
    const sr = s.buffer.sampleRate;
    if (t.noteAssign() === 'single') this.engine.killVoices(i, (v) => v.opts.source === 'live');
    if (t.kind === 'loop') {
      // Holding a LOOP pad loops the sample at the current tempo (p.171).
      const spanSec = (s.end - s.start) / sr;
      const rate = t.bpmTracking() === 'pitch' ? spanSec / (t.loopLength() * PPQ * this.spt()) : undefined;
      this.engine.play(t, s.buffer, {
        when: this.engine.now, offset: s.start / sr, velocity, rate, source: 'live',
        loop: { start: s.start / sr, end: s.end / sr },
      });
    } else {
      const rate = t.bpmTracking() === 'pitch' ? this.bpm / t.refBpm() : undefined;
      this.engine.play(t, s.buffer, {
        when: this.engine.now, offset: s.start / sr, duration: (s.end - s.start) / sr, rate, velocity, source: 'live',
      });
    }
  }

  noteOff(i: number): void {
    const t = this.track(i);
    const h = this.held.get(i);
    if (h) {
      this.held.delete(i);
      h.commit?.(Math.max(1, Math.round(this.tickAt(this.engine.now) - h.onTick)));
    }
    const rel = releaseSec(t.knobs().release);
    for (const v of this.engine.voices(i)) if (v.opts.source === 'live') v.noteOff(this.engine.now, rel);
  }

  /** ROLL pad function (only while the sequencer runs). */
  rollOn(i: number, rateTicks: number, velocity: number): boolean {
    if (!this.running() || !isSampleTrack(i) || !this.track(i).sample()) return false;
    const now = Math.max(0, this.tickAt(this.engine.now));
    this.engine.killVoices(i, (v) => v.opts.source !== 'live');
    const start = Math.ceil(now);
    this.liveRolls.set(i, { start, next: start, rate: rateTicks, velocity: this.padSens() ? velocity : 127 });
    this.pump();
    return true;
  }

  rollOff(i: number): void {
    const r = this.liveRolls.get(i);
    if (!r) return;
    this.liveRolls.delete(i);
    const end = this.tickAt(this.engine.now);
    this.engine.killVoices(i, (v) => v.opts.source === 'roll' && v.opts.when > this.engine.now);
    if (this.recording() && end > r.start) {
      this.addRecEvent({ type: 'roll', tick: r.start, track: i, length: Math.round(end - r.start), rate: r.rate, velocity: r.velocity });
    }
    // Resume the track's normal playback from here.
    const t = this.track(i);
    if (this.running() && (t.kind === 'loop' || t.kind === 'composed')) {
      this.scheduleLoopTrack(t, Math.ceil(end), this.scheduledTo);
    }
  }

  /** ON/MUTE pad function. MASTER toggles every track. */
  toggleMute(i: number): boolean {
    const muted = !this.track(i).muted();
    this.setMuted(i, muted);
    if (this.recording()) this.addRecEvent({ type: 'mute', tick: this.recTick(true), track: i, muted });
    return muted;
  }

  setMuted(i: number, muted: boolean): void {
    const targets = i === MASTER ? this.song().tracks.map((t) => t.index) : [i];
    for (const t of targets) {
      this.track(t).muted.set(muted);
      this.engine.setMuted(t, muted);
    }
  }

  /** LOOP RESTART pad function (LOOP, COMPOSED LOOP and MASTER). */
  restartLoop(i: number): boolean {
    const t = this.track(i);
    if (!this.running() || (t.kind !== 'loop' && t.kind !== 'composed' && t.kind !== 'master')) return false;
    const tick = this.recording() ? this.recTick(true) : Math.max(0, this.tickAt(this.engine.now));
    if (this.recording()) this.addRecEvent({ type: 'restart', tick, track: i });
    for (const target of i === MASTER ? this.loopingTracks() : [i]) {
      this.engine.killVoices(target, (v) => v.opts.source === 'song' || v.opts.source === 'loop', this.timeAt(tick));
      this.loopAnchor[target] = tick;
      const tr = this.track(target);
      if (tr.sample()) {
        const wasResume = this.resume;
        this.resume = true;
        this.scheduleLoopTrack(tr, tick, Math.max(tick, this.scheduledTo));
        this.resume = wasResume;
      }
    }
    return true;
  }

  // =====================================================================
  // Knobs, scenes, markers

  setKnob(i: number, fn: KnobFn, value: number, record = true): number | null {
    const t = this.track(i);
    if (!supports(fn, t.kind)) return null;
    const v = clampKnob(fn, t.kind, value);
    t.knobs.update((k) => ({ ...k, [fn]: v }));
    this.engine.applyTrack(t);
    if (record && this.recording()) {
      const tick = this.recTick(!!KNOB_FNS[fn].quantized);
      const last = this.rec!.events.findLast((e) => e.type === 'knob' && e.track === i && e.fn === fn);
      if (last && last.tick === tick && last.type === 'knob') last.value = v;
      else this.addRecEvent({ type: 'knob', tick, track: i, fn, value: v });
    }
    return v;
  }

  setGrooveRes(i: number, res: number): void {
    this.track(i).grooveRes.set(res);
    if (this.recording()) this.addRecEvent({ type: 'grooveRes', tick: this.recTick(false), track: i, res });
  }

  /** Scenes can be stored only in PLAY or PLAY STANDBY (p.178). */
  storeScene(n: number): boolean {
    if (this.mode() !== 'play' && this.mode() !== 'playStandby') return false;
    const scene: Scene = { knobs: {}, mutes: {}, grooveRes: {} };
    for (const t of this.song().tracks) {
      if (isSampleTrack(t.index) && !t.sample()) continue;
      scene.knobs[t.index] = { ...t.knobs() };
      scene.mutes[t.index] = t.muted();
      if (isSampleTrack(t.index)) scene.grooveRes[t.index] = t.grooveRes();
    }
    this.song().scenes.update((s) => s.map((x, i) => (i === n ? scene : x)));
    return true;
  }

  /** Returns false for an empty scene. Recalls are recorded (unquantized) onto MASTER. */
  recallScene(n: number, record = true): boolean {
    const scene = this.song().scenes()[n];
    if (!scene) return false;
    for (const [idx, knobs] of Object.entries(scene.knobs)) {
      const t = this.track(+idx);
      t.knobs.set({ ...(knobs as Record<KnobFn, number>) });
      this.engine.applyTrack(t);
    }
    for (const [idx, muted] of Object.entries(scene.mutes)) {
      this.track(+idx).muted.set(muted);
      this.engine.setMuted(+idx, muted);
    }
    for (const [idx, res] of Object.entries(scene.grooveRes)) this.track(+idx).grooveRes.set(res);
    if (record && this.recording()) this.addRecEvent({ type: 'scene', tick: this.recTick(false), track: MASTER, scene: n });
    return true;
  }

  initScene(n: number): boolean {
    if (this.mode() !== 'play' && this.mode() !== 'playStandby') return false;
    this.song().scenes.update((s) => s.map((x, i) => (i === n ? null : x)));
    return true;
  }

  storeMarker(n: number): boolean {
    if (this.mode() !== 'play' && this.mode() !== 'playStandby') return false;
    const tick = this.running() ? Math.floor(this.tickAt(this.engine.now)) : this.position();
    this.song().markers.update((m) => m.map((x, i) => (i === n ? tick : x)));
    return true;
  }

  jumpMarker(n: number): boolean {
    const tick = this.song().markers()[n];
    if (tick == null || (this.mode() !== 'play' && this.mode() !== 'playStandby')) return false;
    this.setPosition(tick);
    return true;
  }

  // =====================================================================
  // Recording internals

  recording(): boolean {
    // A hit a hair early (e.g. right on the downbeat with no countdown) still counts.
    return this.mode() === 'rec' && !!this.rec && this.tickAt(this.engine.now) >= this.rec.start - PPQ / 8;
  }

  private recTick(quantized: boolean): number {
    const raw = this.tickAt(this.engine.now);
    const q = QUANTIZE_VALUES[this.quantize()];
    const t = quantized && q ? Math.round(raw / q.ticks) * q.ticks : Math.round(raw);
    return Math.max(this.rec!.start, t);
  }

  private addRecEvent(e: SeqEvent): void {
    this.rec!.events.push(e);
    this.rec!.keys.add(eventKey(e));
  }

  private recordLoopNote(t: Track, tick: number, velocity: number): void {
    const loopTicks = t.loopLength() * PPQ;
    const anchor = this.loopAnchor[t.index];
    const rel = (((tick - anchor) % loopTicks) + loopTicks) % loopTicks;
    if (this.recMode() === 'replace' && !this.rec!.clearedLoops.has(t.index)) {
      this.rec!.clearedLoops.add(t.index);
      t.loopNotes.set([]);
      this.engine.killVoices(t.index, (v) => v.opts.source === 'song' && v.opts.when > this.engine.now);
    }
    let note: LoopNote = { tick: rel, gate: 1, velocity };
    this.fresh.set(note, tick);
    t.loopNotes.update((ns) => [...ns.filter((n) => n.tick !== rel), note].sort((a, b) => a.tick - b.tick));
    this.held.set(t.index, {
      onTick: tick,
      commit: (gate) => {
        const updated = { ...note, gate };
        this.fresh.set(updated, tick);
        t.loopNotes.update((ns) => ns.map((n) => (n === note ? updated : n)));
        note = updated;
      },
    });
  }

  private finishPass(stopTick: number): void {
    const pass = this.rec!;
    for (const i of [...this.held.keys()]) this.noteOff(i);
    let events = this.song().events();
    if (this.recMode() === 'replace') {
      events = events.filter((e) => !(pass.keys.has(eventKey(e)) && e.tick >= pass.start && e.tick <= stopTick));
    }
    this.song().events.set([...events, ...pass.events].sort((a, b) => a.tick - b.tick));
    if (this.undo) {
      this.undo.after = this.snapshot();
      this.undoState.set('undo');
    }
  }

  private snapshot(): Snapshot {
    return {
      events: this.song().events().map((e) => ({ ...e })),
      loopNotes: this.song().tracks.map((t) => t.loopNotes().map((n) => ({ ...n }))),
    };
  }

  private restore(s: Snapshot): void {
    this.song().events.set(s.events.map((e) => ({ ...e })));
    this.song().tracks.forEach((t, i) => t.loopNotes.set(s.loopNotes[i].map((n) => ({ ...n }))));
  }
}

