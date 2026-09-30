import { signal } from '@angular/core';
import {
  EventKind, clearEvents, copyMeasures, copyTrackEvents, deleteMeasures, insertMeasures, kindsOn,
} from './core/edit';
import { ALL_KNOB_FNS, KNOB_FNS, KnobFn, supports } from './core/knob-functions';
import {
  AUDIO_IN, CLOCKS_PER_TICK, LoopNote, MASTER, MAX_MEASURES, MainPadFn, PPQ, SeqEvent, TrackKind,
  isSampleTrack, locate, measureTicks, tickOf, trackLabel,
} from './core/model';
import { Track } from './core/song';
import type { Job, JobContext, JobView } from './jobs';

/*
 * TRACK EDIT (Owner's Manual p.241–245) and EVENT EDIT (p.246–258).
 */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const m3 = (n: number) => String(n).padStart(3, '0');
/** Track names squeezed to fit after a prefix ("EDIT=AUDIOIN"). */
const short = (i: number) => (i === AUDIO_IN ? 'AUDIOIN' : trackLabel(i));

abstract class EditJob implements Job {
  constructor(protected readonly ctx: JobContext) {}

  abstract enter(): void;
  abstract view(): JobView;
  abstract ok(): void;

  protected get seq() {
    return this.ctx.host.seq;
  }

  protected get sel(): number {
    return this.ctx.host.lastTrack();
  }

  protected track(i = this.sel): Track {
    return this.seq.track(i);
  }

  protected events(): SeqEvent[] {
    return this.seq.song().events();
  }

  protected setEvents(es: SeqEvent[]): void {
    this.seq.song().events.set(es);
  }

  protected leave(): void {
    this.ctx.host.leaveJob();
  }

  protected no(msg: string): void {
    this.ctx.host.show(msg, '');
  }

  /** Song measure the sequencer is at (default for the measure jobs). */
  protected currentMeasure(): number {
    return locate(this.seq.song().meters(), Math.max(0, this.seq.position())).measure;
  }
}

// =====================================================================
// TRACK EDIT

/** TRACK COPY (p.241): sample, points, knobs, mute and TRACK SET settings; no sequence data. */
export class TrackCopyJob extends EditJob {
  private readonly step = signal<'source' | 'dest' | 'overwrite'>('source');
  private src = 0;

  enter(): void {
    this.step.set('source');
  }

  accepts(i: number): boolean {
    return this.step() !== 'overwrite' && isSampleTrack(i);
  }

  view(): JobView {
    switch (this.step()) {
      case 'source':
        return { top: 'SOURCE TRACK', value: trackLabel(this.sel), track: this.sel };
      case 'dest':
        return { top: 'DEST. TRACK', value: trackLabel(this.sel), track: this.sel };
      case 'overwrite':
        return { top: 'OVERWRITE?', value: trackLabel(this.sel), blinkTop: true, track: this.sel };
    }
  }

  ok(): void {
    const t = this.track();
    switch (this.step()) {
      case 'source':
        if (!t.sample()) return this.no('NO SAMPLE');
        this.src = t.index;
        return this.step.set('dest');
      case 'dest':
        if (t.sample()) return this.step.set('overwrite');
        return this.copy(t);
      case 'overwrite':
        return this.copy(t);
    }
  }

  private copy(dst: Track): void {
    const engine = this.ctx.host.engine;
    engine.killVoices(dst.index);
    dst.copyFrom(this.track(this.src));
    engine.applyTrack(dst);
    engine.setMuted(dst.index, dst.muted());
    this.leave();
  }

  back(): boolean {
    const s = this.step();
    if (s === 'source') return false;
    this.step.set(s === 'overwrite' ? 'dest' : 'source');
    return true;
  }
}

/** TRACK INIT (p.243): sample, events and settings, with no confirmation. */
export class TrackInitJob extends EditJob {
  enter(): void {}

  accepts(): boolean {
    return true;
  }

