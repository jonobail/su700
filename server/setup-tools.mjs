// Fetches the helper's external tools into server/bin when they aren't already on PATH:
//   - yt-dlp (standalone release binary; re-downloaded each run so it stays current)
//   - ffmpeg (static build; Linux and macOS only — elsewhere install it yourself)
//   - deno (the JavaScript runtime yt-dlp now uses to solve YouTube's player challenges)
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin');
const exe = (name) => path.join(bin, process.platform === 'win32' ? `${name}.exe` : name);
const onPath = (cmd, arg) => spawnSync(cmd, [arg]).status === 0;
mkdirSync(bin, { recursive: true });

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---- yt-dlp ----
if (onPath('yt-dlp', '--version')) {
  console.log('yt-dlp: already on PATH');
} else {
  const asset = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos' }[process.platform] ?? 'yt-dlp_linux';
  writeFileSync(exe('yt-dlp'), await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`));
  chmodSync(exe('yt-dlp'), 0o755);
  console.log(`yt-dlp: installed at ${exe('yt-dlp')}`);
}

// ---- ffmpeg ----
if (onPath('ffmpeg', '-version')) {
  console.log('ffmpeg: already on PATH');
} else if (existsSync(exe('ffmpeg'))) {
  console.log(`ffmpeg: already at ${exe('ffmpeg')}`);
} else if (process.platform === 'linux') {
  // BtbN builds: the johnvansickle static builds segfault on DNS lookups (static glibc NSS).
  const arch = process.arch === 'arm64' ? 'linuxarm64' : 'linux64';
  const tmp = mkdtempSync(path.join(tmpdir(), 'ffmpeg-'));
  const archive = path.join(tmp, 'ffmpeg.tar.xz');
  writeFileSync(archive, await download(`https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${arch}-gpl.tar.xz`));
  if (spawnSync('tar', ['-xJf', archive, '-C', tmp]).status !== 0) throw new Error('Could not extract ffmpeg (needs tar with xz)');
  const dir = readdirSync(tmp).find((d) => d.startsWith('ffmpeg-'));
  copyFileSync(path.join(tmp, dir, 'bin', 'ffmpeg'), exe('ffmpeg')); // copy, not rename: /tmp may be another filesystem
  chmodSync(exe('ffmpeg'), 0o755);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`ffmpeg: installed at ${exe('ffmpeg')}`);
} else if (process.platform === 'darwin') {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ffmpeg-'));
  const archive = path.join(tmp, 'ffmpeg.zip');
  writeFileSync(archive, await download('https://evermeet.cx/ffmpeg/getrelease/zip'));
  if (spawnSync('unzip', ['-o', archive, '-d', bin]).status !== 0) throw new Error('Could not unzip ffmpeg');
  chmodSync(exe('ffmpeg'), 0o755);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`ffmpeg: installed at ${exe('ffmpeg')}`);
} else {
  console.log('ffmpeg: not found. Install it (e.g. `winget install ffmpeg`) and make sure it is on PATH.');
}

// ---- deno ----
const denoTarget = {
  'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
}[`${process.platform}-${process.arch}`];
if (onPath('deno', '--version')) {
  console.log('deno: already on PATH');
} else if (existsSync(exe('deno'))) {
  console.log(`deno: already at ${exe('deno')}`);
} else if (denoTarget) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'deno-'));
  const archive = path.join(tmp, 'deno.zip');
  writeFileSync(archive, await download(`https://github.com/denoland/deno/releases/latest/download/deno-${denoTarget}.zip`));
  if (spawnSync('unzip', ['-o', archive, '-d', bin]).status !== 0) throw new Error('Could not unzip deno (needs unzip)');
  chmodSync(exe('deno'), 0o755);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`deno: installed at ${exe('deno')}`);
} else {
  console.log('deno: no build for this platform; yt-dlp will still work but may miss some formats.');
}
