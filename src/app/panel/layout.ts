import { KnobFn } from '../core/knob-functions';
import { JobGroup } from '../jobs';

/*
 * Faceplate geometry, in "panel units" measured off the reference photo (1000 × 871).
 * x/y are control centres.
 */

export const PANEL_W = 1000;
export const PANEL_H = 871;

/** Column centres shared by the mode buttons, function grid and scene buttons. */
export const GRID_X = [353, 399, 445, 491, 537, 584, 630, 677];

// ---------------- KNOB FUNCTION (left column) ----------------

export interface KnobFnButton {
  label: string;
  x: number;
  param?: KnobFn;
  /** Non-knob-function buttons in the lower half (CLEAR/SETUP/JOB/NAME). */
  action?: string;
  gray?: boolean;
}
export interface KnobFnRow {
  y: number;
  buttons: KnobFnButton[];
}

const C = [124, 174, 224];

export const KNOB_FN_ROWS: KnobFnRow[] = [
  { y: 74, buttons: [{ label: 'LEVEL', x: C[0], param: 'level' }, { label: 'PAN', x: C[1], param: 'pan' }, { label: 'PITCH', x: C[2], param: 'pitch' }] },
  { y: 111, buttons: [{ label: 'ATTACK', x: C[0], param: 'attack' }, { label: 'RELEASE', x: C[1], param: 'release' }, { label: 'LENGTH', x: C[2], param: 'length' }] },
  { y: 148, buttons: [{ label: 'TIMING', x: C[0], param: 'grvTiming' }, { label: 'VELOCITY', x: C[1], param: 'grvVelocity' }, { label: 'GATETIME', x: C[2], param: 'grvGate' }] },
  { y: 185, buttons: [{ label: 'SPEED', x: C[0], param: 'lfoSpeed' }, { label: 'AMP', x: C[1], param: 'lfoAmp' }] },
  { y: 222, buttons: [{ label: 'FILTER', x: C[0], param: 'lfoFilter' }, { label: 'PITCH', x: C[1], param: 'lfoPitch' }] },
  { y: 258, buttons: [{ label: 'HI GAIN', x: C[0], param: 'eqHiGain' }, { label: 'HI FREQ', x: C[1], param: 'eqHiFreq' }] },
  { y: 295, buttons: [{ label: 'LO GAIN', x: C[0], param: 'eqLoGain' }, { label: 'LO FREQ', x: C[1], param: 'eqLoFreq' }] },
  { y: 342, buttons: [{ label: 'CUTOFF', x: C[0], param: 'cutoff' }, { label: 'RESONANCE', x: C[1], param: 'resonance' }] },
  { y: 379, buttons: [{ label: 'EFFECT 1', x: C[0], param: 'effect1' }, { label: 'EFFECT 2', x: C[1], param: 'effect2' }, { label: 'EFFECT 3', x: C[2], param: 'effect3' }] },
  { y: 416, buttons: [{ label: 'CLEAR 1', x: C[0], action: 'CLEAR 1', gray: true }, { label: 'CLEAR 2', x: C[1], action: 'CLEAR 2', gray: true }, { label: 'CLEAR 3', x: C[2], action: 'CLEAR 3', gray: true }] },
  { y: 452, buttons: [{ label: 'SETUP 1', x: C[0], action: 'SETUP 1', gray: true }, { label: 'SETUP 2', x: C[1], action: 'SETUP 2', gray: true }, { label: 'SETUP 3', x: C[2], action: 'SETUP 3', gray: true }] },
  { y: 489, buttons: [{ label: 'KNOB RESET', x: C[0], action: 'KNOB RESET', gray: true }, { label: 'NOTE DEL', x: C[1], action: 'NOTE DEL', gray: true }] },
  { y: 526, buttons: [{ label: 'INSERT', x: C[0], action: 'INSERT', gray: true }, { label: 'DELETE', x: C[1], action: 'DELETE', gray: true }] },
];

/** White section tabs down the far left: [label, top, bottom]. */
export const KNOB_FN_TABS: [string, number, number][] = [
  ['SOUND', 50, 123], ['GROOVE', 127, 161], ['LFO', 165, 233], ['EQ', 237, 306],
  ['FILTER', 318, 356], ['EFFECT', 359, 393], ['EFFECT\nSETUP', 396, 463], ['JOB', 467, 499], ['NAME', 503, 536],
];

