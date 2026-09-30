import { signal } from '@angular/core';
import { SONG_COUNT } from './core/model';
import type { Job, JobContext, JobView } from './jobs';

/*
 * SONG group (Owner's Manual p.227–230): NAME, COPY, INIT, MTC OFFSET.
 */

/** Dial order for name characters, full left to full right (p.228). */
const NAME_CHARS = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_';
const NAME_LEN = 8;
const nn = (i: number) => String(i + 1).padStart(2, '0');

/** Eight-character name entry: cursor, dial, NAME/INSERT, NAME/DELETE. */
class NameEditor {
  readonly chars = signal<string[]>(new Array(NAME_LEN).fill(' '));
  readonly cursor = signal(0);

  set(name: string): void {
    this.chars.set(name.toUpperCase().padEnd(NAME_LEN).slice(0, NAME_LEN).split(''));
    this.cursor.set(0);
  }

  text(): string {
    return this.chars().join('').trimEnd();
  }

  /** The name as shown while editing: a space under the cursor shows as "_" (p.228). */
  shown(): string {
    return this.chars().map((c, i) => (i === this.cursor() && c === ' ' ? '_' : c)).join('');
  }

  dial(step: number): void {
    const i = this.cursor();
    this.chars.update((cs) => {
      const at = NAME_CHARS.indexOf(cs[i]);
      const next = Math.min(NAME_CHARS.length - 1, Math.max(0, (at < 0 ? 0 : at) + step));
      return cs.map((c, k) => (k === i ? NAME_CHARS[next] : c));
    });
  }

  move(dir: -1 | 1): void {
    this.cursor.update((c) => Math.min(NAME_LEN - 1, Math.max(0, c + dir)));
  }

  key(k: 'insert' | 'delete'): void {
    const i = this.cursor();
    this.chars.update((cs) => {
      const out = [...cs];
      if (k === 'insert') out.splice(i, 0, ' ');
      else {
        out.splice(i, 1);
        out.push(' ');
      }
      return out.slice(0, NAME_LEN);
    });
  }
}

/** Whether `name` is taken by any song other than those in `except`. */
function nameTaken(ctx: JobContext, name: string, except: number[]): boolean {
  for (let i = 0; i < SONG_COUNT; i++) {
    if (!except.includes(i) && ctx.host.seq.songAt(i).name().trimEnd() === name) return true;
  }
  return false;
}

const current = (ctx: JobContext) => ctx.host.seq.song().number - 1;

// ---------------------------------------------------------------------------

/** SONG | NAME (p.228). CANCEL keeps the original name. */
export class SongNameJob implements Job {
  private readonly name = new NameEditor();

  constructor(private readonly ctx: JobContext) {}

  enter(): void {
    this.name.set(this.ctx.host.seq.song().name());
  }

  view(): JobView {
    const c = this.name.cursor();
    return { top: 'SONG NAME', value: `${nn(current(this.ctx))} ${this.name.shown()}`, valueRange: [3 + c, 4 + c], track: null };
  }

  dial(step: number): void {
    this.name.dial(step);
  }

  cursor(dir: -1 | 1): void {
    this.name.move(dir);
  }

  nameKey(k: 'insert' | 'delete'): void {
    this.name.key(k);
  }

  ok(): void {
    const text = this.name.text();
    const i = current(this.ctx);
    if (nameTaken(this.ctx, text, [i])) return this.ctx.host.show('NAME EXISTS', '');
    this.ctx.host.seq.song().name.set(text);
    this.ctx.host.leaveJob();
  }
}

/** SONG | COPY (p.229): destination → OVERWRITE? → name for the copy. */
export class SongCopyJob implements Job {
  private readonly step = signal<'dest' | 'overwrite' | 'name'>('dest');
  private readonly dest = signal(1);
  private readonly name = new NameEditor();

  constructor(private readonly ctx: JobContext) {}

  enter(): void {
    const cur = current(this.ctx);
    this.dest.set(cur === SONG_COUNT - 1 ? cur - 1 : cur + 1);
    this.step.set('dest');
  }