  view(): JobView {
    return { top: 'INIT TRACK', value: trackLabel(this.sel), track: this.sel };
  }

  ok(): void {
    const t = this.track();
    const engine = this.ctx.host.engine;
    engine.killVoices(t.index);
    t.init();
    this.setEvents(this.events().filter((e) => e.track !== t.index));
    engine.applyTrack(t);
    engine.setMuted(t.index, false);
    this.leave();
  }
}

/** EVENT COPY (p.243): all sequence data, between non-empty tracks of the same type. */
export class EventCopyJob extends EditJob {
  private readonly step = signal<'source' | 'dest' | 'overwrite'>('source');
  private src = 0;

  enter(): void {
    this.step.set('source');
  }

  accepts(i: number): boolean {
    if (!isSampleTrack(i) || this.step() === 'overwrite') return false;
    return this.step() === 'source' || this.track(i).kind === this.track(this.src).kind;
  }

  view(): JobView {
    const top = { source: 'SOURCE TRACK', dest: 'DEST. TRACK', overwrite: 'OVERWRITE?' }[this.step()];
    return { top, value: trackLabel(this.sel), blinkTop: this.step() === 'overwrite', track: this.sel };
  }

  ok(): void {
    const t = this.track();
    switch (this.step()) {
      case 'source':
        if (!t.sample()) return this.no('NO SAMPLE');
        this.src = t.index;
        this.step.set('dest');
        this.ctx.coerce();
        return;
      case 'dest':
        if (!t.sample()) return this.no('NO SAMPLE');
        if (this.seq.song().hasSequence(t.index)) return this.step.set('overwrite');
        return this.copy(t);
      case 'overwrite':
        return this.copy(t);
    }
  }

  private copy(dst: Track): void {
    this.setEvents(copyTrackEvents(this.events(), this.src, dst.index));
    if (dst.kind === 'composed') dst.loopNotes.set(this.track(this.src).loopNotes().map((n) => ({ ...n })));
    this.leave();
  }

  back(): boolean {
    const s = this.step();
    if (s === 'source') return false;
    this.step.set(s === 'overwrite' ? 'dest' : 'source');
    return true;
  }
}

/** EVENT INIT (p.245): all sequence data on one track. On MASTER that's every scene recall. */
export class EventInitJob extends EditJob {
  enter(): void {}

  accepts(): boolean {
    return true;
  }

  view(): JobView {
    return { top: 'INIT TRK SEQ', value: trackLabel(this.sel), track: this.sel };
  }

  ok(): void {
    const i = this.sel;
    this.setEvents(this.events().filter((e) => e.track !== i));
    this.track().loopNotes.set([]);
    this.leave();
  }
}

// =====================================================================
// EVENT EDIT

type PadKind = 'note' | 'mute' | 'roll' | 'restart' | 'scene';
const PAD_KIND_LABEL: Record<PadKind, string> = { note: 'NOTE', mute: 'MUTE', roll: 'ROLL', restart: 'LOOPRESTART', scene: 'SCENE' };
/** After "EVNT=" only seven characters fit. */
const kindShort = (k: PadKind) => (k === 'restart' ? 'LOOPRST' : PAD_KIND_LABEL[k]);
const PAD_FN_KIND: Partial<Record<MainPadFn, PadKind>> = { play: 'note', mute: 'mute', roll: 'roll', restart: 'restart' };

/** Pad-event kinds a track can hold (p.247). */
function padKinds(kind: TrackKind): PadKind[] {
  const out: PadKind[] = [];
  if (kind === 'composed' || kind === 'free') out.push('note');
  out.push('mute');
  if (kind === 'loop' || kind === 'composed' || kind === 'free') out.push('roll');
  if (kind === 'loop' || kind === 'composed' || kind === 'master') out.push('restart');
  if (kind === 'master') out.push('scene');
  return out;
}

