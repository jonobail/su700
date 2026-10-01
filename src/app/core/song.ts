import { signal } from '@angular/core';
import { EffectSetup, cloneEffects, defaultEffects } from './effects';
import { KnobFn, defaultKnobs, supports } from './knob-functions';
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

  /**
   * TRACK EDIT | TRACK COPY (p.241): the sample and its points, knob settings, mute, and the
   * TRACK SET settings. BPM TRACKING only carries over between tracks of the same type.
   */
  copyFrom(src: Track): void {
    this.sample.set(src.sample());
    this.knobs.set({ ...src.knobs() });
    this.muted.set(src.muted());
    this.mainKnob.set(supports(src.mainKnob(), this.kind) ? src.mainKnob() : 'level');
    this.mainPad.set(src.mainPad());
    this.filterType.set(src.filterType());
    this.noteAssign.set(src.noteAssign());
    this.lfoWave.set(src.lfoWave());
    this.grooveRes.set(src.grooveRes());
    this.refBpm.set(src.refBpm());
    if (src.kind === this.kind) {
      this.bpmTracking.set(src.bpmTracking());
      this.loopLength.set(src.loopLength());
    }
  }

  /** Everything, including the COMPOSED LOOP phrase (SONG | COPY). */
  cloneFrom(src: Track): void {
    this.copyFrom(src);
    this.bpmTracking.set(src.bpmTracking());
    this.loopLength.set(src.loopLength());
    this.loopNotes.set(src.loopNotes().map((n) => ({ ...n })));
  }
}

export const defaultSongName = (number: number) => `SONG${String(number).padStart(2, '0')}`;

export class Song {
  /** Up to eight characters; default SONGxx (p.228). */
  readonly name: ReturnType<typeof signal<string>>;
  readonly tracks = Array.from({ length: TRACK_COUNT }, (_, i) => new Track(i));
  /** Recorded sequence events, kept sorted by tick. */
  readonly events = signal<SeqEvent[]>([]);
  readonly scenes = signal<(Scene | null)[]>(new Array(SCENE_COUNT).fill(null));
  readonly markers = signal<(number | null)[]>(new Array(SCENE_COUNT).fill(null));
  readonly bpm = signal(120);
  /** Beats per measure for measures added with a meter (see `measureStart`). */
  readonly meters = signal<number[]>([]);
  /** SONG | MTC OFFSET: hours, minutes, seconds, frames (p.230). */
  readonly mtcOffset = signal<[number, number, number, number]>([0, 0, 0, 0]);
  /** The three effect blocks (EFFECT SETUP); back to the defaults whenever the song is entered (p.187). */
  readonly effects = signal<EffectSetup>(defaultEffects());

  constructor(readonly number: number) {
    this.name = signal(defaultSongName(number));
  }

  /** Whether the song holds anything worth an OVERWRITE? prompt. */
  isEmpty(): boolean {
    return this.events().length === 0 && this.tracks.every((t) => !t.sample() && !t.loopNotes().length) &&
      this.scenes().every((x) => !x) && this.markers().every((x) => x === null);
  }

  /** Recorded sequence data on a track (the six centre bars of its meter, p.244). */
  hasSequence(i: number): boolean {
    return this.tracks[i].loopNotes().length > 0 || this.events().some((e) => e.track === i);
  }

  /** SONG | COPY: all of the song's data (p.229). */
  copyFrom(src: Song, name: string): void {
    this.name.set(name);
    this.tracks.forEach((t, i) => t.cloneFrom(src.tracks[i]));
    this.events.set(src.events().map((e) => ({ ...e })));
    this.scenes.set(src.scenes().map((sc) => sc && structuredClone(sc)));
    this.markers.set([...src.markers()]);
    this.bpm.set(src.bpm());
    this.meters.set([...src.meters()]);
    this.mtcOffset.set([...src.mtcOffset()]);
    this.effects.set(cloneEffects(src.effects()));
  }
}
