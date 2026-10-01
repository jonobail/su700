import {
  EFFECT_FREQS, EffectBlock, EffectDef, EffectSetup, effectDef, resSeconds, reverbSeconds,
} from '../core/effects';

/*
 * The three effect blocks as Web Audio graphs (Owner's Manual ch. 7). Native nodes only, so the
 * rack also runs where AudioWorklet is unavailable (plain-http hosts).
 *
 *   tracks ─send─▶ in ─▶ fx ─▶ dry/wet ─▶ LEVEL ─▶ PAN ─▶ out (to MASTER)
 *                                 └─ EF2 SEND / EF3 SEND ─▶ later blocks
 */

const freq = (i: number) => EFFECT_FREQS[Math.max(0, Math.min(60, Math.round(i)))];
const db = (g: number) => Math.pow(10, g / 20);
const lvl = (v: number) => Math.pow(v / 127, 2);
/** FBLEVEL -63..+63 → feedback gain (kept below unity). */
const fb = (v: number) => (v / 63) * 0.9;
/** FBHIDMP 1–10: low values damp the highs in the loop faster. */
const damp = (v: number) => 1500 * Math.pow(12, (v - 1) / 9);
const filterQ = (v: number) => v / 10;
const lfoHz = (v: number) => 0.05 * Math.pow(400, v / 127);
const WAVE_TYPES: OscillatorType[] = ['sine', 'triangle', 'square', 'sawtooth'];

/** Graph-building helpers; every node made through here is torn down with the effect. */
class G {
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly timers: ReturnType<typeof setTimeout>[] = [];

  constructor(readonly ctx: AudioContext, readonly input: GainNode, readonly output: GainNode) {}

  private add<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  gain(v = 1): GainNode {
    const g = this.add(this.ctx.createGain());
    g.gain.value = v;
    return g;
  }

  /** A gain that sums its input to mono. */
  mono(): GainNode {
    const g = this.gain();
    g.channelCount = 1;
    g.channelCountMode = 'explicit';
    g.channelInterpretation = 'speakers';
    return g;
  }

  delay(max = 2): DelayNode {
    return this.add(this.ctx.createDelay(max));
  }

  biquad(type: BiquadFilterType, f = 1000, q = 0.7, gainDb = 0): BiquadFilterNode {
    const b = this.add(this.ctx.createBiquadFilter());
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    b.gain.value = gainDb;
    return b;
  }

  shaper(curve: Float32Array<ArrayBuffer>): WaveShaperNode {
    const w = this.add(this.ctx.createWaveShaper());
    w.curve = curve;
    w.oversample = '2x';
    return w;
  }

  panner(): StereoPannerNode {
    return this.add(this.ctx.createStereoPanner());
  }

  split(): ChannelSplitterNode {
    return this.add(this.ctx.createChannelSplitter(2));
  }

  merge(): ChannelMergerNode {
    return this.add(this.ctx.createChannelMerger(2));
  }

  compressor(): DynamicsCompressorNode {
    return this.add(this.ctx.createDynamicsCompressor());
  }

  convolver(): ConvolverNode {
    const c = this.add(this.ctx.createConvolver());
    c.normalize = true;
    return c;
  }

  /** An oscillator feeding a depth gain; connect `out` to AudioParams. `phase` in degrees (sine only). */
  lfo(type: OscillatorType = 'sine', phase = 0): { osc: OscillatorNode; out: GainNode } {
    const osc = this.ctx.createOscillator();
    if (phase && type === 'sine') {
      const r = (phase * Math.PI) / 180;
      osc.setPeriodicWave(this.ctx.createPeriodicWave(new Float32Array([0, Math.sin(r)]), new Float32Array([0, Math.cos(r)])));
    } else {
      osc.type = type;
    }
    const out = this.gain(0);
    osc.connect(out);
    osc.start();
    this.sources.push(osc);
    this.nodes.push(osc);
    return { osc, out };
  }

  /** Looping noise: white hiss, or sparse crackle impulses. */
  noise(kind: 'white' | 'crackle' = 'white'): AudioBufferSourceNode {
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = kind === 'white' ? Math.random() * 2 - 1 : Math.random() < 0.0006 ? (Math.random() * 2 - 1) * 0.9 : 0;
      }
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start();
    this.sources.push(src);
    this.nodes.push(src);
    return src;
  }

  /** Smoothly set an AudioParam. */
  set(p: AudioParam, v: number, tc = 0.02): void {
    if (Number.isFinite(v)) p.setTargetAtTime(v, this.ctx.currentTime, tc);
  }

  /** Run `fn` once things stop changing (expensive rebuilds such as reverb impulses). */
  debounce(fn: () => void, ms = 120): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.length = 0;
    this.timers.push(setTimeout(fn, ms));
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* never started */
      }
    }
    for (const n of this.nodes) n.disconnect();
    this.input.disconnect();
  }
}

/** Per-update timing for synchronised effects. */
interface Timing {
  /** Seconds per resolution step. */
  res: number;
}

type Update = (p: number[], t: Timing) => void;
type Builder = (g: G) => Update;

// ---------------------------------------------------------------------------
// Shared pieces

/** Distortion curve: `drive` 0..1, `edge` 0 (soft) .. 1 (hard). */
function driveCurve(drive: number, edge: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const c = new Float32Array(n);
  const k = 1 + drive * 60;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const soft = Math.tanh(k * x) / Math.tanh(k);
    const hard = Math.max(-1, Math.min(1, k * x * 0.5));
    c[i] = soft * (1 - edge) + hard * edge;
  }
  return c;
}

/** Staircase curve: amplitude quantised to `levels` steps (bit reduction). */
function crushCurve(levels: number): Float32Array<ArrayBuffer> {
  const n = 4096;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(x * levels) / levels;
  }
  return c;
}

/** Full-wave rectifier, for envelope followers. */
const RECTIFY = (() => {
  const c = new Float32Array(1024);
  for (let i = 0; i < c.length; i++) c[i] = Math.abs((i / (c.length - 1)) * 2 - 1);
  return c;
})();

/** Low / high shelving EQ pair. Returns [in, out]. */
function shelves(g: G): { input: AudioNode; out: AudioNode; set(lo: number, hi: number): void } {
  const lo = g.biquad('lowshelf', 400);
  const hi = g.biquad('highshelf', 4000);
  lo.connect(hi);
  return { input: lo, out: hi, set: (l, h) => (g.set(lo.gain, l), g.set(hi.gain, h)) };
}