/** One line of the LOCATION & VALUE event list. A roll shows as two entries, ON and OFF. */
interface Entry {
  tick: number;
  /** The event (or COMPOSED LOOP note) behind the entry. */
  ref: SeqEvent | LoopNote;
  off?: boolean;
}

/** LOCATION & VALUE (p.246): edit notes, or delete individual pad / scene events. */
export class LocationValueJob extends EditJob {
  private readonly step = signal<'track' | 'type' | 'edit'>('track');
  private readonly kind = signal<PadKind>('note');
  private readonly index = signal(0);
  private readonly field = signal(0);
  /** Bumped on every edit so the view re-reads the (mutable) entry list. */
  private readonly rev = signal(0);
  private snapshot: { events: SeqEvent[]; notes: LoopNote[]; track: number } | null = null;

  enter(): void {
    this.step.set('track');
  }

  accepts(): boolean {
    return this.step() === 'track';
  }

  private kinds(): PadKind[] {
    return padKinds(this.track().kind);
  }

  /** COMPOSED LOOP notes are edited in their loop (4/4 from the loop start); FREE notes on the song. */
  private get loopNotes(): boolean {
    return this.kind() === 'note' && this.track().kind === 'composed';
  }

  private meters(): readonly number[] {
    return this.loopNotes ? [] : this.seq.song().meters();
  }

  private entries(): Entry[] {
    this.rev();
    const t = this.track();
    if (this.loopNotes) return t.loopNotes().map((n) => ({ tick: n.tick, ref: n }));
    const out: Entry[] = [];
    for (const e of this.events()) {
      if (e.track !== t.index || e.type !== this.kind()) continue;
      out.push({ tick: e.tick, ref: e });
      if (e.type === 'roll') out.push({ tick: e.tick + e.length, ref: e, off: true });
    }
    return out.sort((a, b) => a.tick - b.tick);
  }

  view(): JobView {
    const i = this.sel;
    switch (this.step()) {
      case 'track':
        return { top: 'LOCATE&VALUE', value: `EDIT=${short(i)}`, track: i };
      case 'type':
        return { top: `EDIT=${short(i)}`, value: `EVNT=${kindShort(this.kind())}`, blinkValue: true, track: i };
    }
    const list = this.entries();
    const e = list[this.index()];
    if (!e) return { top: `EVNT=${kindShort(this.kind())}`, value: 'NO EVENTS', track: i };
    const at = locate(this.meters(), e.tick);
    const top = `M${m3(at.measure)}-${at.beat}-${m3(at.tick * CLOCKS_PER_TICK)}`;
    const note = `${this.index() + 1}/${list.length}`;
    const ref = e.ref as SeqEvent;
    switch (this.kind()) {
      case 'note': {
        const n = e.ref as LoopNote;
        const gate = `${String(Math.floor(n.gate / PPQ)).padStart(2, '0')}:${m3((n.gate % PPQ) * CLOCKS_PER_TICK)}`;
        const f = this.field();
        const ranges: [number, number][] = [[1, 4], [5, 6], [7, 10], [1, 4], [6, 8], [9, 12]];
        return {
          top, value: `V${m3(n.velocity)} G${gate}`, note, track: i,
          ...(f < 3 ? { topRange: ranges[f] } : { valueRange: ranges[f] }),
        };
      }
      case 'mute':
        return { top, value: ref.type === 'mute' && ref.muted ? 'MUTE' : 'ON', note, track: i };
      case 'roll':
        return { top, value: e.off ? 'ROLL OFF' : 'ROLL ON', note, track: i };
      case 'restart':
        return { top, value: 'LOOP RST', note, track: i };
      case 'scene':
        return { top, value: `SCENE ${ref.type === 'scene' ? 'TABCDEFG'[ref.scene] : ''}`, note, track: i };
    }
  }

  dial(step: number): void {
    if (this.step() === 'type') {
      const ks = this.kinds();
      this.kind.set(ks[(((ks.indexOf(this.kind()) + step) % ks.length) + ks.length) % ks.length]);
      return;
    }
    if (this.step() === 'edit' && this.kind() === 'note') this.editNote(step);
  }

