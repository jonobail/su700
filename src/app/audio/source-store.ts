import { Injectable, signal } from '@angular/core';

/** An input-audio source kept in the browser's IndexedDB. */
export interface AudioSource {
  id: string;
  name: string;
  origin: 'file' | 'youtube';
  url?: string;
  mime: string;
  size: number;
  createdAt: number;
  blob: Blob;
}

export type AudioSourceMeta = Omit<AudioSource, 'blob'>;

const DB_NAME = 'su700';
const STORE = 'sources';

@Injectable({ providedIn: 'root' })
export class SourceStore {
  private db: Promise<IDBDatabase> = this.open();

  /** Metadata for every stored source, newest first. */
  readonly sources = signal<AudioSourceMeta[]>([]);

  constructor() {
    this.refresh();
  }

  async add(src: Omit<AudioSource, 'id' | 'createdAt' | 'size'>): Promise<AudioSourceMeta> {
    const record: AudioSource = {
      ...src,
      id: newId(),
      createdAt: Date.now(),
      size: src.blob.size,
    };
    await this.tx('readwrite', (s) => s.put(record));
    await this.refresh();
    const { blob, ...meta } = record;
    return meta;
  }

  async get(id: string): Promise<AudioSource | undefined> {
    return this.tx('readonly', (s) => s.get(id));
  }

  async remove(id: string): Promise<void> {
    await this.tx('readwrite', (s) => s.delete(id));
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const all = await this.tx<AudioSource[]>('readonly', (s) => s.getAll());
    this.sources.set(
      all.map(({ blob, ...meta }) => meta).sort((a, b) => b.createdAt - a.createdAt),
    );
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  }
}

/** crypto.randomUUID needs a secure context; plain-http access (e.g. over Tailscale) lacks it. */
function newId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