/** A delay line with damped feedback: in → delay → damp → fb ⟲. */
function echo(g: G, max = 4): { input: AudioNode; out: AudioNode; delay: DelayNode; fbGain: GainNode; damp: BiquadFilterNode } {
  const input = g.gain();
  const delay = g.delay(max);
  const dampF = g.biquad('lowpass', 8000);
  const fbGain = g.gain(0);
  input.connect(delay).connect(dampF);
  dampF.connect(fbGain).connect(delay);
  return { input, out: dampF, delay, fbGain, damp: dampF };
}

/** Decaying-noise impulse response for the reverbs. */
function impulse(ctx: AudioContext, sec: number, diffusion: number, preDelay: number, brightness: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.ceil(rate * (sec + preDelay));
  const buf = ctx.createBuffer(2, len, rate);
  const pre = Math.floor(preDelay * rate);
  const density = 0.25 + (diffusion / 10) * 0.75;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / rate;
      const env = Math.pow(10, (-3 * t) / sec); // -60 dB at RT60
      const x = Math.random() < density ? Math.random() * 2 - 1 : 0;
      lp += (x - lp) * brightness;
      d[i] = lp * env;
    }
  }
  return buf;
}

/** Early-reflection taps for the reverbs (seconds, gains). */
const ER_TAPS: Record<string, [number, number][]> = {
  HALL: [[0.019, 0.6], [0.031, 0.5], [0.047, 0.45], [0.061, 0.35], [0.083, 0.3]],
  ROOM: [[0.007, 0.7], [0.013, 0.55], [0.019, 0.45], [0.026, 0.35]],
  STAGE: [[0.013, 0.65], [0.023, 0.5], [0.036, 0.4], [0.05, 0.3]],
  PLATE: [[0.004, 0.5], [0.009, 0.4]],
  CANYON: [[0.09, 0.6], [0.21, 0.45], [0.37, 0.35], [0.55, 0.25]],
};
const PRE_DELAY: Record<string, number> = { HALL: 0.025, ROOM: 0.006, STAGE: 0.015, PLATE: 0.002, CANYON: 0.12 };
const BRIGHT: Record<string, number> = { HALL: 0.45, ROOM: 0.6, STAGE: 0.5, PLATE: 0.85, CANYON: 0.35 };

// ---------------------------------------------------------------------------
// Effect families

const reverbFx = (id: string): Builder => (g) => {
  const hpf = g.biquad('highpass', 50);
  const lpf = g.biquad('lowpass', 8000);
  const conv = g.convolver();
  const revGain = g.gain();
  const erGain = g.gain();
  g.input.connect(hpf).connect(lpf);
  lpf.connect(conv).connect(revGain).connect(g.output);
  for (const [t, a] of ER_TAPS[id]) {
    const d = g.delay(1);
    d.delayTime.value = t;
    const p = g.panner();
    p.pan.value = (Math.random() * 2 - 1) * 0.7;
    const a1 = g.gain(a);
    lpf.connect(d).connect(a1).connect(p).connect(erGain);
  }
  erGain.connect(g.output);
  let last = '';
  return (p) => {
    const [time, lp, hp, erRev, diff] = p;
    g.set(lpf.frequency, lp >= 60 ? 20000 : freq(lp));
    g.set(hpf.frequency, hp <= 0 ? 10 : freq(hp));
    const rev = (erRev + 64) / 127; // E63>R .. E<R63
    g.set(revGain.gain, Math.sqrt(rev) * 1.2);
    g.set(erGain.gain, Math.sqrt(1 - rev));
    const key = `${time}:${diff}`;
    if (key !== last) {
      last = key;
      g.debounce(() => (conv.buffer = impulse(g.ctx, reverbSeconds(time), diff, PRE_DELAY[id], BRIGHT[id])));
    }
  };
};

/** 1DELAY / 2DELAY / X-DELAY. */
const delayFx = (kind: '1' | '2' | 'x'): Builder => (g) => {
  const eq = shelves(g);
  if (kind === '1') {
    const e = echo(g);
    g.input.connect(e.input);
    e.out.connect(eq.input);
    eq.out.connect(g.output);
    return (p, t) => {
      g.set(e.delay.delayTime, Math.min(4, t.res));
      g.set(e.fbGain.gain, fb(p[0]));
      g.set(e.damp.frequency, damp(p[1]));
      eq.set(p[2], p[3]);
    };
  }
  const split = g.split();
  const merge = g.merge();
  const l = echo(g);
  const r = echo(g);
  const inL = g.gain();
  const inR = g.gain();
  g.input.connect(split);
  split.connect(inL, 0);
  split.connect(inR, 1);
  inL.connect(l.input);
  inR.connect(r.input);
  l.out.connect(merge, 0, 0);
  r.out.connect(merge, 0, 1);
  merge.connect(eq.input);
  eq.out.connect(g.output);
  if (kind === 'x') {
    // Cross feedback: each line's output feeds the other's input.
    l.fbGain.disconnect();
    r.fbGain.disconnect();
    l.fbGain.connect(r.delay);
    r.fbGain.connect(l.delay);
  }
  return (p, t) => {
    const time = Math.min(4, t.res);
    g.set(l.delay.delayTime, time);
    g.set(r.delay.delayTime, kind === '2' ? Math.min(4, time * 1.5) : time);
    for (const e of [l, r]) {
      g.set(e.fbGain.gain, fb(p[0]));
      g.set(e.damp.frequency, damp(p[1]));
    }
    if (kind === 'x') {
      const sel = p[2]; // L, R, L/R
      g.set(inL.gain, sel === 1 ? 0 : 1);
      g.set(inR.gain, sel === 0 ? 0 : 1);
      eq.set(p[3], p[4]);
    } else {
      eq.set(p[2], p[3]);
    }
  };
};

/** 3DELAY: L, C and R taps plus a feedback delay (all times free). */
const delay3Fx: Builder = (g) => {
  const ms = (v: number) => 0.0001 + v * 0.0117; // 0.1 ms – 1.49 s
  const mono = g.mono();
  const fbDelay = g.delay(2);
  const fbGain = g.gain();
  const merge = g.merge();
  g.input.connect(mono);
  mono.connect(fbDelay).connect(fbGain).connect(mono);
  const taps = [0, 1, 2].map(() => g.delay(2));
  const [dl, dr, dc] = taps;
  for (const d of taps) mono.connect(d);
  dl.connect(merge, 0, 0);
  dr.connect(merge, 0, 1);
  const cHalf = g.gain(0.7);
  dc.connect(cHalf);
  cHalf.connect(merge, 0, 0);
  cHalf.connect(merge, 0, 1);
  merge.connect(g.output);
  return (p) => {
    g.set(dl.delayTime, ms(p[0]));
    g.set(dr.delayTime, ms(p[1]));
    g.set(dc.delayTime, ms(p[2]));
    g.set(fbDelay.delayTime, ms(p[3]));
    g.set(fbGain.gain, fb(p[4]));
  };
};

