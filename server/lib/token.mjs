// Short-lived, single-use, HMAC-SHA256 signed snippet tokens.
// Format: base64url(JSON payload) + "." + base64url(HMAC(payload)).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** Salted, truncated hash of a client IP; used in tokens and logs so raw IPs are never kept. */
export function hashIp(ip, salt) {
  return createHash('sha256').update(`${salt}:${ip}`).digest('base64url').slice(0, 22);
}

/**
 * @param {{ videoId: string, start: number, length: number, ipHash: string }} claims
 * @returns {{ token: string, payload: object }}
 */
export function signToken(claims, secret, ttlMs, now = Date.now()) {
  const payload = {
    jti: b64(randomBytes(12)),
    v: claims.videoId,
    s: claims.start,
    l: claims.length,
    ip: claims.ipHash,
    exp: now + ttlMs,
  };
  const body = b64(JSON.stringify(payload));
  const sig = b64(createHmac('sha256', secret).update(body).digest());
  return { token: `${body}.${sig}`, payload };
}

/**
 * Checks signature, expiry and client binding. Returns the payload, or throws an Error whose
 * `code` is token_missing | token_invalid | token_expired | token_ip_mismatch.
 */
export function verifyToken(token, secret, ipHash, now = Date.now()) {
  const fail = (code) => Object.assign(new Error(code), { code });
  if (!token || typeof token !== 'string') throw fail('token_missing');
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) throw fail('token_invalid');

  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw fail('token_invalid');

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw fail('token_invalid');
  }
  if (typeof payload?.exp !== 'number' || typeof payload.jti !== 'string') throw fail('token_invalid');
  if (payload.exp <= now) throw fail('token_expired');
  if (payload.ip !== ipHash) throw fail('token_ip_mismatch');
  return payload;
}

/** Remembers used token IDs until they would have expired anyway. */
export class UsedTokens {
  #seen = new Map(); // jti -> exp

  /** Marks the token used; returns false if it already was. */
  claim(jti, exp, now = Date.now()) {
    this.sweep(now);
    if (this.#seen.has(jti)) return false;
    this.#seen.set(jti, exp);
    return true;
  }

  sweep(now = Date.now()) {
    for (const [jti, exp] of this.#seen) if (exp <= now) this.#seen.delete(jti);
  }

  get size() {
    return this.#seen.size;
  }
}