  padFn(fn: MainPadFn): boolean {
    const k = PAD_FN_KIND[fn];
    if (this.step() === 'type' && k && this.kinds().includes(k)) this.kind.set(k);
    return true;
  }

  cursor(dir: -1 | 1): void {
    if (this.step() === 'edit' && this.kind() === 'note') this.field.update((f) => clamp(f + dir, 0, 5));
  }

  transport(dir: -1 | 1): void {
    if (this.step() !== 'edit') return;
    this.index.update((i) => clamp(i + dir, 0, Math.max(0, this.entries().length - 1)));
  }

  ok(): void {
    switch (this.step()) {
      case 'track':
        this.step.set('type');
        if (!this.kinds().includes(this.kind())) this.kind.set(this.kinds()[0]);
        return;
      case 'type':
        return this.startEdit();
      case 'edit':
        this.snapshot = null; // register the changes
        this.leave();
    }
  }

  private startEdit(): void {
    const t = this.track();
    this.snapshot = { events: this.events(), notes: t.loopNotes(), track: t.index };
    this.step.set('edit');
    this.field.set(0);
    // Start on the event nearest the current song location (p.248).
    const list = this.entries();
    const pos = Math.max(0, this.seq.position());
    const target = this.loopNotes ? pos % (t.loopLength() * PPQ) : pos;
    let best = 0;
    list.forEach((e, i) => {
      if (Math.abs(e.tick - target) < Math.abs(list[best].tick - target)) best = i;
    });
    this.index.set(best);
  }

  back(): boolean {
    if (this.step() === 'type') {
      this.step.set('track');
      return true;
    }
    if (this.step() === 'edit' && !this.entries().length) {
      this.restore();
      this.step.set('track'); // NO EVENTS: CANCEL goes back to the track (p.247)
      return true;
    }
    return false; // CANCEL while editing: everything back as it was, main screen
  }

  abort(): void {
    this.restore();
  }

  private restore(): void {
    const s = this.snapshot;
    if (!s) return;
    this.setEvents(s.events);
    this.track(s.track).loopNotes.set(s.notes);
    this.snapshot = null;
  }

  /** JOB-section key: delete the event shown (a roll goes as an ON/OFF pair, p.249). */
  defaultKey(): void {
    if (this.step() !== 'edit') return;
    const e = this.entries()[this.index()];
    if (!e) return;
    if (this.loopNotes) this.track().loopNotes.update((ns) => ns.filter((n) => n !== e.ref));
    else this.setEvents(this.events().filter((x) => x !== e.ref));
    this.rev.update((r) => r + 1);
    const n = this.entries().length;
    this.index.update((i) => clamp(i, 0, Math.max(0, n - 1)));
  }

  /** Note edits: location within its neighbours, velocity 0–127, gate up to the next note-on. */
  private editNote(step: number): void {
    const list = this.entries();
    const i = this.index();
    const e = list[i];
    if (!e) return;
    const n = e.ref as LoopNote;
    const prev = list[i - 1]?.ref as LoopNote | undefined;
    const next = list[i + 1]?.ref as LoopNote | undefined;
    const meters = this.meters();
    const lo = prev ? prev.tick + prev.gate : 0;
    const hi = (next ? next.tick : this.loopNotes ? this.track().loopLength() * PPQ : MAX_MEASURES * 16 * PPQ) - 1;
    let { tick, gate, velocity } = n;
    switch (this.field()) {
      case 0: {
        const at = locate(meters, tick);
        const m = clamp(at.measure + step, 1, MAX_MEASURES);
        tick = tickOf(meters, { ...at, measure: m, beat: Math.min(at.beat, measureTicks(meters, m) / PPQ) });
        break;
      }
      case 1:
        tick += step * PPQ;
        break;
      case 2:
        tick += step;
        break;
      case 3:
        velocity = clamp(velocity + step, 0, 127);
        break;
      case 4:
        gate += step * PPQ;
        break;
      case 5:
        gate += step;
        break;
    }
    tick = clamp(tick, lo, Math.max(lo, hi));
    gate = clamp(gate, 1, next ? Math.max(1, next.tick - tick) : 99 * PPQ + PPQ - 1);
    this.replaceNote(n, { tick, gate, velocity });
  }

