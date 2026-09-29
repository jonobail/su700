// SU700 YouTube helper.
//
// Serves short WAV snippets (≤ MAX_SNIPPET_SECONDS) of YouTube videos to the SU700 web app.
// Visitors preview the video in YouTube's own embedded player; this server never returns a
// full track (unless ALLOW_FULL_DOWNLOAD=true, meant for local use only).
//
//   GET  /api/health               { youtube: boolean, maxSnippetSeconds }
//   POST /api/token                { videoId, start, length, turnstileToken } → { token, title, start, length }
//   GET  /api/snippet?token=…      audio/wav, single use
//
// Configuration: see .env.example. No npm dependencies; needs yt-dlp and ffmpeg (npm run setup:tools).
import { createServer } from 'node:http';
import { loadConfig } from './lib/config.mjs';
import { clientIp, cors, fail, json, log, readJson, verifyTurnstile } from './lib/http.mjs';
import { RateLimiter } from './lib/rate-limit.mjs';
import { UsedTokens, hashIp, signToken, verifyToken } from './lib/token.mjs';
import { VIDEO_ID_RE, YouTube, toolsAvailable } from './lib/youtube.mjs';

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(`SU700 helper: ${e.message}. See server/.env.example.`);
  process.exit(1);
}
const yt = new YouTube(cfg);
const limiter = new RateLimiter(cfg.rate);
const usedTokens = new UsedTokens();
let toolsOk = false;
let active = 0;

/** WAV header + LIST chunk slack; the payload itself is 4 bytes per stereo 16-bit frame. */
const maxSnippetBytes = (seconds) => 4096 + Math.ceil(seconds * 44100) * 4;

const youtubeEnabled = () => !cfg.disableYouTube && toolsOk && !limiter.globalCapReached();

setInterval(() => {
  limiter.sweep();
  usedTokens.sweep();
}, 60_000).unref();

const RATE_MESSAGES = {
  tokens_per_hour: `Rate limit: ${cfg.rate.tokensPerHour} samples per hour. Try again later.`,
  snippet_minutes_per_day: `Rate limit: ${cfg.rate.snippetMinutesPerDay} minutes of samples per day. Try again tomorrow.`,
  global_daily_cap: 'YouTube sampling has hit its daily limit. Try again tomorrow.',
};

// ---------------------------------------------------------------------------

async function handleToken(req, res, ip, entry) {
  if (!youtubeEnabled()) return fail(res, 503, 'youtube_disabled', 'YouTube sampling is offline right now.');

  const body = await readJson(req);
  const { videoId, turnstileToken } = body;
  const start = Number(body.start);
  let length = Number(body.length);
  Object.assign(entry, { videoId: typeof videoId === 'string' ? videoId.slice(0, 11) : undefined, start, length });

  if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) return fail(res, 400, 'bad_video_id', 'Invalid video ID.');
  if (!Number.isFinite(start) || start < 0) return fail(res, 400, 'bad_request', 'Invalid start time.');
  if (!Number.isFinite(length) || length <= 0) return fail(res, 400, 'bad_request', 'Invalid length.');
  length = Math.min(length, cfg.maxSnippetSeconds);

  // Cheap checks before spending a Turnstile verification or a yt-dlp run.
  const pre = limiter.check(ip, length);
  if (pre) return rateLimited(res, ip, pre);
  if (!(await verifyTurnstile(cfg.turnstileSecret, turnstileToken, entry.rawIp))) {
    return fail(res, 403, 'turnstile_failed', 'Bot check failed. Reload the page and try again.');
  }

  let meta;
  try {
    meta = await yt.metadata(videoId);
  } catch (e) {
    return fail(res, 502, 'upstream', `Couldn't read that video: ${e.message}`);
  }
  if (meta.live) return fail(res, 422, 'live_video', "Live streams can't be sampled.");
  if (!meta.duration || meta.duration > cfg.maxVideoSeconds) {
    return fail(res, 422, 'video_too_long', `Videos must be ${fmtDuration(cfg.maxVideoSeconds)} or shorter.`);
  }
  if (start >= meta.duration) return fail(res, 422, 'start_past_end', 'The start point is past the end of the video.');
  length = Math.round(Math.min(length, meta.duration - start) * 1000) / 1000;
  entry.length = length;

  const reason = limiter.check(ip, length);
  if (reason) return rateLimited(res, ip, reason);
  limiter.recordToken(ip, length);

  const { token, payload } = signToken({ videoId, start, length, ipHash: ip }, cfg.tokenSecret, cfg.tokenTtlMs);
  entry.result = 'token';
  json(res, 200, { token, title: meta.title, start, length, expiresAt: payload.exp });
}