/** DELAY+AUTO PAN: synced echo, panned by an LFO, with a mid-band EQ. */
const delayPanFx: Builder = (g) => {
  const e = echo(g);
  const mid = g.biquad('peaking', 1000, 1);
  const pan = g.panner();
  const lfo = g.lfo('sine');
  lfo.out.connect(pan.pan);
  g.input.connect(e.input);
  e.out.connect(mid).connect(pan).connect(g.output);
  return (p, t) => {
    g.set(e.delay.delayTime, Math.min(4, t.res));
    g.set(e.fbGain.gain, fb(p[0]));
    g.set(e.damp.frequency, damp(p[1]));
    g.set(lfo.out.gain, p[2] / 127);
    g.set(lfo.osc.frequency, 1 / (t.res * 4));
    g.set(mid.gain, p[3]);
    g.set(mid.frequency, freq(p[4]));
  };
};

/** CHORUS / FLANGER: modulated short delays per channel. */
const modDelayFx = (kind: 'chorus' | 'flanger'): Builder => (g) => {
  const split = g.split();
  const merge = g.merge();
  const eq = shelves(g);
  const pre = g.gain();
  g.input.connect(pre).connect(split);
  const lines = [0, 1].map((ch) => {
    const d = g.delay(0.1);
    const fbG = g.gain(0);
    const lfo = g.lfo('sine', ch === 1 ? (kind === 'chorus' ? 180 : 90) : 0);
    lfo.out.connect(d.delayTime);
    split.connect(d, ch);
    d.connect(fbG).connect(d);
    d.connect(merge, 0, ch);
    return { d, fbG, lfo };
  });
  merge.connect(eq.input);
  eq.out.connect(g.output);
  let phase = 999;
  return (p, t) => {
    const hz = 1 / Math.max(0.05, t.res);
    if (kind === 'chorus') {
      const [depth, lo, hi, , mode] = p;
      pre.channelCount = mode === 0 ? 1 : 2;
      pre.channelCountMode = 'explicit';
      eq.set(lo, hi);
      for (const l of lines) {
        g.set(l.d.delayTime, 0.02);
        g.set(l.lfo.out.gain, (depth / 127) * 0.008);
        g.set(l.lfo.osc.frequency, hz);
      }
    } else {
      const [depth, fbl, offset, ph] = p;
      for (const l of lines) {
        g.set(l.d.delayTime, 0.0005 + offset * 0.00015 + (depth / 127) * 0.003);
        g.set(l.lfo.out.gain, (depth / 127) * 0.003);
        g.set(l.lfo.osc.frequency, hz);
        g.set(l.fbG.gain, fb(fbl));
      }
      if (ph !== phase) {
        phase = ph;
        const r = (ph * Math.PI) / 180;
        lines[1].lfo.osc.setPeriodicWave(g.ctx.createPeriodicWave(new Float32Array([0, Math.sin(r)]), new Float32Array([0, Math.cos(r)])));
      }
    }
  };
};

const phaserFx: Builder = (g) => {
  const stages = Array.from({ length: 12 }, () => g.biquad('allpass', 800, 0.6));
  const lfo = g.lfo('sine');
  const sum = g.gain();
  const fbDelay = g.delay(0.01);
  const fbG = g.gain(0);
  g.input.connect(sum);
  for (const s of stages) lfo.out.connect(s.detune);
  let wired = -1;
  return (p, t) => {
    const [depth, shift, fbl, count] = p;
    if (count !== wired) {
      wired = count;
      sum.disconnect();
      for (const s of stages) s.disconnect();
      fbG.disconnect();
      let node: AudioNode = sum;
      for (let i = 0; i < count; i++) node = node.connect(stages[i]);
      node.connect(g.output);
      node.connect(fbDelay).connect(fbG).connect(sum);
      for (const s of stages) lfo.out.connect(s.detune);
    }
    for (const s of stages) g.set(s.frequency, 100 * Math.pow(2, (shift / 127) * 6));
    g.set(lfo.out.gain, (depth / 127) * 2400);
    g.set(lfo.osc.frequency, 1 / Math.max(0.05, t.res));
    g.set(fbG.gain, fb(fbl) * 0.8);
  };
};

/** TREMOLO, TREMOLO(BPM). */
const tremoloFx = (synced: boolean): Builder => (g) => {
  const pre = g.gain();
  const amp = g.gain(1);
  const d = g.delay(0.05);
  const lfo = g.lfo('sine');
  const pm = g.lfo('sine');
  const eq = shelves(g);
  lfo.out.connect(amp.gain);
  pm.out.connect(d.delayTime);
  g.input.connect(pre).connect(d).connect(amp).connect(eq.input);
  eq.out.connect(g.output);
  return (p, t) => {
    const [a, b, c, e, f] = p;
    const depth = synced ? a : b;
    const mode = synced ? e : f;
    pre.channelCount = mode === 0 ? 1 : 2;
    pre.channelCountMode = 'explicit';
    const hz = synced ? 1 / Math.max(0.03, t.res) : lfoHz(a);
    g.set(lfo.osc.frequency, hz);
    g.set(pm.osc.frequency, hz);
    g.set(amp.gain, 1 - (depth / 127) / 2);
    g.set(lfo.out.gain, (depth / 127) / 2);
    g.set(d.delayTime, 0.006);
    g.set(pm.out.gain, synced ? (b / 127) * 0.005 : 0);
    if (synced) eq.set(f, 0);
    else eq.set(c, e);
  };
};

