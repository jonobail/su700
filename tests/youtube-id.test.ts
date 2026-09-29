// Run with `npm test` (node --test; Node strips the types itself).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixStreamedWav, formatTime, parseStartTime, parseYouTubeId, snippetName } from '../src/app/audio/youtube-id.ts';

const ID = 'jNQXAC9IVRw';

test('parses the supported link shapes', () => {
  for (const url of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s&list=PL123`,
    `http://m.youtube.com/watch?feature=share&v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}&si=abc`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?t=5`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}?feature=share`,
    `youtube.com/watch?v=${ID}`,
    `  youtu.be/${ID}  `,
    ID,
  ]) {
    assert.equal(parseYouTubeId(url), ID, url);
  }
});

test('rejects anything else', () => {
  for (const bad of [
    '',
    'hello',
    `https://example.com/watch?v=${ID}`,
    `https://youtube.com.evil.example/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=short`,
    `https://www.youtube.com/watch?v=${ID}xx`,
    `https://www.youtube.com/channel/UC1234567890`,
    `https://www.youtube.com/playlist?list=PL1234567890`,
    `javascript:alert(1)//youtu.be/${ID}`,
    `ftp://youtu.be/${ID}`,
    'abc def ghi',
  ]) {
    assert.equal(parseYouTubeId(bad), null, bad);
  }
});

test('reads start offsets from links', () => {
  assert.equal(parseStartTime(`https://youtu.be/${ID}?t=65`), 65);
  assert.equal(parseStartTime(`https://youtu.be/${ID}?t=1m5s`), 65);
  assert.equal(parseStartTime(`https://www.youtube.com/watch?v=${ID}&t=1h0m2s`), 3602);
  assert.equal(parseStartTime(`https://youtu.be/${ID}`), 0);
  assert.equal(parseStartTime('not a url'), 0);
});

test('formats times and snippet names', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(65.34), '1:05.3');
  assert.equal(formatTime(59.97), '1:00');
  assert.equal(formatTime(0.1 + 0.2), '0:00.3');
  assert.equal(snippetName('Song', 65, 30), 'Song @ 1:05 (30s)');
});

test('patches the placeholder sizes ffmpeg leaves in a piped WAV', () => {
  // RIFF header + fmt chunk (16) + data chunk with 0xFFFFFFFF size and 8 bytes of audio.
  const buf = new ArrayBuffer(12 + 24 + 8 + 8);
  const v = new DataView(buf);
  const put = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  put(0, 'RIFF');
  v.setUint32(4, 0xffffffff, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true);
  put(36, 'data');
  v.setUint32(40, 0xffffffff, true);

  fixStreamedWav(buf);
  assert.equal(v.getUint32(4, true), buf.byteLength - 8);
  assert.equal(v.getUint32(40, true), 8);
});

test('leaves non-WAV data alone', () => {
  const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]).buffer;
  assert.deepEqual(new Uint8Array(fixStreamedWav(buf)), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));
});