  view(): JobView {
    const seq = this.ctx.host.seq;
    switch (this.step()) {
      case 'dest':
        return { top: 'COPY TO SONG', value: `${nn(this.dest())} ${seq.songAt(this.dest()).name()}`, valueRange: [0, 2], track: null };
      case 'overwrite':
        return { top: 'OVERWRITE?', value: `${nn(this.dest())} ${seq.songAt(this.dest()).name()}`, blinkTop: true, track: null };
      case 'name': {
        const c = this.name.cursor();
        return { top: `SONG ${nn(this.dest())} NAME`, value: `[${this.name.shown()}]`, valueRange: [1 + c, 2 + c], track: null };
      }
    }
  }

  dial(step: number): void {
    if (this.step() === 'name') return this.name.dial(step);
    if (this.step() !== 'dest') return;
    const cur = current(this.ctx);
    let d = this.dest();
    do d = (((d + step) % SONG_COUNT) + SONG_COUNT) % SONG_COUNT;
    while (d === cur);
    this.dest.set(d);
  }

  cursor(dir: -1 | 1): void {
    if (this.step() === 'name') this.name.move(dir);
  }

  nameKey(k: 'insert' | 'delete'): void {
    if (this.step() === 'name') this.name.key(k);
  }

  ok(): void {
    const seq = this.ctx.host.seq;
    switch (this.step()) {
      case 'dest':
        if (!seq.songAt(this.dest()).isEmpty()) return this.step.set('overwrite');
        return this.toName();
      case 'overwrite':
        return this.toName();
      case 'name': {
        const text = this.name.text();
        // The destination's old name goes with it, so only other songs can clash.
        if (nameTaken(this.ctx, text, [this.dest()])) return this.ctx.host.show('NAME EXISTS', '');
        seq.copySong(current(this.ctx), this.dest(), text);
        this.ctx.host.leaveJob();
      }
    }
  }

  private toName(): void {
    this.name.set('COPYSONG');
    this.step.set('name');
  }

  back(): boolean {
    if (this.step() === 'dest') return false;
    this.step.set('dest');
    return true;
  }
}

/** SONG | INIT (p.230): no confirmation; OK initializes the selected song. */
export class SongInitJob implements Job {
  private readonly target = signal(0);

  constructor(private readonly ctx: JobContext) {}

  enter(): void {
    this.target.set(current(this.ctx));
  }

  view(): JobView {
    const t = this.target();
    return { top: 'INIT SONG', value: `${nn(t)} ${this.ctx.host.seq.songAt(t).name()}`, valueRange: [0, 2], track: null };
  }

  dial(step: number): void {
    this.target.update((t) => (((t + step) % SONG_COUNT) + SONG_COUNT) % SONG_COUNT);
  }

  ok(): void {
    this.ctx.host.seq.initSong(this.target());
    this.ctx.host.leaveJob();
  }
}

const MTC_MAX = [23, 59, 59, 29];
const MTC_UNIT = ['H', 'M', 'S', 'F'];

/** SONG | MTC OFFSET (p.230). Only matters for MTC SLAVE sync, which needs Web MIDI (not yet built). */
export class MtcOffsetJob implements Job {
  private readonly field = signal(0);

  constructor(private readonly ctx: JobContext) {}

  enter(): void {
    this.field.set(0);
  }

  view(): JobView {
    const v = this.ctx.host.seq.song().mtcOffset();
    const f = this.field();
    return {
      top: 'MTC OFFSET', value: v.map((x, i) => String(x).padStart(2, '0') + MTC_UNIT[i]).join(''),
      valueRange: [f * 3, f * 3 + 2], track: null,
    };
  }

  dial(step: number): void {
    const f = this.field();
    this.ctx.host.seq.song().mtcOffset.update((v) =>
      v.map((x, i) => (i === f ? Math.min(MTC_MAX[i], Math.max(0, x + step)) : x)) as [number, number, number, number]);
  }

  cursor(dir: -1 | 1): void {
    this.field.update((f) => Math.min(3, Math.max(0, f + dir)));
  }

  ok(): void {
    this.ctx.host.leaveJob();
  }
}