const autoPanFx: Builder = (g) => {
  const pan = g.panner();
  const amp = g.gain(1);
  const lr = g.lfo('sine');
  const fr = g.lfo('sine', 90);
  const eq = shelves(g);
  lr.out.connect(pan.pan);
  fr.out.connect(amp.gain);
  g.input.connect(eq.input);
  eq.out.connect(pan).connect(amp).connect(g.output);
  let dir = -1;
  return (p, t) => {
    const [lrD, frD, d, lo, hi] = p;
    if (d !== dir) {
      dir = d;
      // L<>R sine, L>R / L<R ramps, L@ / R@ circling, L/R square (p.340).
      lr.osc.type = d === 5 ? 'square' : d === 1 || d === 2 ? 'sawtooth' : 'sine';
    }
    const sign = d === 2 || d === 4 ? -1 : 1;
    const hz = 1 / Math.max(0.05, t.res);
    g.set(lr.osc.frequency, hz);
    g.set(fr.osc.frequency, hz);
    g.set(lr.out.gain, sign * (lrD / 127));
    g.set(amp.gain, 1 - (frD / 127) * 0.4);
    g.set(fr.out.gain, (frD / 127) * 0.4);
    eq.set(lo, hi);
  };
};

const rotaryFx: Builder = (g) => {
  const d = g.delay(0.05);
  const amp = g.gain(1);
  const pan = g.panner();
  const lfo = g.lfo('sine');
  const eq = shelves(g);
  const dDepth = g.gain(0);
  const aDepth = g.gain(0);
  const pDepth = g.gain(0);
  lfo.out.gain.value = 1;
  lfo.out.connect(dDepth).connect(d.delayTime);
  lfo.out.connect(aDepth).connect(amp.gain);
  lfo.out.connect(pDepth).connect(pan.pan);
  g.input.connect(d).connect(amp).connect(pan).connect(eq.input);
  eq.out.connect(g.output);
  return (p) => {
    const [speed, depth, lo, hi] = p;
    const k = depth / 127;
    g.set(lfo.osc.frequency, 0.5 + (speed / 127) * 7.5);
    g.set(d.delayTime, 0.004);
    g.set(dDepth.gain, k * 0.0015);
    g.set(amp.gain, 1 - k * 0.25);
    g.set(aDepth.gain, k * 0.25);
    g.set(pDepth.gain, k * 0.6);
    eq.set(lo, hi);
  };
};

/** FLANGING PAN: a flanger and an auto-pan locked to the same synced LFO. */
const flangePanFx: Builder = (g) => {
  const fl = g.delay(0.05);
  const panDl = g.delay(0.1);
  const fbG = g.gain(0);
  const lvlG = g.gain();
  const pan = g.panner();
  const lfo = g.lfo('triangle');
  const flDepth = g.gain(0);
  lfo.out.gain.value = 1;
  lfo.out.connect(flDepth).connect(fl.delayTime);
  lfo.out.connect(pan.pan);
  g.input.connect(fl).connect(panDl).connect(lvlG).connect(pan).connect(g.output);
  panDl.connect(fbG).connect(fl);
  return (p, t) => {
    const [flDly, panDly, panFb, level] = p;
    g.set(fl.delayTime, 0.001 + (flDly / 127) * 0.008);
    g.set(flDepth.gain, 0.0015);
    g.set(panDl.delayTime, 0.001 + (panDly / 127) * 0.05);
    g.set(fbG.gain, fb(panFb));
    g.set(lvlG.gain, lvl(level) * 1.5);
    g.set(lfo.osc.frequency, 1 / Math.max(0.05, t.res));
  };
};

/** NOISY MOD DELAY, NOISE AMBIENT: synced delays with noise and modulation. */
const noisyDelayFx = (ambient: boolean): Builder => (g) => {
  const e = echo(g);
  const noise = g.noise('white');
  const noiseG = g.gain(0);
  const noiseLp = g.biquad('bandpass', 2500, 0.8);
  const lfo = g.lfo('sine');
  const amp = g.gain(1);
  const am = g.lfo('sine');
  lfo.out.connect(e.delay.delayTime);
  am.out.connect(amp.gain);
  noise.connect(noiseLp).connect(noiseG).connect(e.input);
  g.input.connect(e.input);
  e.out.connect(amp).connect(g.output);
  return (p, t) => {
    const [speed, depth, c, d] = p;
    g.set(e.delay.delayTime, Math.min(3.5, t.res));
    g.set(lfo.osc.frequency, lfoHz(speed));
    g.set(lfo.out.gain, (depth / 127) * 0.006);
    g.set(noiseG.gain, 0.02 + (depth / 127) * 0.05);
    if (ambient) {
      g.set(e.fbGain.gain, [0.25, 0.45, 0.6, 0.75][c]);
      g.set(amp.gain, 1 - (d / 127) * 0.4);
      g.set(am.out.gain, (d / 127) * 0.4);
      g.set(am.osc.frequency, 1 / Math.max(0.05, t.res));
    } else {
      lfo.osc.type = WAVE_TYPES[c];
      g.set(e.fbGain.gain, fb(d));
    }
  };
};

const flowPanFx: Builder = (g) => {
  const prePan = g.panner();
  const preLfo = g.lfo('sine');
  const e = echo(g);
  const pan = g.panner();
  const lfo = g.lfo('sine');
  const wetG = g.gain();
  const dryG = g.gain();
  preLfo.out.connect(prePan.pan);
  lfo.out.connect(pan.pan);
  lfo.out.gain.value = 1;
  g.input.connect(prePan);
  prePan.connect(e.input);
  prePan.connect(dryG).connect(pan);
  e.out.connect(wetG).connect(pan);
  pan.connect(g.output);
  return (p, t) => {
    const [speed, mix, fbl, hd, prp] = p;
    g.set(e.delay.delayTime, Math.min(4, t.res));
    g.set(e.fbGain.gain, fb(fbl));
    g.set(e.damp.frequency, damp(hd));
    g.set(wetG.gain, mix / 127);
    g.set(dryG.gain, 1 - mix / 127);
    g.set(lfo.osc.frequency, lfoHz(speed));
    g.set(preLfo.osc.frequency, 1 / Math.max(0.05, t.res * 2));
    g.set(preLfo.out.gain, prp / 127);
  };
};

