import { ChangeDetectionStrategy, Component, output, signal } from '@angular/core';

/** The big DATA dial. Drag around it (or scroll) to step values up/down. */
function capture(el: Element, id: number): void {
  try {
    el.setPointerCapture(id);
  } catch {
    // Synthetic events have no active pointer to capture.
  }
}

@Component({
  selector: 'su-jog-wheel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ring">
      <div class="dial" [style.transform]="'rotate(' + angle() + 'deg)'">
        <span class="dimple"></span>
      </div>
    </div>
  `,
  styles: `
    :host { display: block; width: 108px; height: 108px; touch-action: none; cursor: grab; user-select: none; }
    .ring {
      width: 100%; height: 100%; border-radius: 50%; display: grid; place-items: center;
      background: #2c3141;
      box-shadow: inset 0 2px 3px rgba(0,0,0,.5), 0 1px 0 rgba(255,255,255,.05);
    }
    .dial {
      position: relative; width: 92%; height: 92%; border-radius: 50%;
      background: radial-gradient(circle at 45% 35%, #2a2b30, #1c1d21 70%);
      box-shadow: 0 3px 5px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,255,255,.04);
    }
    .dimple {
      position: absolute; left: 50%; top: 11%; width: 26px; height: 26px; margin-left: -13px;
      border-radius: 50%;
      background: #141518;
      box-shadow: inset 0 2px 3px rgba(0,0,0,.8), 0 1px 0 rgba(255,255,255,.07);
    }
  `,
  host: { '(pointerdown)': 'start($event)', '(wheel)': 'wheel($event)' },
})
export class JogWheel {
  /** Emits +1 / -1 per detent (clockwise = +1). */
  readonly turn = output<number>();
  protected readonly angle = signal(0);
  private acc = 0;

  start(e: PointerEvent): void {
    const el = e.currentTarget as HTMLElement;
    capture(el, e.pointerId);
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let last = Math.atan2(e.clientY - cy, e.clientX - cx);
    const move = (m: PointerEvent) => {
      const a = Math.atan2(m.clientY - cy, m.clientX - cx);
      let d = ((a - last) * 180) / Math.PI;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      last = a;
      this.rotate(d);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }

  wheel(e: WheelEvent): void {
    e.preventDefault();
    this.rotate(e.deltaY > 0 ? -15 : 15);
  }

  private rotate(deg: number): void {
    this.angle.update((a) => a + deg);
    this.acc += deg;
    const DETENT = 15;
    while (Math.abs(this.acc) >= DETENT) {
      const step = Math.sign(this.acc);
      this.acc -= step * DETENT;
      this.turn.emit(step);
    }
  }
}
