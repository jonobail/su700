// Pure helpers for the YouTube snippet flow. No Angular imports, so they can be unit-tested
// directly with `node --test` (see tests/).

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com']);

/**
 * Extracts the 11-character video ID from a YouTube link (youtube.com/watch, youtu.be,
 * /shorts/, /embed/, /live/, music.youtube.com) or a bare ID. Returns null otherwise.
 */
export function parseYouTubeId(input: string): string | null {
  const s = input.trim();
  if (VIDEO_ID.test(s)) return s;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] ?? null;
  } else if (YT_HOSTS.has(host)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else id = /^\/(?:shorts|embed|live|v)\/([^/]+)/.exec(url.pathname)?.[1] ?? null;
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

/** Start offset from a link's `t` / `start` parameter (e.g. t=65, t=1m5s), in seconds. */
export function parseStartTime(input: string): number {
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    return 0;
  }
  const t = url.searchParams.get('t') ?? url.searchParams.get('start');
  if (!t) return 0;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/.exec(t);
  if (!m) return 0;
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + Number(m[3] ?? 0);
}

/**
 * ffmpeg writing WAV to a pipe can't seek back to fill in the RIFF and data chunk sizes, so it
 * leaves placeholders. Patch them to the real sizes so every browser's decoder accepts the file.
 * Mutates and returns the buffer.
 */
export function fixStreamedWav(buf: ArrayBuffer): ArrayBuffer {
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return buf;
  v.setUint32(4, buf.byteLength - 8, true);
  let o = 12;
  while (o + 8 <= buf.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'data') {
      const actual = buf.byteLength - (o + 8);
      if (size > actual) v.setUint32(o + 4, actual - (actual % 4), true); // whole stereo frames
      break;
    }
    o += 8 + size + (size % 2);
  }
  return buf;
}

/** 65.3 → "1:05.3", 65 → "1:05". */
export function formatTime(sec: number): string {
  const t = Math.round(Math.max(0, sec) * 10) / 10; // round to tenths first so 59.97 → 1:00
  const m = Math.floor(t / 60);
  const rest = t - m * 60;
  const whole = Math.floor(rest + 1e-9);
  const tenths = Math.round((rest - whole) * 10);
  return `${m}:${String(whole).padStart(2, '0')}${tenths ? `.${tenths}` : ''}`;
}

/** Library name for a sampled snippet, e.g. "Me at the zoo @ 0:05 (10s)". */
export function snippetName(title: string, start: number, length: number): string {
  return `${title} @ ${formatTime(start)} (${Math.round(length)}s)`;
}