/** DIST / OVERDRV / AMPSIM / COMP+DS: drive stages. */
const driveFx = (kind: 'dist' | 'od' | 'amp' | 'compds'): Builder => (g) => {
  const comp = g.compressor();
  const pre = g.gain();
  const shaper = g.shaper(driveCurve(0.5, 0.5));
  const mid = g.biquad('peaking', 1000, 0.9, 6);
  const cab1 = g.biquad('peaking', 120, 0.8);
  const cab2 = g.biquad('peaking', 2500, 1);
  const lpf = g.biquad('lowpass', 6000, 0.7);
  const out = g.gain();
  g.input.connect(comp).connect(pre).connect(shaper).connect(mid).connect(cab1).connect(cab2).connect(lpf).connect(out).connect(g.output);
  let curveKey = '';
  const curve = (dr: number, edge: number) => {
    const key = `${dr}:${edge}`;
    if (key !== curveKey) {
      curveKey = key;
      shaper.curve = driveCurve(dr / 127, edge);
    }
  };
  // AMPSIM cabinets [f1, g1, f2, g2]: OFF flat; STACK big lows and bite; COMBO open mids; TUBE warm, rolled-off highs.
  const CABS: [number, number, number, number][] = [[120, 0, 2500, 0], [100, 5, 2200, 4], [250, 3, 1600, 3], [180, 4, 1200, -3]];
  return (p) => {
    let threshold = 0, ratio = 1, midGain = 0, midFreq = 1000, cab = CABS[0];
    let dr: number, edge: number, lp: number, ol: number;
    if (kind === 'amp') {
      [dr, , lp, , ol] = p;
      edge = p[3] / 127;
      cab = CABS[p[1]];
    } else if (kind === 'compds') {
      [threshold, , dr, lp, ol] = p;
      ratio = RATIOS[p[1]];
      edge = 0.6;
    } else {
      [dr, lp, , ol] = p;
      edge = kind === 'dist' ? 0.85 : 0.1;
      midGain = 6;
      midFreq = freq(p[2]);
    }
    curve(dr, edge);
    g.set(comp.threshold, threshold);
    g.set(comp.ratio, ratio);
    g.set(comp.attack, 0.005);
    g.set(pre.gain, 1 + (dr / 127) * (kind === 'amp' ? 4 : 3));
    g.set(mid.frequency, midFreq);
    g.set(mid.gain, midGain);
    g.set(cab1.frequency, cab[0]);
    g.set(cab1.gain, cab[1]);
    g.set(cab2.frequency, cab[2]);
    g.set(cab2.gain, cab[3]);
    g.set(lpf.frequency, lp >= 60 ? 20000 : freq(lp));
    g.set(out.gain, lvl(ol) * 1.3);
  };
};

const RATIOS = [1, 1.5, 2, 3, 5, 7, 10, 20];

const compFx: Builder = (g) => {
  const comp = g.compressor();
  const out = g.gain();
  g.input.connect(comp).connect(out).connect(g.output);
  return (p) => {
    const [th, at, rel, ratio, ol] = p;
    g.set(comp.threshold, th);
    g.set(comp.attack, at / 1000);
    g.set(comp.release, rel / 1000);
    g.set(comp.ratio, RATIOS[ratio]);
    g.set(comp.knee, 6);
    g.set(out.gain, lvl(ol) * 2);
  };
};

/** TOUCH WAH / AUTO WAH into distortion or overdrive. */
const wahFx = (touch: boolean, hard: boolean): Builder => (g) => {
  const wah = g.biquad('bandpass', 600, 4);
  const shaper = g.shaper(driveCurve(0.5, hard ? 0.85 : 0.1));
  const pre = g.gain();
  const lpf = g.biquad('lowpass', 5000);
  const trim = g.gain(0.45);
  const env = g.gain(0); // envelope or LFO → wah detune (cents)
  g.input.connect(wah).connect(pre).connect(shaper).connect(lpf).connect(trim).connect(g.output);
  let lfo: { osc: OscillatorNode; out: GainNode } | null = null;
  if (touch) {
    const rect = g.shaper(RECTIFY);
    const smooth = g.biquad('lowpass', 12, 0.5);
    g.input.connect(rect).connect(smooth).connect(env).connect(wah.detune);
  } else {
    lfo = g.lfo('sine');
    lfo.out.connect(wah.detune);
  }
  let drv = -1;
  return (p, t) => {
    // TOUCH: FRQOFST, RESO, DRIVE, DR LPF, DRY/WET.  AUTO: DEPTH, FRQOFST, RESO, DRIVE, DRY/WET.
    const [offset, reso, dr] = touch ? [p[0], p[1], p[2]] : [p[1], p[2], p[3]];
    g.set(wah.frequency, 250 * Math.pow(2, (offset / 127) * 3));
    g.set(wah.Q, filterQ(reso));
    if (touch) {
      g.set(env.gain, 9000);
      g.set(lpf.frequency, p[3] >= 60 ? 20000 : freq(p[3]));
    } else if (lfo) {
      g.set(lfo.out.gain, (p[0] / 127) * 2400);
      g.set(lfo.osc.frequency, 1 / Math.max(0.05, t.res));
      g.set(lpf.frequency, 6000);
    }
    if (dr !== drv) {
      drv = dr;
      shaper.curve = driveCurve(dr / 127, hard ? 0.85 : 0.1);
    }
    g.set(pre.gain, 1 + (dr / 127) * 3);
  };
};

/** TECH MODULATION: ring modulation after a high-pass. */
const techModFx: Builder = (g) => {
  const hpf = g.biquad('highpass', 100);
  const ring = g.gain(0);
  const lfo = g.lfo('sine');
  const out = g.gain();
  lfo.out.connect(ring.gain);
  g.input.connect(hpf).connect(ring).connect(out).connect(g.output);
  return (p) => {
    const [speed, depth, hp, gainDb] = p;
    g.set(lfo.osc.frequency, 20 * Math.pow(100, speed / 127));
    g.set(lfo.out.gain, depth / 127);
    g.set(ring.gain, 1 - depth / 127);
    g.set(hpf.frequency, hp <= 0 ? 10 : freq(hp));
    g.set(out.gain, db(gainDb) * 1.4);
  };
};

/** AUTO SYNTH: a synced filter and gate sweep with an echo. */
const autoSynthFx: Builder = (g) => {
  const lpL = g.biquad('lowpass', 800, 8);
  const amp = g.gain(1);
  const lfo = g.lfo('square');
  const ampLfo = g.lfo('square');
  const e = echo(g);
  const dl = g.gain(0);
  lfo.out.connect(lpL.detune);
  ampLfo.out.connect(amp.gain);
  g.input.connect(lpL).connect(amp).connect(g.output);
  amp.connect(e.input);
  e.out.connect(dl).connect(g.output);
  return (p, t) => {
    const [speed, wave, depth, ofst, dly] = p;
    lfo.osc.type = WAVE_TYPES[wave];
    const hz = 1 / Math.max(0.03, t.res / 4);
    g.set(lfo.osc.frequency, hz);
    g.set(ampLfo.osc.frequency, hz);
    g.set(lpL.frequency, 200 * Math.pow(2, (speed / 127) * 5));
    g.set(lfo.out.gain, (depth / 127) * 3600);
    g.set(amp.gain, 0.5);
    g.set(ampLfo.out.gain, 0.5 * (1 + ofst / 127));
    g.set(e.delay.delayTime, Math.min(4, t.res / 2));
    g.set(e.fbGain.gain, 0.35);
    g.set(dl.gain, lvl(dly));
  };
};

