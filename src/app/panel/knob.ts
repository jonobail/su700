import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';

export type KnobColor = 'orange' | 'white' | 'blue' | 'red' | 'dark' | 'dark-red';

/** [skirt, cap, indicator] colours, matte plastics sampled from photos of the unit. */
const PALETTE: Record<KnobColor, [string, string, string]> = {
  orange: ['#d9793a', '#ef9149', '#3a2a20'],
  white: ['#cfc8b2', '#e9e3cf', '#3a3830'],
  blue: ['#8d91ab', '#a6aac2', '#2c2e3a'],
  red: ['#c63a35', '#e14a42', '#3a1c1a'],
  dark: ['#1b1c20', '#2a2c31', '#e9e9e6'],
  'dark-red': ['#1b1c20', '#2a2c31', '#e5423a'],
};

/** Serrated skirt outline: `teeth` ridges between radii r1 and r2 (viewBox units). */
function gear(teeth: number, r1: number, r2: number): string {
  const pts: string[] = [];
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const r = i % 2 ? r1 : r2;
    pts.push(`${(Math.sin(a) * r).toFixed(2)},${(-Math.cos(a) * r).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}
const SKIRT = gear(18, 34.5, 40.5);

/** Tick marks for the scaled knobs (ANALOG LEVEL, MASTER VOLUME): -135°..135°. */
const TICKS = Array.from({ length: 11 }, (_, i) => -135 + i * 27);



/** Rotary knob: drag up/down (or scroll) to turn, double-click to reset. Value is 0..1. */
function capture(el: Element, id: number): void {
  try {
    el.setPointerCapture(id);
  } catch {
    // Synthetic events have no active pointer to capture.
  }
}

@Component({
  selector: 'su-knob',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let p = palette[color()];
    <svg [attr.width]="size() + 16" [attr.height]="size() + 16" [attr.viewBox]="scale() ? '-66 -66 132 132' : '-50 -50 100 100'">
      @if (scale()) {
        @for (t of ticks; track t) {
          <line x1="0" y1="-55" x2="0" y2="-62" [attr.transform]="'rotate(' + t + ')'" class="tick" />
        }
      }
      <circle r="49" class="well" />
      <g [attr.transform]="'rotate(' + (value() * 270 - 135) + ')'">
        <path [attr.d]="skirt" [attr.fill]="p[0]" class="skirt" />
        <circle r="29" [attr.fill]="p[1]" />
        <circle r="29" fill="url(#knob-sheen)" />
        <line x1="0" y1="-10" x2="0" y2="-27" [attr.stroke]="p[2]" stroke-width="4" stroke-linecap="round" />
      </g>
      <defs>
        <radialGradient id="knob-sheen" cx="40%" cy="35%" r="70%">
          <stop offset="0" stop-color="#fff" stop-opacity=".1" />
          <stop offset="1" stop-color="#000" stop-opacity=".06" />
        </radialGradient>
      </defs>
    </svg>
  `,
  styles: `
    :host { display: inline-block; touch-action: none; cursor: ns-resize; user-select: none; line-height: 0; }
    svg { overflow: visible; }
    .well { fill: #333848; }
    .skirt { filter: drop-shadow(0 3px 2px rgba(0,0,0,.45)); stroke: rgba(0,0,0,.18); stroke-width: .8; }
    .tick { stroke: #e6e7ea; stroke-width: 3; }
  `,
  host: {
    '(pointerdown)': 'start($event)',
    '(wheel)': 'wheel($event)',
    '(dblclick)': 'reset.emit()',
  },
})
export class Knob {
  readonly value = model(0);
  readonly color = input<KnobColor>('white');
  readonly size = input(30);
  /** Draw a printed tick scale around the knob. */
  readonly scale = input(false);

  protected readonly palette = PALETTE;
  protected readonly skirt = SKIRT;
  protected readonly ticks = TICKS;
  readonly reset = output<void>();

  start(e: PointerEvent): void {
    const el = e.currentTarget as HTMLElement;
    capture(el, e.pointerId);
    let lastY = e.clientY;
    const move = (m: PointerEvent) => {
      const fine = m.shiftKey ? 0.2 : 1;
      this.set(this.value() + ((lastY - m.clientY) / 150) * fine);
      lastY = m.clientY;
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  wheel(e: WheelEvent): void {
    e.preventDefault();
    this.set(this.value() - Math.sign(e.deltaY) / 64);
  }

  private set(v: number): void {
    this.value.set(Math.min(1, Math.max(0, v)));
  }
}
