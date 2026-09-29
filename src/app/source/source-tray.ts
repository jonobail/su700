import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild,
} from '@angular/core';
import { AudioEngine } from '../audio/audio-engine';
import { SourceLoader } from '../audio/source-loader';
import { SourceStore } from '../audio/source-store';
import { trackLabel } from '../core/model';
import { UnitController } from '../unit-controller';

/**
 * Replaces the SU700's analog inputs: pick the AUDIO IN source from an uploaded file or a
 * YouTube link. Sources are kept in IndexedDB so they survive reloads.
 */
@Component({
  selector: 'su-source-tray',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './source-tray.html',
  styleUrl: './source-tray.scss',
  host: {
    '(dragover)': '$event.preventDefault(); dragging.set(true)',
    '(dragleave)': 'dragging.set(false)',
    '(drop)': 'drop($event)',
  },
})
export class SourceTray {
  protected readonly engine = inject(AudioEngine);
  protected readonly loader = inject(SourceLoader);
  protected readonly store = inject(SourceStore);
  protected readonly unit = inject(UnitController);
  protected readonly targetLabel = computed(() => trackLabel(this.unit.lastTrack()));

  protected readonly ytUrl = signal('');
  protected readonly dragging = signal(false);
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('wave');

  protected readonly duration = computed(() => this.engine.source()?.buffer.duration ?? 0);
  /** Min/max peaks per pixel column, recomputed only when the source changes. */
  private readonly peaks = computed(() => {
    const buf = this.engine.source()?.buffer;
    if (!buf) return null;
    const cols = 600;
    const data = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / cols));
    const out = new Float32Array(cols * 2);
    for (let c = 0; c < cols; c++) {
      let min = 1, max = -1;
      for (let i = c * step, end = Math.min(data.length, i + step); i < end; i += 16) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      out[c * 2] = min;
      out[c * 2 + 1] = max;
    }
    return out;
  });

  constructor() {
    effect(() => this.draw(this.peaks(), this.engine.sourcePosition(), this.duration()));
  }

  protected fetchYouTube(): void {
    const url = this.ytUrl().trim();
    if (!url) return;
    void this.loader.fromYouTube(url).then(() => {
      if (!this.loader.error()) this.ytUrl.set('');
    });
  }

  /** Import the whole source onto the last-selected sample track (like DISK | LOAD / IMPORT). */
  protected importToTrack(): void {
    const src = this.engine.source();
    const i = this.unit.lastTrack();
    if (!src || i >= 40) return;
    this.unit.assignSample(i, src.buffer);
  }

  protected pick(input: HTMLInputElement): void {
    if (input.files?.length) void this.loader.uploadFiles(input.files);
    input.value = '';
  }

  drop(e: DragEvent): void {
    e.preventDefault();
    this.dragging.set(false);
    if (e.dataTransfer?.files.length) void this.loader.uploadFiles(e.dataTransfer.files);
  }

  protected seek(e: MouseEvent): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.engine.seekSource(((e.clientX - r.left) / r.width) * this.duration());
  }

  protected fmt(sec: number): string {
    const m = Math.floor(sec / 60);
    return `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  }

  protected fmtSize(bytes: number): string {
    return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`;
  }

  private draw(peaks: Float32Array | null, pos: number, dur: number): void {
    const cv = this.canvas()?.nativeElement;
    if (!cv) return;
    const g = cv.getContext('2d')!;
    const { width: w, height: h } = cv;
    g.clearRect(0, 0, w, h);
    if (!peaks) return;
    const cols = peaks.length / 2;
    const played = dur ? (pos / dur) * cols : 0;
    for (let c = 0; c < cols; c++) {
      const x = (c / cols) * w;
      const y1 = ((1 - peaks[c * 2 + 1]) / 2) * h;
      const y2 = ((1 - peaks[c * 2]) / 2) * h;
      g.fillStyle = c < played ? '#7ff3e6' : 'rgba(127,243,230,.35)';
      g.fillRect(x, y1, Math.max(1, w / cols), Math.max(1, y2 - y1));
    }
    g.fillStyle = '#ff5a4a';
    g.fillRect((played / cols) * w, 0, 2, h);
  }
}