/** DIGITAL SCRATCH: a synced triangle sweeping a delay line's read point (tape-style doppler). */
const scratchFx: Builder = (g) => {
  const hpf = g.biquad('highpass', 60);
  const d = g.delay(1);
  const lfo = g.lfo('triangle');
  const pan = g.panner();
  const panLfo = g.lfo('sine');
  lfo.out.connect(d.delayTime);
  panLfo.out.connect(pan.pan);
  g.input.connect(hpf).connect(d).connect(pan).connect(g.output);
  return (p, t) => {
    const [input, dly, hp, panD] = p;
    const swing = (input / 127) * 0.12;
    g.set(d.delayTime, 0.01 + (dly / 127) * 0.2 + swing);
    g.set(lfo.out.gain, swing);
    g.set(lfo.osc.frequency, 1 / Math.max(0.03, t.res));
    g.set(hpf.frequency, hp <= 0 ? 10 : freq(hp));
    g.set(panLfo.out.gain, panD / 127);
    g.set(panLfo.osc.frequency, 1 / Math.max(0.05, t.res * 2));
  };
};

/** JUMP: chops the input and replays slices (TYPE A gate, B repeat, C warble). */
const jumpFx: Builder = (g) => {
  const gate = g.gain(1);
  const gateLfo = g.lfo('square');
  const d = g.delay(1.1);
  const fbG = g.gain(0);
  const warble = g.lfo('sine');
  gateLfo.out.connect(gate.gain);
  warble.out.connect(d.delayTime);
  g.input.connect(gate).connect(d).connect(g.output);
  d.connect(fbG).connect(d);
  return (p) => {
    const [depth, type, wave, res] = p;
    const seg = Math.max(0.004, 1 / Math.pow(2, res));
    const k = depth / 127;
    gateLfo.osc.type = WAVE_TYPES[wave];
    g.set(gateLfo.osc.frequency, 1 / seg);
    g.set(gate.gain, 1 - k / 2);
    g.set(gateLfo.out.gain, type === 0 ? k / 2 : 0);
    g.set(d.delayTime, type === 1 ? Math.min(1, seg) : 0.005);
    g.set(fbG.gain, type === 1 ? k * 0.85 : 0);
    g.set(warble.osc.frequency, 1 / seg);
    g.set(warble.out.gain, type === 2 ? k * 0.004 : 0);
  };
};

/**
 * Delay-line pitch shifter: two delay lines read by sawtooth ramps half a cycle apart, each
 * faded in and out so the wrap-around is hidden.
 */
function shifter(g: G, input: AudioNode, output: AudioNode): (semitones: number, initDelay: number) => void {
  const WINDOW = 0.05;
  const lines = [0, 180].map((phase) => {
    const d = g.delay(1);
    const ramp = g.lfo('sawtooth', 0);
    const fade = g.gain(0);
    const fadeLfo = g.lfo('sine', phase + 90);
    if (phase) {
      // Second ramp half a cycle behind: a phase-shifted sawtooth from its Fourier series.
      const N = 32;
      const real = new Float32Array(N);
      const imag = new Float32Array(N);
      for (let k = 1; k < N; k++) {
        const r = Math.PI * k; // shift by half a period
        const a = (2 / (Math.PI * k)) * (k % 2 ? 1 : -1);
        real[k] = a * Math.sin(r);
        imag[k] = a * Math.cos(r);
      }
      ramp.osc.setPeriodicWave(g.ctx.createPeriodicWave(real, imag));
    }
    ramp.out.connect(d.delayTime);
    fadeLfo.out.connect(fade.gain);
    input.connect(d).connect(fade).connect(output);
    return { d, ramp, fade, fadeLfo };
  });
  return (semi, init) => {
    const ratio = Math.pow(2, semi / 12);
    const hz = Math.abs(1 - ratio) / WINDOW || 0.0001;
    const dir = ratio > 1 ? -1 : 1;
    for (const l of lines) {
      g.set(l.ramp.osc.frequency, hz, 0.01);
      g.set(l.ramp.out.gain, (dir * WINDOW) / 2, 0.01);
      g.set(l.d.delayTime, init + WINDOW / 2, 0.01);
      g.set(l.fadeLfo.osc.frequency, hz, 0.01);
      g.set(l.fade.gain, 0.5);
      g.set(l.fadeLfo.out.gain, 0.5);
    }
  };
}

const pitchFx = (dual: boolean): Builder => (g) => {
  const sum = g.gain();
  const fbD = g.delay(1);
  const fbG = g.gain(0);
  g.input.connect(sum);
  if (!dual) {
    const out = g.gain();
    const set = shifter(g, sum, out);
    out.connect(g.output);
    out.connect(fbD).connect(fbG).connect(sum);
    return (p) => {
      set(p[0] + p[1] / 100, (p[2] / 127) * 0.4);
      g.set(fbG.gain, fb(p[3]));
    };
  }
  const split = g.split();
  const merge = g.merge();
  const l = g.gain();
  const r = g.gain();
  const outL = g.gain();
  const outR = g.gain();
  sum.connect(split);
  split.connect(l, 0);
  split.connect(r, 1);
  const setL = shifter(g, l, outL);
  const setR = shifter(g, r, outR);
  outL.connect(merge, 0, 0);
  outR.connect(merge, 0, 1);
  merge.connect(g.output);
  merge.connect(fbD).connect(fbG).connect(sum);
  return (p) => {
    const init = (p[2] / 127) * 0.4;
    setL(p[0] / 100, init);
    setR(p[1] / 100, init);
    g.set(fbG.gain, fb(p[3]));
  };
};

