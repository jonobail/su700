// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EFFECTS, EFFECT_RES, EFFECT_RES_DEFAULT, connectedElsewhere, defaultEffects, dialPage, effectDef, effectKnobActive,
  formatParam, pageView, resSeconds, reverbSeconds, setType, setupPages, toggleConnection,
} from '../src/app/core/effects.ts';
import { AUDIO_IN, MASTER } from '../src/app/core/model.ts';

test('the effect list: 43 types, modes and sync flags as on p.333–334', () => {
  assert.equal(EFFECTS.length, 43);
  assert.equal(new Set(EFFECTS.map((e) => e.id)).size, 43);
  const sys = EFFECTS.filter((e) => e.mode === 'sys').map((e) => e.id);
  assert.deepEqual(sys, ['AMPSIM', '3DELAY', '2DELAY', '1DELAY', 'X-DELAY', 'DLY+PAN', 'HALL', 'ROOM', 'STAGE', 'PLATE', 'CANYON']);
  assert.equal(effectDef('1DELAY').sync, true);
  assert.equal(effectDef('3DELAY').sync, false);
  for (const e of EFFECTS) {
    assert.ok(e.params.length >= 2 && e.params.length <= 5, e.id);
    for (const p of e.params) assert.ok(p.def >= p.min && p.def <= p.max, `${e.id} ${p.label}`);
  }
});

test('factory setup: AMPSIM, 1DELAY, HALL; LEVEL 100, PAN C, sends 0, resolution 1/2 (p.215, 219)', () => {
  const fx = defaultEffects();
  assert.deepEqual(fx.map((b) => b.type), ['AMPSIM', '1DELAY', 'HALL']);
  for (const b of fx) {
    assert.equal(b.level, 100);
    assert.equal(b.pan, 0);
    assert.equal(b.ef2 + b.ef3, 0);
    assert.equal(EFFECT_RES[b.res], '1/2');
  }
  assert.equal(EFFECT_RES[EFFECT_RES_DEFAULT], '1/2');
});

test('setup pages: effect, its parameters, LEVEL, PAN, then EF2 SEND on block 1 and EF3 SEND on blocks 1–2', () => {
  const fx = defaultEffects();
  const kinds = (bi: number) => setupPages(bi, fx[bi]).map((p) => p.kind);
  assert.deepEqual(kinds(0), ['type', 'param', 'param', 'param', 'param', 'param', 'level', 'pan', 'ef2', 'ef3']);
  assert.deepEqual(kinds(1), ['type', 'param', 'param', 'param', 'param', 'level', 'pan', 'ef3']); // 1DELAY has four
  assert.deepEqual(kinds(2), ['type', 'param', 'param', 'param', 'param', 'param', 'level', 'pan']);
});

test('dialing the type page resets parameters; other pages clamp to their ranges', () => {
  let fx = defaultEffects();
  fx = dialPage(fx, 2, { kind: 'type' }, -1); // HALL → DLY+PAN
  assert.equal(fx[2].type, 'DLY+PAN');
  assert.deepEqual(fx[2].params, effectDef('DLY+PAN').params.map((p) => p.def));
  fx = dialPage(fx, 0, { kind: 'level' }, 100);
  assert.equal(fx[0].level, 127);
  fx = dialPage(fx, 0, { kind: 'pan' }, -100);
  assert.equal(pageView(0, fx[0], { kind: 'pan' }).value, 'L64');
  // PHASER STAGE steps 4, 6, … 12.
  fx = setType(fx, 1, 'PHASER');
  fx = dialPage(fx, 1, { kind: 'param', index: 3 }, 1);
  assert.equal(fx[1].params[3], 10);
});

test('parameter display: raw numbers, D/W and E/R balances, named options', () => {
  const hall = effectDef('HALL');
  assert.equal(formatParam(hall.params[0], 10), '010');
  assert.equal(formatParam(hall.params[3], 0), 'E=R');
  assert.equal(formatParam(hall.params[3], -63), 'E63>R');
  const dist = effectDef('DIST');
  assert.equal(formatParam(dist.params[4], 63), 'D<W63');
  assert.equal(formatParam(effectDef('AMPSIM').params[1], 3), 'TUBE');
  assert.equal(formatParam(effectDef('FLANGER').params[3], -180), '-180');
});

test('insertion connections: one block per track, REPLACE? moves it, MASTER never connects (p.190, 218)', () => {
  let fx = setType(setType(defaultEffects(), 0, 'CHORUS'), 1, 'FLANGER');
  fx = toggleConnection(fx, 0, 3);
  assert.deepEqual(fx[0].connected, [3]);
  assert.equal(connectedElsewhere(fx, 1, 3), 0);
  assert.strictEqual(toggleConnection(fx, 1, 3), fx); // needs REPLACE? → OK
  fx = toggleConnection(fx, 1, 3, true);
  assert.deepEqual([fx[0].connected, fx[1].connected], [[], [3]]);
  fx = toggleConnection(fx, 1, AUDIO_IN);
  assert.deepEqual(fx[1].connected, [3, AUDIO_IN]);
  assert.strictEqual(toggleConnection(fx, 1, MASTER), fx);
  fx = toggleConnection(fx, 1, 3);
  assert.deepEqual(fx[1].connected, [AUDIO_IN]);
  // System blocks take no connections.
  assert.strictEqual(toggleConnection(fx, 2, 5), fx);
});

test('switching a block to insertion drops tracks already on another insertion block', () => {
  let fx = setType(defaultEffects(), 0, 'CHORUS');
  fx = toggleConnection(fx, 0, 4);
  fx = [...fx] as typeof fx;
  fx[2] = { ...fx[2], connected: [4, 5] }; // left over from an earlier insertion effect
  fx = setType(fx, 2, 'PHASER');
  assert.deepEqual(fx[2].connected, [5]);
});

test('EFFECT knobs: system → every track but MASTER; insertion → MASTER only (p.211)', () => {
  const fx = setType(defaultEffects(), 1, 'TREMOLO');
  assert.equal(effectKnobActive(fx[0], 0), true);
  assert.equal(effectKnobActive(fx[0], MASTER), false);
  assert.equal(effectKnobActive(fx[1], 0), false);
  assert.equal(effectKnobActive(fx[1], MASTER), true);
});

test('timing tables: resolution in seconds, XG reverb times', () => {
  assert.equal(resSeconds(EFFECT_RES.indexOf('1/2'), 120), 1);
  assert.equal(resSeconds(EFFECT_RES.indexOf('1/8'), 120), 0.25);
  assert.ok(Math.abs(reverbSeconds(0) - 0.3) < 1e-9);
  assert.ok(Math.abs(reverbSeconds(47) - 5) < 1e-9);
  assert.equal(reverbSeconds(57), 10);
  assert.equal(reverbSeconds(67), 20);
  assert.equal(reverbSeconds(69), 30);
});
