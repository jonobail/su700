import { Injectable, signal } from '@angular/core';
import { environment } from '../../environments/environment';
import { fixStreamedWav } from './youtube-id';

/** A failure the UI can show as-is. `code` mirrors the helper's error codes. */
export class SnippetError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Steps of a sample request, reported to the UI as they start. */
export type SamplePhase = 'verifying' | 'requesting' | 'downloading';

export interface Snippet {
  wav: ArrayBuffer;
  title: string;
  start: number;
  length: number;
}

// Messages for codes where the server's own text isn't the best thing to show.
const MESSAGES: Record<string, string> = {
  busy: 'The sampler is busy right now. Try again in a moment.',
  token_expired: 'The sample request expired before it finished. Press SAMPLE again.',
  token_used: 'That sample request was already used. Press SAMPLE again.',
  token_invalid: 'The sample request was rejected. Press SAMPLE again.',
  token_ip_mismatch: 'Your network address changed mid-request. Press SAMPLE again.',
  youtube_disabled: 'YouTube sampling is offline right now.',
  network: "Couldn't reach the YouTube helper. Check your connection and try again.",
};

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  execute(id: string): void;
  reset(id: string): void;
}

const api = (path: string) => `${environment.apiBase}/api/${path}`;

/** Talks to the YouTube helper (server/) and runs the Turnstile check. */
@Injectable({ providedIn: 'root' })
export class YouTubeSnippets {
  /** 'checking' until /api/health answers; 'offline' if it fails or reports youtube: false. */
  readonly status = signal<'checking' | 'online' | 'offline'>('checking');
  readonly maxSeconds = signal(30);

  private turnstile: Promise<TurnstileApi> | null = null;
  private widget: { id: string; el: HTMLElement } | null = null;
  private pending: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;

  constructor() {
    void this.checkHealth();
  }

  async checkHealth(): Promise<void> {
    try {
      const res = await fetch(api('health'), { signal: AbortSignal.timeout(6000) });
      const body = await res.json();
      if (typeof body.maxSnippetSeconds === 'number') this.maxSeconds.set(body.maxSnippetSeconds);
      this.status.set(res.ok && body.youtube === true ? 'online' : 'offline');
    } catch {
      this.status.set('offline');
    }
  }

  /** Load Turnstile's script (first use only) and render the widget into `el`. */
  prepare(el: HTMLElement): void {
    void this.widgetIn(el);
  }

  async sample(
    videoId: string, start: number, length: number, widgetEl: HTMLElement,
    onPhase: (phase: SamplePhase) => void = () => {},
  ): Promise<Snippet> {
    onPhase('verifying');
    const turnstileToken = await this.runTurnstile(widgetEl);

    onPhase('requesting');
    const tokenRes = await this.call(api('token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, start, length, turnstileToken }),
    });
    const t: { token: string; title: string; start: number; length: number } = await tokenRes.json();

    onPhase('downloading');
    const snipRes = await this.call(`${api('snippet')}?token=${encodeURIComponent(t.token)}`);
    const wav = fixStreamedWav(await snipRes.arrayBuffer());
    return { wav, title: t.title, start: t.start, length: t.length };
  }

  /** fetch that turns non-2xx replies and network failures into SnippetErrors. */
  private async call(url: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch {
      throw new SnippetError('network', MESSAGES['network']);
    }
    if (res.ok) return res;
    let code = `http_${res.status}`;
    let message = `The YouTube helper returned an error (${res.status}).`;
    try {
      const body = await res.json();
      code = body.code ?? code;
      message = body.error ?? message;
    } catch {
      /* not JSON */
    }
    if (code === 'youtube_disabled' || code === 'daily_cap') this.status.set('offline');
    throw new SnippetError(code, MESSAGES[code] ?? message);
  }

  // ---- Turnstile ----

  private loadTurnstile(): Promise<TurnstileApi> {
    return (this.turnstile ??= new Promise<TurnstileApi>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => resolve((window as unknown as { turnstile: TurnstileApi }).turnstile);
      s.onerror = () => {
        this.turnstile = null;
        reject(new SnippetError('turnstile_load', "Couldn't load the bot check. Disable blockers for this page and retry."));
      };
      document.head.appendChild(s);
    }));
  }

  private async widgetIn(el: HTMLElement): Promise<{ ts: TurnstileApi; id: string }> {
    const ts = await this.loadTurnstile();
    if (!this.widget || this.widget.el !== el) {
      const id = ts.render(el, {
        sitekey: environment.turnstileSiteKey,
        execution: 'execute', // only run when we ask
        appearance: 'interaction-only', // stays invisible unless a human check is needed
        callback: (token: string) => this.pending?.resolve(token),
        'error-callback': () => this.pending?.reject(new SnippetError('turnstile_failed', 'The bot check failed. Try again.')),
        'expired-callback': () => this.widget && ts.reset(this.widget.id),
      });
      this.widget = { id, el };
    }
    return { ts, id: this.widget.id };
  }

  /** A fresh single-use Turnstile token. */
  private async runTurnstile(el: HTMLElement): Promise<string> {
    const { ts, id } = await this.widgetIn(el);
    ts.reset(id);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SnippetError('turnstile_timeout', 'The bot check timed out. Try again.')), 60_000);
      this.pending = {
        resolve: (t) => (clearTimeout(timer), resolve(t)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      ts.execute(id);
    }).finally(() => (this.pending = null));
  }
}
