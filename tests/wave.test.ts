// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  composedMinLength, impliedBpm, loopLengthRange, lowerRates, normalize, reverse, toEightBit, toMono, trim, zeroCross,
} from '../src/app/core/wave.ts';

const f = (...xs: number[]) => Float32Array.from(xs);

test('zeroCross snaps to the nearest sign change, preferring the travel direction', () => {
  const ch = f(0.5, 0.4, 0.3, -0.2, -0.4, -0.3, 0.1, 0.2);
  assert.equal(zeroCross(ch, 3), 3); // -0.2 after 0.3 is a crossing
  assert.equal(zeroCross(ch, 1), 0); // start of the buffer counts
  assert.equal(zeroCross(ch, 5, 1), 6);
  assert.equal(zeroCross(ch, 5, -1), 6); // nearest either way within reach
  assert.equal(zeroCross(ch, 4, -1), 3);
  assert.equal(zeroCross(ch, 99), 8); // clamped to the end
});

test('trim keeps only the playback span', () => {
  assert.deepEqual([...trim([f(1, 2, 3, 4, 5)], 1, 4)[0]], [2, 3, 4]);
});

test('reverse runs the waveform backwards without touching the input', () => {
  const src = [f(1, 2, 3)];
  assert.deepEqual([...reverse(src)[0]], [3, 2, 1]);
  assert.deepEqual([...src[0]], [1, 2, 3]);
});

test('normalize brings the peak to the rate and clips above full scale', () => {
  const [l, r] = normalize([f(0.25, -0.5), f(0.1, 0)], 100);
  assert.deepEqual([...l], [0.5, -1]);
  assert.ok(Math.abs(r[0] - 0.2) < 1e-6);
  assert.deepEqual([...normalize([f(0.5, -0.25)], 200)[0]], [1, -1]);
  assert.deepEqual([...normalize([f(0, 0)], 150)[0]], [0, 0]);
});

test('8-bit conversion quantises to 1/127 steps', () => {
  const [c] = toEightBit([f(0.5, 0.003, -1)]);
  assert.ok(Math.abs(c[0] - 64 / 127) < 1e-6);
  assert.equal(c[1], 0);
  assert.equal(c[2], -1);
});

test('stereo to mono modes', () => {
  const st = [f(1, 0.5), f(0.5, 0.5)];
  assert.deepEqual([...toMono(st, 'L')[0]], [1, 0.5]);
  assert.deepEqual([...toMono(st, 'R')[0]], [0.5, 0.5]);
  assert.ok(Math.abs(toMono(st, 'L+R')[0][0] - 1.5 * Math.SQRT1_2) < 1e-6);
  assert.deepEqual([...toMono(st, 'L-R')[0]], [0.5, 0]);
});

test('FREQ. CONVERT only goes down', () => {
  assert.deepEqual(lowerRates(44100), [22050, 11025]);
  assert.deepEqual(lowerRates(22050), [11025]);
  assert.deepEqual(lowerRates(11025), []);
});

test('LOOP track lengths keep the implied tempo within 40–299.9', () => {
  // A 2 s span: 4 beats plays at its own speed at 120 BPM.
  assert.equal(impliedBpm(2, 4), 120);
  assert.deepEqual(loopLengthRange(2, 40, 299.9), { min: 2, max: 9 });
  assert.equal(loopLengthRange(0.1, 40, 299.9), null); // under 1 beat even at 299.9
});

test('COMPOSED LOOP length cannot cut off the last note-on', () => {
  assert.equal(composedMinLength([], 96), 1);
  assert.equal(composedMinLength([{ tick: 0, gate: 1, velocity: 1 }, { tick: 96 * 6 + 10, gate: 1, velocity: 1 }], 96), 7);
});
