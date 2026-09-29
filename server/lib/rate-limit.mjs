// In-memory rolling-window rate limits. State is lost on restart, which is acceptable for a
// single small helper instance.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export class RateLimiter {
  /**
   * @param {{ tokensPerHour: number, snippetMinutesPerDay: number, globalSnippetsPerDay: number }} limits
   * @param {() => number} now  injectable clock (tests)
   */
  constructor(limits, now = Date.now) {
    this.limits = limits;
    this.now = now;
    /** ipHash -> token issue times */
    this.tokens = new Map();
    /** ipHash -> [{ t, seconds }] snippet time reserved per token */
    this.seconds = new Map();
    /** snippet serve times, all clients */
    this.global = [];
  }

  /**
   * Can this client get a token for a `length`-second snippet? Returns null if allowed, or a
   * reason: 'tokens_per_hour' | 'snippet_minutes_per_day' | 'global_daily_cap'.
   */
  check(ipHash, length) {
    const now = this.now();
    if (this.#globalCount(now) >= this.limits.globalSnippetsPerDay) return 'global_daily_cap';
    if (this.#recent(this.tokens, ipHash, now - HOUR).length >= this.limits.tokensPerHour) return 'tokens_per_hour';
    const used = this.#recent(this.seconds, ipHash, now - DAY).reduce((n, e) => n + e.seconds, 0);
    if (used + length > this.limits.snippetMinutesPerDay * 60) return 'snippet_minutes_per_day';
    return null;
  }

  /** Record a token issued for a `length`-second snippet (reserves the snippet time). */
  recordToken(ipHash, length) {
    const t = this.now();
    push(this.tokens, ipHash, t);
    push(this.seconds, ipHash, { t, seconds: length });
  }

  /** Record a snippet actually served (counts toward the global daily cap). */
  recordSnippet() {
    this.global.push(this.now());
  }

  globalCapReached() {
    return this.#globalCount(this.now()) >= this.limits.globalSnippetsPerDay;
  }

  /** Seconds until this client can request another token (for Retry-After). */
  retryAfter(ipHash, reason) {
    const now = this.now();
    if (reason === 'tokens_per_hour') {
      const oldest = this.#recent(this.tokens, ipHash, now - HOUR)[0];
      return Math.ceil(((oldest ?? now) + HOUR - now) / 1000);
    }
    if (reason === 'snippet_minutes_per_day') {
      const oldest = this.#recent(this.seconds, ipHash, now - DAY)[0];
      return Math.ceil(((oldest?.t ?? now) + DAY - now) / 1000);
    }
    return Math.ceil(((this.global[0] ?? now) + DAY - now) / 1000);
  }

  /** Drop expired entries so memory stays bounded. */
  sweep() {
    const now = this.now();
    for (const [k] of this.tokens) this.#recent(this.tokens, k, now - HOUR);
    for (const [k] of this.seconds) this.#recent(this.seconds, k, now - DAY);
    this.#globalCount(now);
  }

  #recent(map, key, since) {
    const list = (map.get(key) ?? []).filter((e) => (typeof e === 'number' ? e : e.t) > since);
    if (list.length) map.set(key, list);
    else map.delete(key);
    return list;
  }

  #globalCount(now) {
    while (this.global.length && this.global[0] <= now - DAY) this.global.shift();
    return this.global.length;
  }
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
