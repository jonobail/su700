/*
 * Sequence-data edits behind the TRACK EDIT and EVENT EDIT jobs (Owner's Manual p.241–258).
 * Pure functions over the event list and meter map, so they're tested outside the browser.
 */
import { MAX_MEASURES, PPQ, measureStart } from './model.ts';
import type { SeqEvent } from './model.ts';

/** Event categories as the EVENT EDIT screens name them. Knob events are per function. */
export type EventKind = 'note' | 'mute' | 'roll' | 'restart' | 'scene' | `knob:${string}` | 'grooveRes';

export function kindOf(e: SeqEvent): EventKind {
  return e.type === 'knob' ? `knob:${e.fn}` : e.type;
}

const sortByTick = (es: SeqEvent[]) => es.sort((a, b) => a.tick - b.tick);

/** Tick span of measures a..b inclusive. */
export function measureSpan(meters: readonly number[], a: number, b: number): [number, number] {
  return [measureStart(meters, a), measureStart(meters, b + 1)];
}

export interface MeasureEdit {
  events: SeqEvent[];
  meters: number[];
  markers: (number | null)[];
}

/**
 * ADD MEASURES (p.253): `count` empty measures of `beats` beats inserted before measure `at`,
 * on every track. Everything from that point moves later.
 */
export function insertMeasures(
  events: readonly SeqEvent[], meters: readonly number[], markers: readonly (number | null)[],
  at: number, count: number, beats: number,
): MeasureEdit {
  const start = measureStart(meters, at);
  const len = count * beats * PPQ;
  const shifted = (t: number) => (t >= start ? t + len : t);
  const m = [...meters];
  while (m.length < at - 1) m.push(4);
  m.splice(at - 1, 0, ...new Array(count).fill(beats));
  return {
    events: events.map((e) => ({ ...e, tick: shifted(e.tick) })),
    meters: trimMeters(m),
    markers: markers.map((t) => (t === null ? null : shifted(t))),
  };
}

/**
 * DELETE MEASURES (p.255): measures a..b go from every track and later measures close the gap.
 * FREE-track notes in the range are lost; COMPOSED LOOP phrases aren't touched.
 */
export function deleteMeasures(
  events: readonly SeqEvent[], meters: readonly number[], markers: readonly (number | null)[], a: number, b: number,
): MeasureEdit {
  const [s, e] = measureSpan(meters, a, b);
  const len = e - s;
  const out: SeqEvent[] = [];
  for (const ev of events) {
    if (ev.tick >= s && ev.tick < e) continue;
    if (ev.tick >= e) out.push({ ...ev, tick: ev.tick - len });
    else if (ev.type === 'roll' && ev.tick + ev.length > s) out.push({ ...ev, length: s - ev.tick }); // cut at the gap
    else out.push({ ...ev });
  }
  const m = [...meters];
  m.splice(a - 1, b - a + 1);
  return {
    events: out,
    meters: trimMeters(m),
    markers: markers.map((t) => (t === null ? null : t >= e ? t - len : t >= s ? s : t)),
  };
}

/**
 * COPY MEASURES (p.256): every event except notes from measures a..b of `src` is written `times`
 * times from measure `to` of `dst`, replacing the non-note events already there.
 */
export function copyMeasures(
  events: readonly SeqEvent[], meters: readonly number[],
  src: number, a: number, b: number, dst: number, to: number, times: number,
): SeqEvent[] {
  const [s, e] = measureSpan(meters, a, b);
  const len = e - s;
  const d = measureStart(meters, to);
  const end = d + len * times;
  const segment = events.filter((ev) => ev.track === src && ev.type !== 'note' && ev.tick >= s && ev.tick < e);
  const kept = events.filter((ev) => !(ev.track === dst && ev.type !== 'note' && ev.tick >= d && ev.tick < end));
  const copies = Array.from({ length: times }, (_, k) =>
    segment.map((ev) => ({ ...ev, track: dst, tick: ev.tick - s + d + k * len }) as SeqEvent)).flat();
  return sortByTick([...kept.map((ev) => ({ ...ev })), ...copies]);
}

/**
 * EVENT CLEAR (p.251): every event of `kind` on the track within measures a..b. 'all' means every
 * kind except notes.
 */
export function clearEvents(
  events: readonly SeqEvent[], meters: readonly number[], track: number, kind: EventKind | 'all', a: number, b: number,
): SeqEvent[] {
  const [s, e] = measureSpan(meters, a, b);
  return events.filter((ev) => {
    if (ev.track !== track || ev.tick < s || ev.tick >= e) return true;
    return kind === 'all' ? ev.type === 'note' : kindOf(ev) !== kind;
  });
}

/** EVENT COPY (p.243): the destination's events are replaced by the source's. */
export function copyTrackEvents(events: readonly SeqEvent[], src: number, dst: number): SeqEvent[] {
  const kept = events.filter((e) => e.track !== dst).map((e) => ({ ...e }));
  const copies = events.filter((e) => e.track === src).map((e) => ({ ...e, track: dst }) as SeqEvent);
  return sortByTick([...kept, ...copies]);
}

/** Event kinds present on a track (for NO EVENTS and the EVNT= choices). */
export function kindsOn(events: readonly SeqEvent[], track: number): Set<EventKind> {
  return new Set(events.filter((e) => e.track === track).map(kindOf));
}

const trimMeters = (m: number[]) => {
  while (m.length && m[m.length - 1] === 4) m.pop();
  return m.slice(0, MAX_MEASURES);
};
