import { Injectable, inject, signal } from '@angular/core';
import { AudioEngine } from './audio-engine';
import { AudioSourceMeta, SourceStore } from './source-store';

/** Brings audio into the unit: local file uploads or YouTube links (via the local /api server). */
@Injectable({ providedIn: 'root' })
export class SourceLoader {
  private readonly store = inject(SourceStore);
  private readonly engine = inject(AudioEngine);

  readonly busy = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  async uploadFiles(files: FileList | File[]): Promise<void> {
    for (const file of Array.from(files)) {
      await this.run(`LOADING ${file.name}`, async () => {
        // Decode first so unsupported files are rejected before they're stored.
        const buffer = await this.engine.decode(file);
        const meta = await this.store.add({
          name: file.name.replace(/\.[^.]+$/, ''),
          origin: 'file',
          mime: file.type || 'audio/*',
          blob: file,
        });
        this.engine.loadSource(meta.id, meta.name, buffer);
      });
    }
  }

  async fromYouTube(url: string): Promise<void> {
    await this.run('FETCHING YOUTUBE AUDIO', async () => {
      const q = encodeURIComponent(url.trim());
      const infoRes = await fetch(`/api/youtube/info?url=${q}`);
      if (!infoRes.ok) throw new Error(await errorText(infoRes));
      const info: { title: string } = await infoRes.json();

      this.busy.set(`DOWNLOADING ${info.title}`);
      const res = await fetch(`/api/youtube/audio?url=${q}`);
      if (!res.ok) throw new Error(await errorText(res));
      const blob = await res.blob();
      const buffer = await this.engine.decode(blob);
      const meta = await this.store.add({
        name: info.title,
        origin: 'youtube',
        url: url.trim(),
        mime: blob.type || res.headers.get('content-type') || 'audio/*',
        blob,
      });
      this.engine.loadSource(meta.id, meta.name, buffer);
    });
  }

  async select(meta: AudioSourceMeta): Promise<void> {
    await this.run(`LOADING ${meta.name}`, async () => {
      const src = await this.store.get(meta.id);
      if (!src) throw new Error('Source no longer exists');
      this.engine.loadSource(src.id, src.name, await this.engine.decode(src.blob));
    });
  }

  async remove(meta: AudioSourceMeta): Promise<void> {
    if (this.engine.source()?.id === meta.id) {
      this.engine.stopSource();
      this.engine.source.set(null);
    }
    await this.store.remove(meta.id);
  }

  private async run(label: string, fn: () => Promise<void>): Promise<void> {
    this.engine.resume();
    this.error.set(null);
    this.busy.set(label);
    try {
      await fn();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(null);
    }
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.error ?? res.statusText;
  } catch {
    return `YouTube helper not reachable (${res.status}) — start it with "npm run server"`;
  }
}
