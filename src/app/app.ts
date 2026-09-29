import { Component, inject, isDevMode } from '@angular/core';
import { Su700Panel } from './panel/su700-panel';
import { SourceTray } from './source/source-tray';
import { UnitController } from './unit-controller';

@Component({
  selector: 'app-root',
  imports: [Su700Panel, SourceTray],
  template: `
    <su-panel />
    <su-source-tray />
  `,
})
export class App {
  constructor() {
    // Handy for poking at the emulator from the dev-tools console.
    if (isDevMode()) {
      const unit = inject(UnitController);
      Object.assign(window, { su700: { unit, seq: unit.seq, engine: unit.engine } });
    }
  }
}