const fmtDuration = (sec) => (sec < 60 ? `${sec} seconds` : `${Math.round(sec / 60)} minutes`);

function rateLimited(res, ip, reason) {
  const status = reason === 'global_daily_cap' ? 503 : 429;
  const code = reason === 'global_daily_cap' ? 'daily_cap' : 'rate_limited';
  return fail(res, status, code, RATE_MESSAGES[reason], { 'Retry-After': String(limiter.retryAfter(ip, reason)) });
}

async function handleSnippet(req, res, ip, url, entry) {
  let payload;
  try {
    payload = verifyToken(url.searchParams.get('token'), cfg.tokenSecret, ip);
  } catch (e) {
    const expired = e.code === 'token_expired';
    return fail(res, 401, e.code, expired ? 'That sample request expired. Press SAMPLE again.' : 'Missing or invalid sample token.');
  }
  Object.assign(entry, { videoId: payload.v, start: payload.s, length: payload.l });
  if (!youtubeEnabled()) return fail(res, 503, 'youtube_disabled', 'YouTube sampling is offline right now.');
  // Check capacity before consuming the token, so a busy server doesn't burn it.
  if (active >= cfg.maxConcurrent) {
    return fail(res, 503, 'busy', 'The sampler is busy. Try again in a moment.', { 'Retry-After': '5' });
  }
  if (!usedTokens.claim(payload.jti, payload.exp)) return fail(res, 401, 'token_used', 'That sample token was already used.');

  const length = Math.min(payload.l, cfg.maxSnippetSeconds); // belt and braces
  // Track disconnects from the start: the client may give up during the yt-dlp lookup.
  const client = { gone: false };
  res.on('close', () => {
    if (!res.writableFinished) client.gone = true;
  });
  active++;
  try {
    entry.result = await streamSnippet(req, res, client, payload.v, payload.s, length);
    if (entry.result === 'ok') limiter.recordSnippet();
  } finally {
    active--;
  }
}

/** Runs ffmpeg and pipes WAV to the response. Retries once with a fresh stream URL. */
async function streamSnippet(req, res, client, videoId, start, length, retry = true) {
  let mediaUrl;
  try {
    mediaUrl = await yt.streamUrl(videoId);
  } catch (e) {
    fail(res, 502, 'upstream', `Couldn't reach that video: ${e.message}`);
    return 'upstream_error';
  }
  if (client.gone) return 'client_closed'; // don't start ffmpeg for nobody

  return new Promise((resolve) => {
    const ff = yt.spawnSnippet(mediaUrl, start, length);
    const limit = maxSnippetBytes(length);
    let bytes = 0;
    let stderr = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      ff.kill('SIGKILL');
      if (res.headersSent) res.destroy();
      else fail(res, 504, 'timeout', 'Sampling took too long. Try again.');
      finish('timeout');
    }, cfg.snippetTimeoutMs);

    ff.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    ff.stdout.on('data', (chunk) => {
      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
      }
      bytes += chunk.length;
      if (bytes > limit) {
        // Never send more than the snippet cap, whatever ffmpeg does.
        ff.kill('SIGKILL');
        res.end();
        return finish('capped');
      }
      if (!res.write(chunk)) ff.stdout.pause();
    });
    res.on('drain', () => ff.stdout.resume());
    res.on('close', () => {
      if (!res.writableFinished) {
        ff.kill('SIGKILL'); // client went away
        finish('client_closed');
      }
    });
    ff.on('error', () => {
      fail(res, 502, 'upstream', 'ffmpeg not found — run "npm run setup:tools".');
      finish('ffmpeg_missing');
    });
    ff.on('close', async (code) => {
      if (done) return;
      if (bytes > 0) {
        res.end();
        return finish(code === 0 ? 'ok' : 'partial');
      }
      // Nothing produced: the cached stream URL may have gone stale.
      if (retry && !res.headersSent) {
        clearTimeout(timer);
        done = true;
        yt.forgetStream(videoId);
        return resolve(await streamSnippet(req, res, client, videoId, start, length, false));
      }
      fail(res, 502, 'upstream', `Couldn't decode that video${stderr ? `: ${stderr.trim().split('\n').pop()}` : '.'}`);
      finish('ffmpeg_error');
    });
  });
}

