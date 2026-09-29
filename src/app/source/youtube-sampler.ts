import {
  ChangeDetectionStrategy, Component, ElementRef, OnDestroy, afterNextRender, inject, input, output, signal, viewChild,
} from '@angular/core';
import { SourceLoader } from '../audio/source-loader';
import { formatTime, snippetName } from '../audio/youtube-id';
import { SamplePhase, SnippetError, YouTubeSnippets } from '../audio/youtube-snippets';

/** Minimal slice of the YouTube IFrame Player API we use. */
interface YTPlayer {
  getCurrentTime(): number;
  getDuration(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  destroy(): void;
}
interface YTNamespace {
  Player: new (el: HTMLElement, opts: Record<string, unknown>) => YTPlayer;
}

let ytApi: Promise<YTNamespace> | null = null;
function loadYouTubeApi(): Promise<YTNamespace> {
  const w = window as unknown as { YT?: YTNamespace & { Player?: unknown }; onYouTubeIframeAPIReady?: () => void };
  return (ytApi ??= new Promise((resolve, reject) => {
    if (w.YT?.Player) return resolve(w.YT);
    w.onYouTubeIframeAPIReady = () => resolve(w.YT!);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => {
      ytApi = null;
      reject(new Error("Couldn't load the YouTube player."));
    };
    document.head.appendChild(s);
  }));
}

const LENGTHS = [5, 10, 20, 30];

const PHASE_MESSAGES: Record<SamplePhase, string> = {
  verifying: 'Confirming you’re human…',
  requesting: 'Requesting the clip…',
  downloading: 'Fetching audio…',
};

/**
 * Preview a YouTube video in the official embedded player, mark a start point, and sample up to
 * 30 s of it through the helper. Results land in the source library like uploaded files.
 */
@Component({
  selector: 'su-youtube-sampler',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './youtube-sampler.html',
  styleUrl: './youtube-sampler.scss',
  host: { '(keydown.escape)': 'close.emit()' },
})
export class YouTubeSampler implements OnDestroy {
  readonly videoId = input.required<string>();
  readonly initialStart = input(0);
  readonly close = output<void>();

  protected readonly snippets = inject(YouTubeSnippets);
  private readonly loader = inject(SourceLoader);

  protected readonly lengths = LENGTHS;
  protected readonly start = signal(0);
  protected readonly length = signal(10);
  protected readonly duration = signal(0);
  protected readonly state = signal<'loading' | 'ready' | 'sampling' | 'done' | 'error'>('loading');
  protected readonly message = signal('');
  protected readonly fmt = formatTime;

  private readonly playerHost = viewChild.required<ElementRef<HTMLElement>>('player');
  private readonly turnstileHost = viewChild.required<ElementRef<HTMLElement>>('turnstile');
  private player: YTPlayer | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    afterNextRender(() => {
      this.start.set(this.initialStart());
      // The Turnstile script is only fetched once someone actually opens the sampler.
      this.snippets.prepare(this.turnstileHost().nativeElement);
      void this.createPlayer();
    });
  }

  ngOnDestroy(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.player?.destroy();
  }

  protected markStart(): void {
    if (this.player) this.setStart(this.player.getCurrentTime());
  }

  protected nudge(delta: number): void {
    this.setStart(this.start() + delta);
    this.player?.seekTo(this.start(), true);
  }

  /** Play the selected region in the embedded player. */
  protected preview(): void {
    if (!this.player) return;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.player.seekTo(this.start(), true);
    this.player.playVideo();
    this.previewTimer = setTimeout(() => this.player?.pauseVideo(), this.effectiveLength() * 1000);
  }

  protected effectiveLength(): number {
    const d = this.duration();
    return d ? Math.max(0, Math.min(this.length(), d - this.start())) : this.length();
  }

  protected async sample(): Promise<void> {
    this.player?.pauseVideo();
    this.state.set('sampling');
    try {
      const id = this.videoId();
      const snip = await this.snippets.sample(
        id, this.start(), this.length(), this.turnstileHost().nativeElement,
        (phase) => this.message.set(PHASE_MESSAGES[phase]),
      );
      this.message.set('Decoding…');
      const name = snippetName(snip.title, snip.start, snip.length);
      await this.loader.addSnippet(snip.wav, name, `https://youtu.be/${id}?t=${Math.floor(snip.start)}`);
      this.state.set('done');
      this.message.set(`Sampled "${name}". It's now the AUDIO IN source.`);
    } catch (e) {
      this.state.set('error');
      this.message.set(e instanceof SnippetError || e instanceof Error ? e.message : String(e));
    }
  }

  private setStart(sec: number): void {
    const max = this.duration() ? Math.max(0, this.duration() - 0.1) : Infinity;
    this.start.set(Math.round(Math.min(max, Math.max(0, sec)) * 10) / 10);
    if (this.state() === 'done' || this.state() === 'error') this.state.set('ready');
  }

  private async createPlayer(): Promise<void> {
    try {
      const YT = await loadYouTubeApi();
      this.player = new YT.Player(this.playerHost().nativeElement, {
        host: 'https://www.youtube-nocookie.com',
        videoId: this.videoId(),
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, start: Math.floor(this.initialStart()) },
        events: {
          onReady: () => {
            this.duration.set(this.player?.getDuration() ?? 0);
            this.state.set('ready');
          },
          onError: () => {
            this.state.set('error');
            this.message.set("This video can't be played here (it may be private or not embeddable).");
          },
        },
      });
    } catch (e) {
      this.state.set('error');
      this.message.set(e instanceof Error ? e.message : String(e));
    }
  }
}
