// yt-dlp / ffmpeg wrappers. Every call uses execFile/spawn with an argument array (never a
// shell), and the only user-derived value passed on is a video ID that has already matched
// VIDEO_ID_RE, embedded in a URL we build ourselves.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const HOUR = 3_600_000;
const CACHE_MAX = 500;
const AUDIO_FORMAT = 'bestaudio[ext=m4a]/bestaudio';

export const watchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;

/** Small TTL cache that also de-duplicates concurrent lookups for the same key. */
class TtlCache {
  #map = new Map(); // key -> { exp, promise }
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
  }
  get(key, load) {
    const hit = this.#map.get(key);
    if (hit && hit.exp > Date.now()) return hit.promise;
    const promise = load();
    this.#map.set(key, { exp: Date.now() + this.ttlMs, promise });
    promise.catch(() => this.#map.delete(key)); // don't cache failures
    if (this.#map.size > CACHE_MAX) this.#map.delete(this.#map.keys().next().value);
    return promise;
  }
  delete(key) {
    this.#map.delete(key);
  }
}

export class YouTube {
  #meta = new TtlCache(HOUR);
  #streams = new TtlCache(HOUR);

  constructor(cfg) {
    this.cfg = cfg;
    const isPath = (p) => path.isAbsolute(p) && existsSync(p);
    // Point yt-dlp at our bundled deno/ffmpeg when they live in server/bin rather than on PATH.
    this.baseArgs = ['--ignore-config', '--no-playlist', '--no-warnings'];
    if (isPath(cfg.deno)) this.baseArgs.push('--js-runtimes', `deno:${cfg.deno}`);
    if (isPath(cfg.ffmpeg)) this.baseArgs.push('--ffmpeg-location', cfg.ffmpeg);
  }

  /** @returns {Promise<{ title: string, duration: number, live: boolean }>} */
  metadata(videoId) {
    assertId(videoId);
    return this.#meta.get(videoId, async () => {
      const out = await this.#ytdlp(['-J', '--', watchUrl(videoId)], 32 * 1024 * 1024);
      const info = JSON.parse(out);
      const live = !!info.is_live || ['is_live', 'is_upcoming', 'post_live'].includes(info.live_status);
      return { title: String(info.title ?? videoId), duration: Number(info.duration) || 0, live };
    });
  }

  /** Direct media URL for the best audio-only format (valid for several hours; cached 1 h). */
  streamUrl(videoId) {
    assertId(videoId);
    return this.#streams.get(videoId, async () => {
      const out = await this.#ytdlp(['-f', AUDIO_FORMAT, '-g', '--', watchUrl(videoId)], 1024 * 1024);
      const url = out.split('\n')[0].trim();
      // Only ever hand ffmpeg an https URL, never a file path or other protocol.
      if (!/^https:\/\//.test(url)) throw new Error('yt-dlp returned no stream URL');
      return url;
    });
  }

  forgetStream(videoId) {
    this.#streams.delete(videoId);
  }

  /**
   * Decode [start, start+length) of the stream to 16-bit stereo 44.1 kHz WAV on stdout.
   * The caller must enforce the length cap before calling.
   */
  spawnSnippet(url, start, length) {
    return spawn(this.cfg.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-protocol_whitelist', 'https,tls,tcp,crypto',
      '-ss', start.toFixed(3), '-t', length.toFixed(3),
      '-i', url,
      '-vn', '-f', 'wav', '-ac', '2', '-ar', '44100', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** Full audio stream (legacy endpoint, ALLOW_FULL_DOWNLOAD only). */
  spawnFullDownload(videoId) {
    assertId(videoId);
    return spawn(this.cfg.ytdlp, [...this.baseArgs, '-q', '-f', AUDIO_FORMAT, '-o', '-', '--', watchUrl(videoId)]);
  }

  #ytdlp(args, maxBuffer) {
    return new Promise((resolve, reject) => {
      execFile(this.cfg.ytdlp, [...this.baseArgs, ...args], { maxBuffer, timeout: 45_000 }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if (err.code === 'ENOENT') return reject(new Error('yt-dlp not found — run "npm run setup:tools"'));
        reject(new Error(String(stderr).trim().split('\n').pop() || err.message));
      });
    });
  }
}

function assertId(videoId) {
  if (!VIDEO_ID_RE.test(videoId)) throw Object.assign(new Error('Invalid video ID'), { code: 'bad_video_id' });
}

/** Are the external tools runnable? */
export function toolsAvailable(cfg) {
  const ok = (bin, arg) =>
    new Promise((resolve) => execFile(bin, [arg], { timeout: 10_000 }, (err) => resolve(!err)));
  return Promise.all([ok(cfg.ytdlp, '--version'), ok(cfg.ffmpeg, '-version')]).then(([a, b]) => a && b);
}