  private replaceNote(old: LoopNote, v: LoopNote): void {
    if (this.loopNotes) {
      this.track().loopNotes.update((ns) => ns.map((x) => (x === old ? { ...v } : x)).sort((a, b) => a.tick - b.tick));
    } else {
      this.setEvents(this.events().map((x) => (x === (old as unknown as SeqEvent) ? { ...x, ...v } as SeqEvent : x))
        .sort((a, b) => a.tick - b.tick));
    }
    this.rev.update((r) => r + 1);
  }
}

/** NOTE CLEAR (p.250): every note on a COMPOSED LOOP or FREE track. */
export class NoteClearJob extends EditJob {
  enter(): void {}

  accepts(i: number): boolean {
    const k = this.track(i).kind;
    return k === 'composed' || k === 'free';
  }

  view(): JobView {
    return { top: 'NOTE CLEAR', value: `CLEAR=${trackLabel(this.sel)}`, track: this.sel };
  }

  ok(): void {
    const t = this.track();
    if (t.kind === 'composed') t.loopNotes.set([]);
    else this.setEvents(this.events().filter((e) => !(e.track === t.index && e.type === 'note')));
    this.leave();
  }
}

/** Two-measure range entry: the values can't cross; pushing one past the other moves both (p.252). */
class Range {
  readonly a = signal(1);
  readonly b = signal(1);
  readonly field = signal<0 | 1>(0);

  set(m: number): void {
    this.a.set(m);
    this.b.set(m);
    this.field.set(0);
  }

  dial(step: number): void {
    if (this.field() === 0) {
      const a = clamp(this.a() + step, 1, MAX_MEASURES);
      this.a.set(a);
      if (a > this.b()) this.b.set(a);
    } else {
      const b = clamp(this.b() + step, 1, MAX_MEASURES);
      this.b.set(b);
      if (b < this.a()) this.a.set(b);
    }
  }

  view(prefix = 'M'): Pick<JobView, 'value' | 'valueRange'> {
    const p = prefix.length;
    return {
      value: `${prefix}${m3(this.a())} - ${m3(this.b())}`,
      valueRange: this.field() === 0 ? [p, p + 3] : [p + 6, p + 9],
    };
  }
}

type ClearKind = EventKind | 'all';

/** EVENT CLEAR (p.251): one event type (or ALL but notes) over a range of measures. */
export class EventClearJob extends EditJob {
  private readonly step = signal<'track' | 'type' | 'range'>('track');
  private readonly kind = signal<ClearKind>('knob:level');
  private readonly range = new Range();

  enter(): void {
    this.step.set('track');
  }

  accepts(): boolean {
    return this.step() === 'track';
  }

  /** Kinds the selected track can hold, knob functions first; notes are never cleared here. */
  private kinds(): ClearKind[] {
    const k = this.track().kind;
    const knobs = ALL_KNOB_FNS.filter((f) => supports(f, k)).map((f) => `knob:${f}` as EventKind);
    const pads = padKinds(k).filter((p) => p !== 'note') as EventKind[];
    return [...knobs, ...pads, 'all'];
  }

  private label(k: ClearKind): string {
    if (k === 'all') return 'ALL';
    if (k.startsWith('knob:')) return KNOB_FNS[k.slice(5) as KnobFn].screen;
    return PAD_KIND_LABEL[k as PadKind];
  }