/** VOICE CANCELER: removes the centre (L+R) content between the two band limits. */
const voiceCancelFx: Builder = (g) => {
  const split = g.split();
  const merge = g.merge();
  const mid = g.gain(0.5);
  const hp = g.biquad('highpass', 200);
  const lp = g.biquad('lowpass', 4000);
  const inv = g.gain(-1);
  g.input.connect(split);
  split.connect(merge, 0, 0);
  split.connect(merge, 1, 1);
  split.connect(mid, 0);
  split.connect(mid, 1);
  mid.connect(hp).connect(lp).connect(inv);
  inv.connect(merge, 0, 0);
  inv.connect(merge, 0, 1);
  merge.connect(g.output);
  return (p) => {
    g.set(hp.frequency, 80 * Math.pow(2, (p[0] / 26) * 3));
    g.set(lp.frequency, 1500 * Math.pow(2, (p[1] / 26) * 3.5));
  };
};

const ambienceFx: Builder = (g) => {
  const split = g.split();
  const merge = g.merge();
  const dl = g.delay(0.2);
  const dr = g.delay(0.2);
  const inv = g.gain(-1);
  const eq = shelves(g);
  const mono = g.mono();
  g.input.connect(mono).connect(split);
  split.connect(dl, 0);
  split.connect(dr, 0);
  dl.connect(merge, 0, 0);
  dr.connect(inv).connect(merge, 0, 1);
  merge.connect(eq.input);
  eq.out.connect(g.output);
  return (p) => {
    const t = 0.002 + (p[0] / 127) * 0.06;
    g.set(dl.delayTime, t);
    g.set(dr.delayTime, t * 1.37);
    g.set(inv.gain, p[1] === 1 ? -1 : 1);
    eq.set(p[2], p[3]);
  };
};

/** LOW RESOLUTION: bit reduction plus a modulated short delay; RESOLTN 1 … 1/256. */
const loResoFx: Builder = (g) => {
  const crush = g.shaper(crushCurve(32768));
  const d = g.delay(0.1);
  const lfo = g.lfo('sine');
  const split = g.split();
  const merge = g.merge();
  const invR = g.gain(1);
  lfo.out.connect(d.delayTime);
  g.input.connect(crush).connect(d).connect(split);
  split.connect(merge, 0, 0);
  split.connect(invR, 1).connect(merge, 0, 1);
  merge.connect(g.output);
  let res = -1;
  return (p) => {
    const [depth, ofst, r, phase] = p;
    if (r !== res) {
      res = r;
      crush.curve = crushCurve(Math.max(1, 32768 / Math.pow(2, r * 1.6)));
    }
    g.set(d.delayTime, 0.0005 + (ofst / 127) * 0.01);
    g.set(lfo.out.gain, (depth / 127) * 0.004);
    g.set(lfo.osc.frequency, 0.3);
    g.set(invR.gain, phase === 0 ? 1 : -1);
  };
};

const noisyFx: Builder = (g) => {
  const pre = g.gain();
  const shaper = g.shaper(driveCurve(0.5, 0.4));
  const noise = g.noise('white');
  const am = g.gain(1);
  const noiseG = g.gain(0);
  const lpf = g.biquad('lowpass', 5000, 2);
  const trim = g.gain(0.3); // the shaper runs near full scale; bring it back to the others' level
  noise.connect(noiseG).connect(am.gain);
  g.input.connect(pre).connect(shaper).connect(am).connect(lpf).connect(trim).connect(g.output);
  let drv = -1;
  return (p) => {
    const [dr, depth, lp, q] = p;
    if (dr !== drv) {
      drv = dr;
      shaper.curve = driveCurve(dr / 127, 0.4);
    }
    g.set(pre.gain, 1 + (dr / 127) * 3);
    g.set(noiseG.gain, depth / 12);
    g.set(lpf.frequency, lp >= 60 ? 20000 : freq(lp));
    g.set(lpf.Q, filterQ(q));
  };
};

/** ATTACK LOFI: transient emphasis, reduced resolution, a peak and a low-pass, with a synced flange. */
const attackLofiFx: Builder = (g) => {
  const comp = g.compressor();
  const makeup = g.gain();
  const crush = g.shaper(crushCurve(32768));
  const peak = g.biquad('peaking', 1000, 2, 6);
  const lpf = g.biquad('lowpass', 6000);
  const d = g.delay(0.05);
  const lfo = g.lfo('triangle');
  lfo.out.connect(d.delayTime);
  const trim = g.gain(0.4);
  g.input.connect(comp).connect(makeup).connect(crush).connect(peak).connect(lpf).connect(trim);
  trim.connect(d).connect(g.output);
  trim.connect(g.output);
  let res = -1;
  return (p, t) => {
    const [sens, r, pk, lp] = p;
    g.set(comp.threshold, -6 - (sens / 127) * 40);
    g.set(comp.ratio, 8);
    g.set(comp.attack, 0.03); // slow attack lets the transient through
    g.set(comp.release, 0.08);
    g.set(makeup.gain, 1 + (sens / 127) * 2);
    if (r !== res) {
      res = r;
      crush.curve = crushCurve(r === 0 ? 32768 : [0, 64, 24, 10, 4][r]);
    }
    g.set(peak.frequency, freq(pk));
    g.set(lpf.frequency, lp >= 60 ? 20000 : freq(lp));
    g.set(d.delayTime, 0.003);
    g.set(lfo.out.gain, 0.002);
    g.set(lfo.osc.frequency, 1 / Math.max(0.05, t.res));
  };
};

const radioFx: Builder = (g) => {
  const hpf = g.biquad('highpass', 300);
  const lpf = g.biquad('lowpass', 3000);
  const modLp = g.biquad('lowpass', 2000, 4);
  const shaper = g.shaper(driveCurve(0.3, 0.2));
  const wobble = g.lfo('sine');
  const trim = g.gain(0.3);
  wobble.out.connect(modLp.detune);
  g.input.connect(hpf).connect(shaper).connect(modLp).connect(lpf).connect(trim).connect(g.output);
  return (p) => {
    const [mlp, mq, hp, lp] = p;
    g.set(modLp.frequency, freq(mlp));
    g.set(modLp.Q, filterQ(mq));
    g.set(wobble.osc.frequency, 0.4);
    g.set(wobble.out.gain, 300);
    g.set(hpf.frequency, hp <= 0 ? 10 : freq(hp));
    g.set(lpf.frequency, lp >= 60 ? 20000 : freq(lp));
  };
};

