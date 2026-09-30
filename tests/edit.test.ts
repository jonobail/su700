// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearEvents, copyMeasures, copyTrackEvents, deleteMeasures, insertMeasures, kindsOn } from '../src/app/core/edit.ts';
import { PPQ, TICKS_PER_MEASURE as BAR, locate, measureStart, tickOf } from '../src/app/core/model.ts';
import type { SeqEvent } from '../src/app/core/model.ts';

const knob = (tick: number, track = 0, fn = 'level', value = 1): SeqEvent => ({ type: 'knob', tick, track, fn, value });
const note = (tick: number, track = 6): SeqEvent => ({ type: 'note', tick, track, gate: 10, velocity: 100 });

test('meter map: 4/4 by default, added measures change the grid', () => {
  assert.equal(measureStart([], 3), 2 * BAR);
  assert.deepEqual(locate([], BAR + PPQ + 5), { measure: 2, beat: 2, tick: 5 });
  const meters = [4, 4, 2, 2]; // measures 3-4 are 2/4
  assert.equal(measureStart(meters, 5), 2 * BAR + 4 * PPQ);
  assert.deepEqual(locate(meters, 2 * BAR + 2 * PPQ), { measure: 4, beat: 1, tick: 0 });
  assert.deepEqual(locate(meters, 2 * BAR + 4 * PPQ + BAR), { measure: 6, beat: 1, tick: 0 });
  assert.equal(tickOf(meters, { measure: 6, beat: 2, tick: 3 }), 3 * BAR + 4 * PPQ + PPQ + 3);
  assert.deepEqual(locate([], -1), { measure: -1, beat: 4, tick: PPQ - 1 }); // countdown
});

test('ADD MEASURES shifts later events and markers, and records the meter', () => {
  // The manual's example: four 2/4 measures inserted at measure 3.
  const r = insertMeasures([knob(0), knob(2 * BAR), note(2 * BAR + 5)], [], [2 * BAR, null, 10], 3, 4, 2);
  assert.deepEqual(r.meters, [4, 4, 2, 2, 2, 2]);
  const len = 4 * 2 * PPQ;
  assert.deepEqual(r.events.map((e) => e.tick), [0, 2 * BAR + len, 2 * BAR + 5 + len]);
  assert.deepEqual(r.markers, [2 * BAR + len, null, 10]);
  assert.deepEqual(locate(r.meters, 2 * BAR + len), { measure: 7, beat: 1, tick: 0 });
  assert.deepEqual(insertMeasures([], [], [], 1, 2, 4).meters, []); // 4/4 needs no entries
});

test('DELETE MEASURES drops the range and closes the gap', () => {
  const ev = [knob(0), knob(BAR + 1), note(BAR + 2), knob(3 * BAR),
    { type: 'roll', tick: BAR - 10, track: 1, length: 50, rate: 24, velocity: 127 } as SeqEvent];
  const r = deleteMeasures(ev, [], [BAR + 1, 3 * BAR], 2, 2);
  assert.deepEqual(r.events.map((e) => [e.type, e.tick]), [['knob', 0], ['knob', 2 * BAR], ['roll', BAR - 10]]);
  assert.equal((r.events[2] as { length: number }).length, 10);
  assert.deepEqual(r.markers, [BAR, 2 * BAR]);
  assert.deepEqual(deleteMeasures([], [4, 2, 3], [], 2, 2).meters, [4, 3]);
});

test('COPY MEASURES repeats non-note events and replaces what was there', () => {
  // Measure 2 of track 0 copied three times from measure 10 of track 1 (same type in the job).
  const ev = [knob(BAR + 5, 0, 'pan', 7), note(BAR + 6, 0), knob(9 * BAR + 1, 1, 'level', 9), knob(20 * BAR, 1)];
  const out = copyMeasures(ev, [], 0, 2, 2, 1, 10, 3);
  const onDst = out.filter((e) => e.track === 1).map((e) => [e.tick, e.type === 'knob' && e.fn]);
  assert.deepEqual(onDst, [[9 * BAR + 5, 'pan'], [10 * BAR + 5, 'pan'], [11 * BAR + 5, 'pan'], [20 * BAR, 'level']]);
  assert.equal(out.filter((e) => e.track === 0).length, 2); // source untouched, note not copied
});

test('EVENT CLEAR removes one kind over a range, ALL spares notes', () => {
  const ev = [knob(0), knob(1, 0, 'pan'), note(2, 0), { type: 'mute', tick: 3, track: 0, muted: true } as SeqEvent, knob(BAR)];
  assert.deepEqual(clearEvents(ev, [], 0, 'knob:level', 1, 1).map((e) => e.tick), [1, 2, 3, BAR]);
  assert.deepEqual(clearEvents(ev, [], 0, 'all', 1, 1).map((e) => e.type), ['note', 'knob']);
  assert.deepEqual([...kindsOn(ev, 0)].sort(), ['knob:level', 'knob:pan', 'mute', 'note']);
});

test('EVENT COPY replaces the destination track\'s events', () => {
  const out = copyTrackEvents([knob(0, 2), knob(5, 3), note(9, 2)], 2, 3);
  assert.deepEqual(out.filter((e) => e.track === 3).map((e) => [e.type, e.tick]), [['knob', 0], ['note', 9]]);
  assert.equal(out.filter((e) => e.track === 2).length, 2);
});
