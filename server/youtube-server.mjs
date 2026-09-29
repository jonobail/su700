// Tiny local helper that lets the browser app pull audio from a YouTube link.
// Browsers can't fetch YouTube media directly (CORS), so we shell out to yt-dlp
// and stream the best audio-only format (m4a/webm) straight back. No ffmpeg needed:
// the browser decodes AAC/Opus itself.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 3700);
const MAX_SECONDS = Number(process.env.MAX_SECONDS ?? 20 * 60);
const here = path.dirname(fileURLToPath(import.meta.url));
const localBin = path.join(here, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const YTDLP = process.env.YTDLP ?? (existsSync(localBin) ? localBin : 'yt-dlp');

const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
]);

function parseYouTubeUrl(raw) {
  try {
    const u = new URL(raw);
    return (u.protocol === 'https:' || u.protocol === 'http:') && YT_HOSTS.has(u.hostname)
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => reject(new Error(`yt-dlp not found — run "npm run setup:ytdlp"`)));
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `yt-dlp exited ${code}`)),
    );
  });
}

const FORMAT = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio';

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://localhost');
  if (!u.pathname.startsWith('/api/youtube/')) return json(res, 404, { error: 'Not found' });

  const url = parseYouTubeUrl(u.searchParams.get('url') ?? '');
  if (!url) return json(res, 400, { error: 'Not a YouTube URL' });

  if (u.pathname === '/api/youtube/info') {
    try {
      const info = JSON.parse(await run(['--no-playlist', '-f', FORMAT, '-J', url]));
      if (info.duration > MAX_SECONDS) {
        return json(res, 413, { error: `Too long (${Math.round(info.duration / 60)} min, max ${MAX_SECONDS / 60})` });
      }
      return json(res, 200, { title: info.title, duration: info.duration, ext: info.ext });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  if (u.pathname === '/api/youtube/audio') {
    const p = spawn(YTDLP, ['--no-playlist', '-q', '-f', FORMAT, '-o', '-', url]);
    let started = false;
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.stdout.once('data', () => {
      started = true;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
    });
    p.stdout.pipe(res, { end: false });
    p.on('error', () => json(res, 502, { error: 'yt-dlp not found — run "npm run setup:ytdlp"' }));
    p.on('close', (code) => {
      if (started) return res.end();
      if (!res.headersSent) json(res, 502, { error: err.trim().split('\n').pop() || `yt-dlp exited ${code}` });
    });
    res.on('close', () => { if (!res.writableFinished) p.kill(); });
    return;
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`SU700 YouTube helper on http://127.0.0.1:${PORT} (yt-dlp: ${YTDLP})`);
});
