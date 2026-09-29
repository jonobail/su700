import { signal } from '@angular/core';
import { KnobFn, defaultKnobs } from './knob-functions';
import {
  BpmTracking, FilterType, LfoWave, LoopNote, MainPadFn, NoteAssign, SCENE_COUNT, Sample, Scene, SeqEvent,
  TRACK_COUNT, TrackKind, trackKind,
} from './model';

export class Track {
  readonly kind: TrackKind;
  readonly sample = signal<Sample | null>(null);
  readonly knobs: ReturnType<typeof signal<Record<KnobFn, number>>>;
  readonly muted = signal(false);

  // TRACK SET job settings
  readonly mainKnob = signal<KnobFn>('level');
  readonly mainPad: ReturnType<typeof signal<MainPadFn>>;
  readonly filterType = signal<FilterType>('LPF');
  readonly noteAssign = signal<NoteAssign>('multi');
  readonly bpmTracking: ReturnType<typeof signal<BpmTracking>>;
  /** Loop length in beats (LOOP and COMPOSED LOOP tracks). */
  readonly loopLength = signal(4);
  readonly lfoWave = signal<LfoWave>('sawDown');
  /** Tempo at which the sample plays at its own speed (reference for CHNG PITCH). */
  readonly refBpm = signal(120);
  /** Index into GROOVE_RES_VALUES; default 1/16. */
  readonly grooveRes = signal(2);

  /** COMPOSED LOOP phrase: note-ons relative to the loop start. */
  readonly loopNotes = signal<LoopNote[]>([]);

  constructor(readonly index: number) {
    this.kind = trackKind(index);
    this.knobs = signal(defaultKnobs(this.kind));
    this.mainPad = signal<MainPadFn>(this.kind === 'audioIn' || this.kind === 'master' ? 'none' : 'play');
    this.bpmTracking = signal<BpmTracking>(this.kind === 'loop' ? 'slice' : 'normal');
  }

  knob(fn: KnobFn): number {
    return this.knobs()[fn];
  }

  /** TRACK EDIT | TRACK INIT: drop the sample and reset every setting. */
  init(): void {
    const fresh = new Track(this.index);
    this.sample.set(null);
    this.knobs.set(fresh.knobs());
    this.muted.set(false);
    this.mainKnob.set(fresh.mainKnob());
    this.mainPad.set(fresh.mainPad());
    this.filterType.set(fresh.filterType());
    this.noteAssign.set(fresh.noteAssign());
    this.bpmTracking.set(fresh.bpmTracking());
    this.loopLength.set(4);
    this.lfoWave.set('sawDown');
    this.grooveRes.set(2);
    this.refBpm.set(120);
    this.loopNotes.set([]);
  }
}

export class Song {
  readonly name = signal('NEW SONG');
  readonly tracks = Array.from({ length: TRACK_COUNT }, (_, i) => new Track(i));
  /** Recorded sequence events, kept sorted by tick. */
  readonly events = signal<SeqEvent[]>([]);
  readonly scenes = signal<(Scene | null)[]>(new Array(SCENE_COUNT).fill(null));
  readonly markers = signal<(number | null)[]>(new Array(SCENE_COUNT).fill(null));
  readonly bpm = signal(120);

  constructor(readonly number: number) {}

  /** Last tick that holds any data, used to size the song. */
  isEmpty(): boolean {
    return this.events().length === 0 && this.tracks.every((t) => !t.sample());
  }
}