  view(): JobView {
    const i = this.sel;
    switch (this.step()) {
      case 'track':
        return { top: 'EVENT CLEAR', value: trackLabel(i), track: i };
      case 'type':
        return { top: `EVNT ${short(i)}`, value: this.label(this.kind()), blinkValue: true, track: i };
      case 'range':
        return { top: 'CLEAR RANGE', ...this.range.view(), track: i };
    }
  }

  dial(step: number): void {
    if (this.step() === 'range') return this.range.dial(step);
    if (this.step() !== 'type') return;
    const ks = this.kinds();
    this.kind.set(ks[(((ks.indexOf(this.kind()) + step) % ks.length) + ks.length) % ks.length]);
  }

  cursor(dir: -1 | 1): void {
    if (this.step() === 'range') this.range.field.set(dir < 0 ? 0 : 1);
  }

  knobFn(fn: KnobFn): boolean {
    if (this.step() === 'type' && this.kinds().includes(`knob:${fn}`)) this.kind.set(`knob:${fn}`);
    return true;
  }

  padFn(fn: MainPadFn): boolean {
    const k = PAD_FN_KIND[fn];
    if (this.step() === 'type' && k && this.kinds().includes(k)) this.kind.set(k);
    return true;
  }

  scene(): boolean {
    if (this.step() === 'type' && this.kinds().includes('scene')) this.kind.set('scene');
    return true;
  }

  ok(): void {
    switch (this.step()) {
      case 'track':
        this.step.set('type');
        if (!this.kinds().includes(this.kind())) this.kind.set(this.kinds()[0]);
        return;
      case 'type':
        this.range.set(1); // the first measure of the song, by default
        return this.step.set('range');
      case 'range': {
        const song = this.seq.song();
        this.setEvents(clearEvents(this.events(), song.meters(), this.sel, this.kind(), this.range.a(), this.range.b()));
        this.leave();
      }
    }
  }

  back(): boolean {
    if (this.step() === 'track') return false;
    this.step.set(this.step() === 'range' ? 'type' : 'track');
    return true;
  }
}

type MeasuresOp = 'add' | 'delete' | 'copy';
const MEASURES_LABEL: Record<MeasuresOp, string> = { add: 'ADD MEASURES', delete: 'DEL MEASURES', copy: 'CPY MEASURES' };
type MeasuresStep = 'menu' | 'add' | 'delete' | 'src' | 'from' | 'dst' | 'to';

/** MEASURES (p.253–258): ADD (with meter), DELETE, and COPY sequence data between tracks. */
export class MeasuresJob extends EditJob {
  private readonly step = signal<MeasuresStep>('menu');
  private readonly op = signal<MeasuresOp>('add');
  private readonly field = signal(0);
  private readonly add = signal({ at: 1, count: 1, beats: 4 });
  private readonly range = new Range();
  private readonly to = signal({ at: 1, times: 1 });
  private src = 0;

  enter(): void {
    this.step.set('menu');
  }

  accepts(i: number): boolean {
    if (this.step() === 'src') return true;
    if (this.step() !== 'dst') return false;
    // Same type only; AUDIO IN and MASTER can only copy onto themselves (p.258).
    if (this.src === AUDIO_IN || this.src === MASTER) return i === this.src;
    return this.track(i).kind === this.track(this.src).kind;
  }

  view(): JobView {
    const i = this.sel;
    switch (this.step()) {
      case 'menu':
        return { top: 'MEASURES', value: MEASURES_LABEL[this.op()], blinkValue: true, track: null };
      case 'add': {
        const { at, count, beats } = this.add();
        const r: [number, number][] = [[1, 4], [5, 8], [9, 12]];
        return { top: 'ADD MEASURES', value: `M${m3(at)} ${m3(count)} ${beats}/4`, valueRange: r[this.field()], track: null };
      }
      case 'delete':
        return { top: 'DEL MEASURES', ...this.range.view(), track: null };
      case 'src':
        return { top: 'SOURCE TRACK', value: trackLabel(i), track: i };
      case 'from':
        return { top: 'COPY FROM', ...this.range.view(), track: this.src };
      case 'dst':
        return { top: 'DEST. TRACK', value: trackLabel(i), track: i };
      case 'to': {
        const { at, times } = this.to();
        return { top: 'COPY TO', value: `M${m3(at)} ${m3(times)}`, valueRange: this.field() === 0 ? [1, 4] : [5, 8], track: i };
      }
    }
  }