/** Legacy whole-track endpoints (local use only, ALLOW_FULL_DOWNLOAD=true). */
async function handleLegacy(req, res, url, entry) {
  const m = /(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{11})/.exec(url.searchParams.get('url') ?? '');
  if (!m) return fail(res, 400, 'bad_video_id', 'Not a YouTube URL');
  entry.videoId = m[1];
  if (url.pathname === '/api/youtube/info') {
    try {
      const meta = await yt.metadata(m[1]);
      return json(res, 200, { title: meta.title, duration: meta.duration });
    } catch (e) {
      return fail(res, 502, 'upstream', e.message);
    }
  }
  const p = yt.spawnFullDownload(m[1]);
  p.stdout.once('data', () => res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }));
  p.stdout.pipe(res);
  p.on('error', () => fail(res, 502, 'upstream', 'yt-dlp not found'));
  res.on('close', () => p.kill());
  entry.result = 'full_download';
}

// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rawIp = clientIp(req, cfg);
  const ip = hashIp(rawIp, cfg.ipSalt);
  const entry = { ip, method: req.method, path: url.pathname, rawIp };

  try {
    if (!cors(req, res, cfg)) return fail(res, 403, 'origin_not_allowed', 'Origin not allowed.');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/health') {
      return json(res, 200, { youtube: youtubeEnabled(), maxSnippetSeconds: cfg.maxSnippetSeconds });
    }
    if (route === 'POST /api/token') return await handleToken(req, res, ip, entry);
    if (route === 'GET /api/snippet') return await handleSnippet(req, res, ip, url, entry);
    if (cfg.allowFullDownload && (route === 'GET /api/youtube/info' || route === 'GET /api/youtube/audio')) {
      return await handleLegacy(req, res, url, entry);
    }
    fail(res, 404, 'not_found', 'Not found');
  } catch (e) {
    entry.result = 'error';
    fail(res, e.code === 'bad_request' ? 400 : 500, e.code ?? 'error', e.code === 'bad_request' ? e.message : 'Internal error');
  } finally {
    const { rawIp: _, ...rest } = entry; // never log the raw IP
    log({ ...rest, status: res.statusCode, result: entry.result ?? res.errorCode ?? 'ok', ms: Date.now() - t0 });
  }
});

toolsOk = await toolsAvailable(cfg);
server.listen(cfg.port, cfg.host, () => {
  log({
    msg: 'SU700 YouTube helper listening',
    url: `http://${cfg.host}:${cfg.port}`,
    production: cfg.production,
    youtube: youtubeEnabled(),
    tools: toolsOk ? 'ok' : `missing — run "npm run setup:tools" (yt-dlp: ${cfg.ytdlp}, ffmpeg: ${cfg.ffmpeg})`,
    fullDownload: cfg.allowFullDownload,
  });
});

