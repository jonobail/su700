import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DisplayModel, MeterCell } from '../unit-controller';

/** Colours of the 12 track meters, matching the pads below them. */
const METER_COLORS = [
  'orange', 'orange', 'white', 'white', 'white', 'white', 'blue', 'blue', 'blue', 'blue', 'orange', 'red',
];
const SEGS = 8;
const WIDTH = 12;

/** DSEG fonts use "!" as a full-width blank; a plain space is narrow. */
const seg = (s: string) => s.toUpperCase().slice(0, WIDTH).padEnd(WIDTH, ' ').replace(/ /g, '!');

/** A line cut around the characters that flash (a cursor or selected field). */
const split = (s: string, r?: [number, number]): [string, string, string] =>
  r ? [s.slice(0, r[0]), s.slice(r[0], r[1]), s.slice(r[1])] : [s, '', ''];

const PAD_FN_LABEL = { play: 'PLAY', mute: 'ON/MUTE', roll: 'PLAY', restart: 'LOOP RESTART' } as const;

/** The fluorescent (VFD) display window. */
@Component({
  selector: 'su-display',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let m = model();
    <div class="glass">
      <div class="ann">
        @for (b of [0, 1, 2, 3]; track b) {
          <span [class.on]="m.bank === b">{{ b + 1 }}</span>
        }
        <span class="rec" [class.on]="m.rec">REC</span>
        <span class="gap"></span>
        @for (f of padFns; track f) {
          <span [class.on]="m.padFn && padLabel[m.padFn] === f">{{ f }}</span>
        }
        <span class="clip" [class.on]="m.clip">CLIP</span>
      </div>
      <img class="brand" src="su700-logo.svg" alt="SAMPLING UNIT SU700" draggable="false" />

      <div class="main">
        <div class="left">
          <div class="alpha" [class.blink]="m.blinkTop">
            @let l1 = line1();
            <span class="ghost">{{ ghost }}</span><span class="lit">{{ l1[0] }}<span class="flash">{{ l1[1] }}</span>{{ l1[2] }}</span>
          </div>
          <div class="alpha small2" [class.blink]="m.blinkValue">
            @let l2 = line2();
            <span class="ghost">{{ ghost }}</span><span class="lit">{{ l2[0] }}<span class="flash">{{ l2[1] }}</span>{{ l2[2] }}</span>
          </div>

          @if (m.input; as lr) {
            <div class="input">
              @for (ch of lr; track $index) {
                <div class="hbar">
                  <b>{{ $index ? 'R' : 'L' }}</b>
                  @for (s of hsegs; track s) {
                    <i [class.on]="level(ch) > s" [class.hot]="s >= 20"></i>
                  }
                </div>
              }
            </div>
          } @else {
            <div class="meters">
              @for (c of m.meters; track $index) {
                <div class="meter" [class]="colors[$index]" [class.bracket]="c.bracket" [class.sel]="c.selected">
                  @for (s of segs; track s) {
                    <i [class.on]="lit(c, s)"></i>
                  }
                  @if (c.value === null && (c.hasSample || c.hasSeq)) {
                    <u [class.seq]="c.hasSeq" [class.nosample]="!c.hasSample"></u>
                  }
                </div>
              }
            </div>
          }
        </div>

        <div class="right">
          <div class="num" [class.blink]="m.blink === 'measure'">
            <span class="ghost">888:8</span><span class="lit">{{ pad(m.measure, 5) }}</span>
          </div>
          <div class="num" [class.blink]="m.blink === 'bpm'">
            <span class="ghost">888.8</span><span class="lit">{{ pad(m.bpm, 5) }}</span>
          </div>
          <div class="note" [class.blink]="m.blink === 'note'">{{ m.note }}</div>
        </div>
      </div>
    </div>
  `,
  styles: `
    :host { display: block; }
    .glass {
      position: relative; width: 100%; height: 100%; box-sizing: border-box; padding: 5px 10px 6px 14px;
      border-radius: 4px; overflow: hidden; display: flex; flex-direction: column;
      background:
        linear-gradient(170deg, rgba(255,255,255,.07), transparent 35%),
        radial-gradient(ellipse at 50% 60%, #07121a, #020508 75%);
      box-shadow: inset 0 0 0 2px #05070a, inset 0 3px 8px rgba(0,0,0,.9);
      --cyan: #7ff3e6; --dim: rgba(127, 243, 230, .08);
    }
    /* Printed legend, placed where it sits on the real glass (panel coords 469,421 minus the glass origin). */
    .brand { position: absolute; left: 176.3px; top: 6.6px; width: 181.2px; pointer-events: none; }
    /* Indicator row sits below the printed legend, as on the unit. */
    .ann {
      margin-top: 22px; display: flex; gap: 5px; font: 700 5.5px/1 Arial, sans-serif; color: var(--dim);
      padding-right: 100px;
    }
    .ann .on { color: var(--cyan); text-shadow: 0 0 4px var(--cyan); }
    .ann .rec.on, .ann .clip.on { color: #ff5a4a; text-shadow: 0 0 4px #ff5a4a; }
    .ann .gap { flex: 0 0 10px; }

    .main { display: flex; flex: 1; margin-top: 4px; gap: 8px; }
    .left { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .right { width: 92px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
    .alpha, .num { position: relative; line-height: 1; }
    .alpha > span, .num > span { white-space: pre; }
    .ghost { color: var(--dim); }
    .lit { position: absolute; left: 0; top: 0; color: var(--cyan); text-shadow: 0 0 5px rgba(127,243,230,.8); }
    .alpha { font: 13.5px DSEG14; }
    .alpha.small2 { font-size: 9.5px; margin-top: 4px; }
    .num { font: 17px DSEG7; }
    .num .lit { color: #b8fff4; }
    .note { font: 700 7px/1 Arial, sans-serif; color: var(--cyan); min-height: 7px; letter-spacing: .5px; }
    .blink .lit, .note.blink, .flash { animation: blink .8s steps(2) infinite; }
    @keyframes blink { 50% { opacity: .15; } }

    .meters { display: flex; gap: 4px; margin-top: auto; }
    .meter {
      position: relative; display: flex; flex-direction: column-reverse; gap: 1.2px; width: 13px;
      padding: 3px 0; border-top: 1.5px solid transparent; border-bottom: 1.5px solid transparent;
    }
    .meter.bracket { border-color: color-mix(in srgb, currentColor 70%, transparent); }
    .meter.sel::after {
      content: ''; position: absolute; left: 50%; bottom: -5px; width: 3px; height: 2px; margin-left: -1.5px;
      background: currentColor;
    }
    .meter i { height: 3px; background: currentColor; opacity: .1; border-radius: .5px; }
    .meter i.on { opacity: 1; box-shadow: 0 0 4px currentColor; }
    .meter u { position: absolute; left: 3px; right: 3px; top: 50%; height: 5px; margin-top: -2.5px;
      border-top: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; }
    /* Sample plus sequence data: six centre bars instead of two (p.244). */
    .meter u.seq { height: 17px; margin-top: -8.5px;
      background: repeating-linear-gradient(currentColor 0 1.5px, transparent 1.5px 4.2px); border: 0; }
    .meter u.seq.nosample { opacity: .5; }
    .meter.orange { color: #ffae3d; }
    .meter.white  { color: #dcfff8; }
    .meter.blue   { color: #6aa4ff; }
    .meter.red    { color: #ff4e4e; }

    .input { margin-top: auto; display: flex; flex-direction: column; gap: 4px; }
    .hbar { display: flex; gap: 1.5px; align-items: center; color: var(--cyan); }
    .hbar b { font: 700 6px/1 Arial, sans-serif; width: 7px; }
    .hbar i { width: 7px; height: 7px; background: currentColor; opacity: .1; }
    .hbar i.on { opacity: 1; box-shadow: 0 0 4px currentColor; }
    .hbar i.hot { color: #ff5a4a; }
  `,
})
export class Display {
  readonly model = input.required<DisplayModel>();

  protected readonly colors = METER_COLORS;
  protected readonly segs = Array.from({ length: SEGS }, (_, i) => i);
  protected readonly hsegs = Array.from({ length: 24 }, (_, i) => i);
  protected readonly padFns = ['PLAY', 'ON/MUTE', 'LOOP RESTART'];
  protected readonly padLabel = PAD_FN_LABEL;
  protected readonly ghost = '~'.repeat(WIDTH);
  protected readonly line1 = computed(() => split(seg(this.model().top), this.model().topRange));
  protected readonly line2 = computed(() => split(seg(this.model().value), this.model().valueRange));

  protected pad(s: string, n: number): string {
    return s.padStart(n, '!');
  }

  /** Horizontal input meter: 24 segments over roughly -48..0 dBFS. */
  protected level(v: number): number {
    return v <= 0 ? 0 : Math.max(0, ((20 * Math.log10(v) + 48) / 48) * 24);
  }

  protected lit(c: MeterCell, s: number): boolean {
    if (c.value === null) return false;
    if (!c.bipolar) return c.value * SEGS > s + 0.25;
    // Bipolar: grow up or down from the centre line.
    const d = (c.value - 0.5) * SEGS;
    const mid = SEGS / 2;
    return d >= 0 ? s >= mid && s < mid + Math.max(0.5, d) : s < mid && s >= mid + d;
  }
}