  dial(step: number): void {
    const f = this.field();
    switch (this.step()) {
      case 'menu': {
        const ops: MeasuresOp[] = ['add', 'delete', 'copy'];
        this.op.set(ops[(((ops.indexOf(this.op()) + step) % 3) + 3) % 3]);
        return;
      }
      case 'add':
        this.add.update((v) =>
          f === 0 ? { ...v, at: clamp(v.at + step, 1, MAX_MEASURES) }
          : f === 1 ? { ...v, count: clamp(v.count + step, 1, MAX_MEASURES) }
          : { ...v, beats: clamp(v.beats + step, 1, 4) });
        return;
      case 'delete':
      case 'from':
        return this.range.dial(step);
      case 'to': {
        // Copies may not run past measure 999 (p.258).
        const len = this.range.b() - this.range.a() + 1;
        this.to.update((v) => f === 0
          ? { ...v, at: clamp(v.at + step, 1, MAX_MEASURES - len * v.times + 1) }
          : { ...v, times: clamp(v.times + step, 1, Math.floor((MAX_MEASURES - v.at + 1) / len)) });
      }
    }
  }

  cursor(dir: -1 | 1): void {
    switch (this.step()) {
      case 'add':
        return this.field.update((f) => clamp(f + dir, 0, 2));
      case 'to':
        return this.field.set(dir < 0 ? 0 : 1);
      case 'delete':
      case 'from':
        return this.range.field.set(dir < 0 ? 0 : 1);
    }
  }

  ok(): void {
    const song = this.seq.song();
    const cur = this.currentMeasure();
    switch (this.step()) {
      case 'menu':
        this.field.set(0);
        if (this.op() === 'add') {
          this.add.set({ at: cur, count: 1, beats: 4 });
          return this.step.set('add');
        }
        if (this.op() === 'delete') {
          this.range.set(cur);
          return this.step.set('delete');
        }
        return this.step.set('src');
      case 'add': {
        const { at, count, beats } = this.add();
        const r = insertMeasures(song.events(), song.meters(), song.markers(), at, count, beats);
        this.apply(r);
        return this.leave();
      }
      case 'delete': {
        const r = deleteMeasures(song.events(), song.meters(), song.markers(), this.range.a(), this.range.b());
        this.apply(r);
        return this.leave();
      }
      case 'src':
        this.src = this.sel;
        this.range.set(cur);
        return this.step.set('from');
      case 'from':
        this.ctx.host.lastTrack.set(this.src); // the source is the default destination
        return this.step.set('dst');
      case 'dst':
        this.field.set(0);
        this.to.set({ at: this.range.a(), times: 1 });
        return this.step.set('to');
      case 'to': {
        const { at, times } = this.to();
        this.setEvents(copyMeasures(song.events(), song.meters(), this.src, this.range.a(), this.range.b(), this.sel, at, times));
        return this.leave();
      }
    }
  }

  private apply(r: { events: SeqEvent[]; meters: number[]; markers: (number | null)[] }): void {
    const song = this.seq.song();
    song.events.set(r.events);
    song.meters.set(r.meters);
    song.markers.set(r.markers);
  }

  back(): boolean {
    const prev: Partial<Record<MeasuresStep, MeasuresStep>> = { add: 'menu', delete: 'menu', src: 'menu', from: 'src', dst: 'from', to: 'dst' };
    const p = prev[this.step()];
    if (!p) return false;
    this.step.set(p);
    return true;
  }
}
