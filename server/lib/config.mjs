// Helper configuration, read once from the environment. See server/.env.example.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const binDir = path.join(here, '..', 'bin');

/** Cloudflare's always-pass test secret, used only outside production. */
export const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';

const bool = (v, def = false) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v));
const num = (v, def) => {
  const n = Number(v);
  return v === undefined || v === '' || !Number.isFinite(n) ? def : n;
};
/** A binary from $VAR, else server/bin, else PATH. */
const tool = (envVar, name) => {
  if (process.env[envVar]) return process.env[envVar];
  const local = path.join(binDir, process.platform === 'win32' ? `${name}.exe` : name);
  return existsSync(local) ? local : name;
};

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const cfg = {
    production,
    host: env.HOST || '127.0.0.1',
    port: num(env.PORT, 3700),

    disableYouTube: bool(env.DISABLE_YOUTUBE),
    allowFullDownload: bool(env.ALLOW_FULL_DOWNLOAD),
    maxVideoSeconds: num(env.MAX_VIDEO_SECONDS, 600),
    maxSnippetSeconds: num(env.MAX_SNIPPET_SECONDS, 30),
    maxConcurrent: num(env.MAX_CONCURRENT, 3),
    snippetTimeoutMs: num(env.SNIPPET_TIMEOUT_MS, 60_000),
    tokenTtlMs: num(env.TOKEN_TTL_SECONDS, 300) * 1000,

    rate: {
      tokensPerHour: num(env.RATE_TOKENS_PER_HOUR, 6),
      snippetMinutesPerDay: num(env.RATE_SNIPPET_MINUTES_PER_DAY, 30),
      globalSnippetsPerDay: num(env.RATE_GLOBAL_SNIPPETS_PER_DAY, 500),
    },

    // Outside production, missing secrets fall back to throwaway values so `npm run server`
    // needs no setup. In production they are required (checked below).
    tokenSecret: env.TOKEN_SECRET || (production ? '' : randomBytes(32).toString('hex')),
    turnstileSecret: env.TURNSTILE_SECRET || (production ? '' : TURNSTILE_TEST_SECRET),
    ipSalt: env.IP_HASH_SALT || randomBytes(16).toString('hex'),

    trustCloudflare: bool(env.TRUST_CLOUDFLARE),
    trustProxy: bool(env.TRUST_PROXY),
    /** null = allow any origin (development only). */
    allowedOrigins: env.ALLOWED_ORIGINS
      ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
      : null,

    ytdlp: tool('YTDLP', 'yt-dlp'),
    ffmpeg: tool('FFMPEG', 'ffmpeg'),
    deno: tool('DENO', 'deno'),
  };

  if (production) {
    const missing = [
      !cfg.tokenSecret && 'TOKEN_SECRET',
      !cfg.turnstileSecret && 'TURNSTILE_SECRET',
      !cfg.allowedOrigins && 'ALLOWED_ORIGINS',
    ].filter(Boolean);
    if (missing.length) throw new Error(`Missing required settings for production: ${missing.join(', ')}`);
    if (cfg.turnstileSecret === TURNSTILE_TEST_SECRET) throw new Error('TURNSTILE_SECRET is the public test secret');
  }
  return cfg;
}
