import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { JobGroup } from '../jobs';
import { UnitController } from '../unit-controller';
import { Display } from './display';
import { JogWheel } from './jog-wheel';
import { Knob } from './knob';
import {
  FUNCTION_GRID, GRID_ROWS_Y, GRID_X, KNOB_COLORS, KNOB_FN_ROWS, KNOB_FN_TABS, KNOB_X, KnobFnButton,
  MODES, PADS, PAD_FUNCTIONS, PAD_GROUPS, PAD_KEYS, PANEL_H, PANEL_W, SCENES, TRACK_BANK, TRANSPORT,
} from './layout';

/** The SU700 faceplate. Laid out on a fixed 1000×871 canvas and scaled to fit the window. */
function capture(el: Element, id: number): void {
  try {
    el.setPointerCapture(id);
  } catch {
    // Synthetic events have no active pointer to capture.
  }
}

@Component({
  selector: 'su-panel',
  imports: [Display, JogWheel, Knob],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './su700-panel.html',
  styleUrl: './su700-panel.scss',
  host: {
    '(window:resize)': 'fit()',
    '(window:keydown)': 'key($event, true)',
    '(window:keyup)': 'key($event, false)',
  },
})
export class Su700Panel {
  protected readonly unit = inject(UnitController);
  protected readonly engine = this.unit.engine;
  protected readonly seq = this.unit.seq;

  protected readonly W = PANEL_W;
  protected readonly H = PANEL_H;
  protected readonly knobFnRows = KNOB_FN_ROWS;
  protected readonly knobFnTabs = KNOB_FN_TABS;
  protected readonly modes = MODES;
  protected readonly gridX = GRID_X;
  protected readonly gridRowsY = GRID_ROWS_Y;
  protected readonly grid = FUNCTION_GRID;
  protected readonly scenes = SCENES;
  protected readonly transport = TRANSPORT;
  protected readonly knobX = KNOB_X;
  protected readonly knobColors = KNOB_COLORS;
  protected readonly pads = PADS;
  protected readonly padGroups = PAD_GROUPS;
  protected readonly trackBank = TRACK_BANK;
  protected readonly padFunctions = PAD_FUNCTIONS;

  protected readonly scale = signal(1);
  protected readonly analogLevel = signal(0.7);
  protected readonly ribbonTouch = signal<number | null>(null);

  protected readonly mutedPads = computed(() => this.unit.padTracks().map((i) => this.seq.track(i).muted()));
  protected readonly emptyPads = computed(() =>
    this.unit.padTracks().map((i, p) => p < 10 && !this.seq.track(i).sample()),
  );

  constructor() {
    this.fit();
  }

  /**
   * Desktop: fit the whole panel above the pinned source tray.
   * Phones and tablets: fit the width and let the page scroll; the tray then sits below the panel.
   * Must match the COMPACT media query in styles.scss / source-tray.scss.
   */
  fit(): void {
    const w = window.innerWidth;
    const compact = matchMedia('(pointer: coarse), (max-width: 999px)').matches;
    const byWidth = (w - (compact ? 4 : 16)) / PANEL_W;
    const byHeight = (window.innerHeight - 170) / PANEL_H;
    this.scale.set(Math.max(0.3, compact ? byWidth : Math.min(byWidth, byHeight)));
  }

  /** Buttons that act while held use pointer down/up; the rest act on press. */
  protected knobFnDown(b: KnobFnButton): void {
    if (b.param) return this.unit.selectKnobFn(b.param);
    if ((b.action === 'KNOB RESET' || b.action === 'NOTE DEL' || b.action === 'INSERT' || b.action === 'DELETE') &&
      this.unit.pressJobKey(b.action)) return;
    switch (b.action) {
      case 'KNOB RESET': return this.unit.knobResetHeld.set(true);
      case 'NOTE DEL': return this.unit.noteDelHeld.set(true);
      default: this.unit.show(b.label, 'NOT YET');
    }
  }

  protected knobFnUp(b: KnobFnButton): void {
    if (b.action === 'KNOB RESET') this.unit.knobResetHeld.set(false);
    if (b.action === 'NOTE DEL') this.unit.noteDelHeld.set(false);
  }

  protected knobFnLit(b: KnobFnButton): boolean {
    if (b.param) return this.unit.screen() === 'function' && b.param === this.unit.knobFn();
    return (b.action === 'KNOB RESET' && this.unit.knobResetHeld()) || (b.action === 'NOTE DEL' && this.unit.noteDelHeld());
  }

  protected modePress(g: JobGroup): void {
    this.unit.pressJobGroup(g);
  }

  protected gridPress(row: number): void {
    const g = this.unit.jobGroup();
    const col = g ? MODES.findIndex((x) => x.mode === g) : -1;
    this.unit.pressJob(row, col >= 0 ? FUNCTION_GRID[row][col].replace(/-?\n/g, ' ') : '');
  }

  protected transportDown(id: (typeof TRANSPORT)[number]['id']): void {
    if (id === 'rew') this.unit.scan(-1, true);
    else if (id === 'ff') this.unit.scan(1, true);
    else this.unit.pressTransport(id);
  }

  protected transportUp(id: (typeof TRANSPORT)[number]['id']): void {
    if (id === 'rew') this.unit.scan(-1, false);
    if (id === 'ff') this.unit.scan(1, false);
  }

  protected transportLit(id: string): boolean {
    const m = this.seq.mode();
    return (id === 'play' && (m === 'play' || m === 'rec')) || (id === 'rec' && (m === 'rec' || m === 'recStandby'));
  }

  protected analogLevelChange(v: number): void {
    this.analogLevel.set(v);
    this.engine.setInputLevel(v);
  }

  protected ribbonMove(e: PointerEvent, down = false): void {
    if (!down && this.ribbonTouch() === null) return;
    const el = e.currentTarget as HTMLElement;
    if (down) capture(el, e.pointerId);
    const r = el.getBoundingClientRect();
    const v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    this.ribbonTouch.set(v);
    this.unit.ribbon(v);
  }

  protected ribbonUp(): void {
    this.ribbonTouch.set(null);
    this.unit.ribbon(null);
  }

  protected padPointer(i: number, e: PointerEvent): void {
    capture(e.currentTarget as HTMLElement, e.pointerId);
    // Pressure where available; otherwise hitting nearer the top of the pad plays harder.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const v = e.pressure && e.pointerType !== 'mouse' ? e.pressure : 1 - ((e.clientY - r.top) / r.height) * 0.6;
    this.unit.padDown(i, Math.round(Math.min(1, Math.max(0.05, v)) * 127));
  }

  key(e: KeyboardEvent, down: boolean): void {
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    const i = PAD_KEYS.indexOf(e.key.toLowerCase());
    if (i >= 0) {
      if (e.repeat) return;
      down ? this.unit.padDown(i) : this.unit.padUp(i);
      e.preventDefault();
    } else if (down && e.code === 'Space') {
      this.unit.pressTransport(this.seq.running() ? 'stop' : 'play');
      e.preventDefault();
    } else if (down && e.key === 'Enter') {
      this.unit.pressOk();
    } else if (down && e.key === 'Escape') {
      this.unit.pressCancel();
    } else if (down && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      this.unit.dial(e.key === 'ArrowUp' ? 1 : -1);
      e.preventDefault();
    } else if (down && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      this.unit.pressCursor(e.key === 'ArrowLeft' ? -1 : 1);
    }
  }
}
