import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsedTokens, hashIp, signToken, verifyToken } from '../lib/token.mjs';

const SECRET = 'test-secret';
const ip = hashIp('203.0.113.7', 'salt');
const claims = { videoId: 'jNQXAC9IVRw', start: 12.5, length: 30, ipHash: ip };
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return 'no error';
};

test('a signed token verifies and round-trips its claims', () => {
  const now = 1_000_000;
  const { token } = signToken(claims, SECRET, 300_000, now);
  const p = verifyToken(token, SECRET, ip, now + 1000);
  assert.equal(p.v, 'jNQXAC9IVRw');
  assert.equal(p.s, 12.5);
  assert.equal(p.l, 30);
  assert.equal(p.exp, now + 300_000);
  assert.match(p.jti, /^[A-Za-z0-9_-]{16}$/);
});

test('missing and malformed tokens are rejected', () => {
  assert.equal(code(() => verifyToken(null, SECRET, ip)), 'token_missing');
  assert.equal(code(() => verifyToken('', SECRET, ip)), 'token_missing');
  assert.equal(code(() => verifyToken('abc', SECRET, ip)), 'token_invalid');
  assert.equal(code(() => verifyToken('a.b.c', SECRET, ip)), 'token_invalid');
});

test('expired tokens are rejected', () => {
  const { token } = signToken(claims, SECRET, 300_000, 0);
  assert.equal(code(() => verifyToken(token, SECRET, ip, 300_000)), 'token_expired');
});

test('tokens signed with another secret are rejected', () => {
  const { token } = signToken(claims, 'other-secret', 300_000);
  assert.equal(code(() => verifyToken(token, SECRET, ip)), 'token_invalid');
});

test('editing the payload breaks the signature', () => {
  const { token } = signToken(claims, SECRET, 300_000);
  const [body, sig] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  payload.l = 600; // try to stretch the snippet
  const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
  assert.equal(code(() => verifyToken(forged, SECRET, ip)), 'token_invalid');
});

test('tokens are bound to the client IP', () => {
  const { token } = signToken(claims, SECRET, 300_000);
  assert.equal(code(() => verifyToken(token, SECRET, hashIp('198.51.100.1', 'salt'))), 'token_ip_mismatch');
});

test('IP hashes are salted and never contain the raw IP', () => {
  assert.notEqual(hashIp('203.0.113.7', 'a'), hashIp('203.0.113.7', 'b'));
  assert.ok(!hashIp('203.0.113.7', 'a').includes('203'));
});

test('UsedTokens allows each token once and forgets it after expiry', () => {
  const used = new UsedTokens();
  assert.equal(used.claim('j1', 1000, 0), true);
  assert.equal(used.claim('j1', 1000, 500), false);
  assert.equal(used.claim('j2', 1000, 500), true);
  used.sweep(1000);
  assert.equal(used.size, 0);
});
