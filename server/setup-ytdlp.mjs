// Downloads the standalone yt-dlp binary into server/bin (skipped if yt-dlp is already on PATH).
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (spawnSync('yt-dlp', ['--version']).status === 0) {
  console.log('yt-dlp already on PATH — nothing to do.');
  process.exit(0);
}
const asset = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos' }[process.platform] ?? 'yt-dlp_linux';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin');
const dest = path.join(dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const res = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`);
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
mkdirSync(dir, { recursive: true });
writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
chmodSync(dest, 0o755);
console.log(`yt-dlp installed at ${dest}`);