/** DIGITAL TURNTABLE: record noise, clicks and the input through a worn, filtered path. */
const turntableFx: Builder = (g) => {
  const hiss = g.noise('white');
  const crackle = g.noise('crackle');
  const hissLp = g.biquad('lowpass', 3000, 1);
  const hissG = g.gain(0);
  const clickG = g.gain(0);
  const dry = g.gain();
  const tone = g.biquad('lowpass', 8000);
  hiss.connect(hissLp).connect(hissG).connect(g.output);
  crackle.connect(clickG).connect(g.output);
  g.input.connect(tone).connect(dry).connect(g.output);
  return (p) => {
    const [noiseLvl, nsTone, q, click, dryNois] = p;
    g.set(hissG.gain, lvl(noiseLvl) * 0.06);
    g.set(hissLp.frequency, 800 * Math.pow(2, nsTone));
    g.set(hissLp.Q, filterQ(q));
    g.set(clickG.gain, lvl(click) * 1.2);
    g.set(dry.gain, dryNois / 127);
    g.set(tone.frequency, 3000 + (dryNois / 127) * 9000);
  };
};

const BUILDERS: Record<string, Builder> = {
  TECHMOD: techModFx, AUTOSYN: autoSynthFx, SCRATCH: scratchFx, JUMP: jumpFx,
  PITCH1: pitchFx(false), PITCH2: pitchFx(true), VCECNCL: voiceCancelFx, AMBIENC: ambienceFx,
  'LO RESO': loResoFx, NOISY: noisyFx, ATKLOFI: attackLofiFx, RADIO: radioFx, TURNTBL: turntableFx,
  DIST: driveFx('dist'), OVERDRV: driveFx('od'), AMPSIM: driveFx('amp'), COMP: compFx, 'COMP+DS': driveFx('compds'),
  'TWAH+DS': wahFx(true, true), 'TWAH+OD': wahFx(true, false), 'AWAH+DS': wahFx(false, true), 'AWAH+OD': wahFx(false, false),
  AUTOPAN: autoPanFx, TREMOLO: tremoloFx(false), TRM_BPM: tremoloFx(true), ROTARY: rotaryFx,
  CHORUS: modDelayFx('chorus'), PHASER: phaserFx, FLANGER: modDelayFx('flanger'), FLNGPAN: flangePanFx,
  NOISDLY: noisyDelayFx(false), NOISAMB: noisyDelayFx(true), FLOWPAN: flowPanFx,
  '3DELAY': delay3Fx, '2DELAY': delayFx('2'), '1DELAY': delayFx('1'), 'X-DELAY': delayFx('x'), 'DLY+PAN': delayPanFx,
  HALL: reverbFx('HALL'), ROOM: reverbFx('ROOM'), STAGE: reverbFx('STAGE'), PLATE: reverbFx('PLATE'), CANYON: reverbFx('CANYON'),
};

// ---------------------------------------------------------------------------

/** One effect block: the effect graph between `fxIn` and its dry/wet mix, then LEVEL and PAN. */
class Block {
  /** Track sends arrive here; for insertion effects its gain is the MASTER track's EFFECT level. */
  readonly input: GainNode;
  /** EF2 / EF3 sends from earlier blocks (not scaled by the MASTER level). */
  readonly chainInput: GainNode;
  /** The effect's output after DRY/WET, before LEVEL / PAN; feeds the EF sends. */
  readonly mixed: GainNode;
  private readonly fxIn: GainNode;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly level: GainNode;
  private readonly pan: StereoPannerNode;
  private graph: { g: G; update: Update; def: EffectDef; inner: GainNode } | null = null;

  constructor(private readonly ctx: AudioContext, out: AudioNode) {
    this.input = ctx.createGain();
    this.chainInput = ctx.createGain();
    this.fxIn = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.mixed = ctx.createGain();
    this.level = ctx.createGain();
    this.pan = ctx.createStereoPanner();
    this.input.connect(this.fxIn);
    this.chainInput.connect(this.fxIn);
    this.fxIn.connect(this.dry).connect(this.mixed);
    this.wet.connect(this.mixed);
    this.mixed.connect(this.level).connect(this.pan).connect(out);
  }

  configure(b: EffectBlock, bpm: number): void {
    const def = effectDef(b.type);
    if (this.graph?.def !== def) {
      if (this.graph) {
        this.fxIn.disconnect(this.graph.inner);
        this.graph.g.dispose();
      }
      const inner = this.ctx.createGain();
      this.fxIn.connect(inner);
      const g = new G(this.ctx, inner, this.wet);
      this.graph = { g, update: BUILDERS[def.id](g), def, inner };
    }
    this.graph.update(b.params, { res: resSeconds(b.res, bpm) });
    const now = this.ctx.currentTime;
    const dwIndex = def.params.findIndex((p) => p.style === 'dryWet');
    const w = dwIndex >= 0 ? (b.params[dwIndex] + 64) / 127 : 1;
    this.dry.gain.setTargetAtTime(Math.cos((w * Math.PI) / 2), now, 0.02);
    this.wet.gain.setTargetAtTime(Math.sin((w * Math.PI) / 2), now, 0.02);
    this.level.gain.setTargetAtTime(lvl(b.level), now, 0.02);
    this.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, b.pan / 64)), now, 0.02);
  }
}

export class EffectRack {
  readonly blocks: Block[];
  private readonly ef2: GainNode;
  private readonly ef3From1: GainNode;
  private readonly ef3From2: GainNode;

  constructor(private readonly ctx: AudioContext, out: AudioNode) {
    this.blocks = [0, 1, 2].map(() => new Block(ctx, out));
    const [b1, b2, b3] = this.blocks;
    this.ef2 = ctx.createGain();
    this.ef3From1 = ctx.createGain();
    this.ef3From2 = ctx.createGain();
    for (const g of [this.ef2, this.ef3From1, this.ef3From2]) g.gain.value = 0;
    b1.mixed.connect(this.ef2).connect(b2.chainInput);
    b1.mixed.connect(this.ef3From1).connect(b3.chainInput);
    b2.mixed.connect(this.ef3From2).connect(b3.chainInput);
  }

  configure(setup: EffectSetup, bpm: number): void {
    setup.forEach((b, i) => this.blocks[i].configure(b, bpm));
    const now = this.ctx.currentTime;
    this.ef2.gain.setTargetAtTime(lvl(setup[0].ef2), now, 0.02);
    this.ef3From1.gain.setTargetAtTime(lvl(setup[0].ef3), now, 0.02);
    this.ef3From2.gain.setTargetAtTime(lvl(setup[1].ef3), now, 0.02);
  }
}