// ---------------- Mode buttons + function grid ----------------

export const MODES: { label: string; mode: JobGroup }[] = [
  { label: 'SONG', mode: 'song' }, { label: 'TRACK\nSET', mode: 'trackSet' },
  { label: 'TRACK\nEDIT', mode: 'trackEdit' }, { label: 'EVENT\nEDIT', mode: 'eventEdit' },
  { label: 'SAMPLE', mode: 'sample' }, { label: 'RESAMPLE', mode: 'resample' },
  { label: 'DISK', mode: 'disk' }, { label: 'SYSTEM', mode: 'system' },
];

export const GRID_ROWS_Y = [111, 148, 185, 222];

/** Function grid text, [row][column]; '' = empty cell. */
export const FUNCTION_GRID: string[][] = [
  ['NAME', 'MAIN', 'TRACK\nCOPY', 'LOCATION\n& VALUE', 'START\nPOINT', 'TRACK', 'LOAD', 'SETUP'],
  ['COPY', 'FILTER\nTYPE', 'TRACK\nINIT', 'NOTE\nCLEAR', 'END\nPOINT', 'SEQ', 'SAVE', 'MIDI'],
  ['INIT', 'NOTE\nASSIGN', 'EVENT\nCOPY', 'EVENT\nCLEAR', 'PROCESS', '', 'DELETE', 'SCSI'],
  ['MTC\nOFFSET', 'SETUP', 'EVENT\nINIT', 'MEA-\nSURES', 'DELETE', '', 'UTILITY', 'MEMORY'],
];

// ---------------- Scene / transport ----------------

export const SCENES = ['TOP', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];

export const TRANSPORT = [
  { id: 'rec', x: 320 },
  { id: 'top', x: 390 },
  { id: 'rew', x: 441 },
  { id: 'stop', x: 493 },
  { id: 'play', x: 545 },
  { id: 'ff', x: 597 },
] as const;

// ---------------- Knobs + pads ----------------

export const KNOB_X = [172, 232, 292, 352, 412, 472, 532, 592, 652, 712, 772, 832];
export const KNOB_COLORS = [
  'orange', 'orange', 'white', 'white', 'white', 'white', 'blue', 'blue', 'blue', 'blue', 'orange', 'red',
] as const;

/** Pads: [left, top, width, height, colour]. The composed-loop and free pads are taller. */
export const PADS: [number, number, number, number, string][] = [
  [150, 708, 50, 49, 'orange'], [210, 708, 50, 49, 'orange'],
  [270, 681, 49, 76, 'gray'], [330, 681, 49, 76, 'gray'], [390, 681, 49, 76, 'gray'], [450, 681, 49, 76, 'gray'],
  [510, 681, 49, 76, 'blue'], [570, 681, 49, 76, 'blue'], [630, 681, 49, 76, 'blue'], [690, 681, 49, 76, 'blue'],
  [748, 708, 49, 49, 'orange'], [808, 708, 49, 49, 'red'],
];

/** Captions under the pads: [label, left, right]. */
export const PAD_GROUPS: [string, number, number][] = [
  ['LOOP', 150, 260], ['COMPOSED LOOP', 270, 499], ['FREE', 510, 739], ['AUDIO IN', 748, 797], ['MASTER', 806, 857],
];

/** Computer-keyboard shortcuts for the 12 pads. */
export const PAD_KEYS = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']'];

export const TRACK_BANK = [
  { y: 685, color: 'gray' }, { y: 716, color: 'blue' }, { y: 746, color: 'orange' }, { y: 777, color: 'red' },
];

export const PAD_FUNCTIONS = [
  { fn: 'play', label: 'PLAY', y: 688, color: 'gray' },
  { fn: 'mute', label: 'ON/MUTE', y: 719, color: 'blue' },
  { fn: 'roll', label: 'ROLL', y: 749, color: 'orange' },
  { fn: 'restart', label: 'LOOP\nRESTART', y: 782, color: 'red' },
] as const;
