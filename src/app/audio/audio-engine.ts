import { Injectable, signal } from '@angular/core';
import { EQ_HI_FREQS, EQ_LO_FREQS } from '../core/knob-functions';
import { AUDIO_IN, LfoWave, MASTER, TRACK_COUNT } from '../core/model';
import { Track } from '../core/song';

// ---- Knob value → audio units ----
// 127 is unity, so the MASTER default (127) is transparent and sample tracks (100) sit ~4 dB down.
const levelGain = (v: number) => Math.pow(v / 127, 2);
const cutoffHz = (v: number) => 30 * Math.pow(20000 / 30, v / 127);
const resonanceQ = (v: number) => 0.5 + Math.pow(v / 127, 2) * 24;
const eqDb = (v: number) => (v * 12) / 64;
export const attackSec = (v: number) => Math.pow(v / 127, 2) * 3;
export const releaseSec = (v: number) => Math.pow(v / 127, 2) * 4;
const lfoHz = (v: number) => 0.08 * Math.pow(250, v / 127);
const FILTER_TYPE: Record<string, BiquadFilterType> = { LPF: 'lowpass', BPF: 'bandpass', HPF: 'highpass', BEF: 'notch' };

/** Mixer channel strip for one track: filter → EQ → level → pan. */
class Strip {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly filter: BiquadFilterNode;
  private readonly eqLo: BiquadFilterNode;
  private readonly eqHi: BiquadFilterNode;
  private readonly level: GainNode;
  private readonly panner: StereoPannerNode;
  private readonly mute: GainNode;
  readonly voices = new Set<Voice>();

  constructor(private readonly ctx: AudioContext) {
    this.input = ctx.createGain();
    this.filter = ctx.createBiquadFilter();
    this.eqLo = ctx.createBiquadFilter();
    this.eqHi = ctx.createBiquadFilter();
    this.eqLo.type = this.eqHi.type = 'peaking';
    this.eqLo.Q.value = this.eqHi.Q.value = 0.9;
    this.level = ctx.createGain();
    this.panner = ctx.createStereoPanner();
    this.mute = ctx.createGain();
    this.output = ctx.createGain();
    this.input.connect(this.filter).connect(this.eqLo).connect(this.eqHi)
      .connect(this.level).connect(this.panner).connect(this.mute).connect(this.output);
  }

  apply(t: Track): void {
    const k = t.knobs();
    const now = this.ctx.currentTime;
    const set = (p: AudioParam, v: number) => p.setTargetAtTime(v, now, 0.008);
    set(this.level.gain, levelGain(k.level));
    set(this.panner.pan, Math.max(-1, Math.min(1, k.pan / 64)));
    if (t.kind === 'audioIn') {
      this.filter.type = 'allpass';
      set(this.eqLo.gain, 0);
      set(this.eqHi.gain, 0);
      return;
    }
    if (t.kind === 'master') {
      this.filter.type = 'allpass';
    } else {
      this.filter.type = FILTER_TYPE[t.filterType()];
      set(this.filter.frequency, cutoffHz(k.cutoff));
      set(this.filter.Q, resonanceQ(k.resonance));
    }
    set(this.eqLo.frequency, EQ_LO_FREQS[k.eqLoFreq]);
    set(this.eqLo.gain, eqDb(k.eqLoGain));
    set(this.eqHi.frequency, EQ_HI_FREQS[k.eqHiFreq]);
    set(this.eqHi.gain, eqDb(k.eqHiGain));
    for (const v of this.voices) v.applyPitch(k.pitch);
  }

  setMuted(muted: boolean, when = this.ctx.currentTime): void {
    this.mute.gain.setTargetAtTime(muted ? 0 : 1, when, 0.005);
  }
}

export interface VoiceOptions {
  when: number;
  /** Offset into the buffer, seconds. */
  offset: number;
  /** Seconds of buffer to play (default: to the end). */
  duration?: number;
  /** Fixed playback rate (CHNG PITCH loops, scratch); otherwise PITCH knob applies. */
  rate?: number;
  velocity: number;
  /** Context time of the note-off, if known up front. */
  gateEnd?: number;
  loop?: { start: number; end: number };
  buffer?: AudioBuffer;
  /** Overrides the track's ATTACK (e.g. slices get a short click-free fade). */
  attack?: number;
  release?: number;
  /** Marks voices started by the song (vs. played by hand), for NOTE ASSIGN. */
  source: 'song' | 'live' | 'loop' | 'roll';
}

export class Voice {
  readonly src: AudioBufferSourceNode;
  private readonly env: GainNode;
  private readonly lfoNodes: AudioScheduledSourceNode[] = [];
  private readonly lfoGains: GainNode[] = [];
  private ended = false;
  private readonly pitchFixed: boolean;

  constructor(
    private readonly ctx: AudioContext,
    readonly strip: Strip,
    track: Track,
    buffer: AudioBuffer,
    readonly opts: VoiceOptions,
  ) {
    const k = track.knobs();
    this.src = ctx.createBufferSource();
    this.src.buffer = opts.buffer ?? buffer;
    this.pitchFixed = opts.rate !== undefined;
    if (opts.rate !== undefined) this.src.playbackRate.value = opts.rate;
    else this.src.detune.value = k.pitch * 20;
    if (opts.loop) {
      this.src.loop = true;
      this.src.loopStart = opts.loop.start;
      this.src.loopEnd = opts.loop.end;
    }

    this.env = ctx.createGain();
    const peak = Math.pow(opts.velocity / 127, 1.5);
    const attack = Math.max(0.003, opts.attack ?? attackSec(k.attack));
    this.env.gain.setValueAtTime(0, opts.when);
    this.env.gain.linearRampToValueAtTime(peak, opts.when + attack);

    let out: AudioNode = this.env;
    this.src.connect(this.env);
    out = this.attachLfo(track, out);
    out.connect(strip.input);

    if (opts.duration !== undefined && !opts.loop) this.src.start(opts.when, opts.offset, opts.duration);
    else this.src.start(opts.when, opts.offset);
    if (opts.gateEnd !== undefined) this.noteOff(opts.gateEnd, opts.release ?? releaseSec(k.release));

    strip.voices.add(this);
    this.src.onended = () => this.cleanup();
  }

  /** Begin the release at `when`, then stop. */
  noteOff(when: number, release: number): void {
    if (this.ended) return;
    const r = Math.max(0.004, release);
    this.env.gain.cancelScheduledValues(when);
    this.env.gain.setTargetAtTime(0, when, r / 4);
    try {
      this.src.stop(when + r + 0.02);
    } catch {
      /* already stopped */
    }
  }

  /** Immediate choke (retrigger, mute-restart, roll suppression). */
  kill(when = this.ctx.currentTime): void {
    if (this.ended) return;
    this.env.gain.cancelScheduledValues(when);
    this.env.gain.setTargetAtTime(0, when, 0.003);
    try {
      this.src.stop(when + 0.02);
    } catch {
      /* already stopped */
    }
  }

  applyPitch(pitch: number): void {
    if (!this.pitchFixed) this.src.detune.setTargetAtTime(pitch * 20, this.ctx.currentTime, 0.01);
  }

  private attachLfo(track: Track, out: AudioNode): AudioNode {
    const k = track.knobs();
    if (track.kind === 'audioIn' || track.kind === 'master' || k.lfoSpeed === 0) return out;
    if (!k.lfoAmp && !k.lfoFilter && !k.lfoPitch) return out;
    const wave = track.lfoWave();
    const makeOsc = (w: LfoWave) => {
      const osc = this.ctx.createOscillator();
      osc.type = w === 'triangle' ? 'triangle' : w === 'square' ? 'square' : 'sawtooth';
      osc.frequency.value = lfoHz(k.lfoSpeed);
      osc.start(this.opts.when); // the LFO restarts on every note-on
      this.lfoNodes.push(osc);
      return osc;
    };
    const depth = (src: AudioNode, amount: number, target: AudioParam) => {
      const g = this.ctx.createGain();
      g.gain.value = amount;
      src.connect(g).connect(target);
      this.lfoGains.push(g);
    };
    const sign = wave === 'sawDown' ? -1 : 1;
    if (k.lfoPitch && !this.pitchFixed) depth(makeOsc(wave), sign * (k.lfoPitch / 127) * 1200, this.src.detune);
    if (k.lfoFilter) depth(makeOsc(wave), sign * (k.lfoFilter / 127) * 4800, this.strip.filter.detune);
    if (k.lfoAmp) {
      // AMP can't do saw-up: it falls back to saw-down (p.207).
      const d = k.lfoAmp / 127;
      const trem = this.ctx.createGain();
      trem.gain.value = 1 - d / 2;
      const ampWave = wave === 'sawUp' ? 'sawDown' : wave;
      depth(makeOsc(ampWave), (ampWave === 'sawDown' ? -1 : 1) * (d / 2), trem.gain);
      out.connect(trem);
      return trem;
    }
    return out;
  }

  private cleanup(): void {
    this.ended = true;
    for (const n of this.lfoNodes) n.stop();
    for (const g of this.lfoGains) g.disconnect();
    this.strip.voices.delete(this);
    this.env.disconnect();
  }
}

const RECORDER_WORKLET = `
class SuRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.on = false; this.port.onmessage = (e) => (this.on = e.data); }
  process(inputs) {
    const inp = inputs[0];
    if (this.on && inp.length) this.port.postMessage(inp.map((c) => c.slice()));
    return true;
  }
}
registerProcessor('su-recorder', SuRecorder);
`;

@Injectable({ providedIn: 'root' })
export class AudioEngine {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  readonly strips: Strip[];
  private readonly masterVolume: GainNode;
  readonly masterVolumeLevel = signal(0.8);

  // ---- AUDIO IN source (the uploaded / YouTube audio standing in for the analog inputs) ----
  readonly source = signal<{ id: string; name: string; buffer: AudioBuffer } | null>(null);
  readonly sourcePlaying = signal(false);
  readonly sourcePosition = signal(0);
  readonly sourceLoop = signal(true);
  private sourceNode: AudioBufferSourceNode | null = null;
  private sourceStartedAt = 0;
  private sourceOffset = 0;
  /** ANALOG LEVEL: input trim ahead of both the AUDIO IN strip and the sampler. */
  private readonly inputTrim: GainNode;
  private inputLevel = 0.7;
  /** SYSTEM | SETUP AUDIO IN (p.302). MIC adds preamp gain; OFF closes the AUDIO IN track only. */
  readonly audioInSource = signal<'LINE' | 'MIC' | 'OFF'>('LINE');
  private readonly audioInGate: GainNode;
  private readonly clicks = new Set<OscillatorNode>();
  private readonly inputMeters: [AnalyserNode, AnalyserNode];
  private readonly meterBuf = new Float32Array(1024);

  /** Turns input capture on/off; chunks land in recChunks. */
  private recorder: Promise<(on: boolean) => void>;
  private recChunks: Float32Array[][] = [];

  constructor() {
    this.strips = Array.from({ length: TRACK_COUNT }, () => new Strip(this.ctx));
    this.masterVolume = this.ctx.createGain();
    const master = this.strips[MASTER];
    for (const s of this.strips) if (s !== master) s.output.connect(master.input);
    master.output.connect(this.masterVolume).connect(this.ctx.destination);
    this.setMasterVolume(this.masterVolumeLevel());

    this.inputTrim = this.ctx.createGain();
    this.audioInGate = this.ctx.createGain();
    this.inputTrim.connect(this.audioInGate).connect(this.strips[AUDIO_IN].input);
    const split = this.ctx.createChannelSplitter(2);
    this.inputTrim.connect(split);
    this.inputMeters = [this.ctx.createAnalyser(), this.ctx.createAnalyser()];
    split.connect(this.inputMeters[0], 0);
    split.connect(this.inputMeters[1], 1);
    this.setInputLevel(0.7);

    this.recorder = this.initRecorder();
    const tick = () => {
      if (this.sourceNode) this.sourcePosition.set(this.currentSourcePos());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /** Browsers start audio suspended until a user gesture. */
  resume(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  applyTrack(t: Track): void {
    this.strips[t.index].apply(t);
  }

  setMuted(track: number, muted: boolean, when?: number): void {
    this.strips[track].setMuted(muted, when);
  }

  play(t: Track, buffer: AudioBuffer, opts: VoiceOptions): Voice {
    return new Voice(this.ctx, this.strips[t.index], t, buffer, opts);
  }

  voices(track: number): Voice[] {
    return [...this.strips[track].voices];
  }

  killVoices(track: number, filter: (v: Voice) => boolean = () => true, when?: number): void {
    for (const v of this.strips[track].voices) if (filter(v)) v.kill(when);
  }

  setMasterVolume(v: number): void {
    this.masterVolumeLevel.set(v);
    this.masterVolume.gain.setTargetAtTime(v * v * 1.25, this.ctx.currentTime, 0.01);
  }

  setInputLevel(v: number): void {
    this.inputLevel = v;
    const preamp = this.audioInSource() === 'MIC' ? 4 : 1;
    this.inputTrim.gain.setTargetAtTime(v * v * 2 * preamp, this.ctx.currentTime, 0.01);
  }

  setAudioInSource(src: 'LINE' | 'MIC' | 'OFF'): void {
    this.audioInSource.set(src);
    this.audioInGate.gain.setTargetAtTime(src === 'OFF' ? 0 : 1, this.ctx.currentTime, 0.01);
    this.setInputLevel(this.inputLevel);
  }

  /** Metronome click, straight to the stereo out (SYSTEM | SETUP METRONOME OUT=STEREO). */
  click(when: number, accent: boolean): void {
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? 1760 : 1320;
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(accent ? 0.3 : 0.18, when + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
    osc.connect(env).connect(this.masterVolume);
    osc.start(when);
    osc.stop(when + 0.05);
    this.clicks.add(osc);
    osc.onended = () => {
      this.clicks.delete(osc);
      env.disconnect();
    };
  }

  /** Drop clicks scheduled ahead (stop, locate). */
  cancelClicks(): void {
    for (const c of this.clicks) {
      try {
        c.stop();
      } catch {
        /* not started yet */
      }
    }
    this.clicks.clear();
  }

  /** Peak input level per channel (L, R), 0..1+. */
  inputPeaks(): [number, number] {
    return this.inputMeters.map((a) => {
      a.getFloatTimeDomainData(this.meterBuf);
      let p = 0;
      for (const x of this.meterBuf) p = Math.max(p, Math.abs(x));
      return p;
    }) as [number, number];
  }

  async decode(blob: Blob): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(await blob.arrayBuffer());
  }

  // ---------- Source transport ----------

  loadSource(id: string, name: string, buffer: AudioBuffer): void {
    this.stopSource();
    this.sourceOffset = 0;
    this.sourcePosition.set(0);
    this.source.set({ id, name, buffer });
  }

  playSource(from = this.sourceOffset): void {
    const s = this.source();
    if (!s) return;
    this.resume();
    this.stopSource(false);
    const node = this.ctx.createBufferSource();
    node.buffer = s.buffer;
    node.connect(this.inputTrim);
    this.sourceOffset = from >= s.buffer.duration ? 0 : from;
    this.sourceStartedAt = this.ctx.currentTime;
    node.start(0, this.sourceOffset);
    node.onended = () => {
      if (this.sourceNode !== node) return;
      this.sourceNode = null;
      this.sourceOffset = 0;
      this.sourcePlaying.set(false);
      if (this.sourceLoop()) this.playSource(0);
    };
    this.sourceNode = node;
    this.sourcePlaying.set(true);
  }

  stopSource(keepPosition = true): void {
    if (!this.sourceNode) return;
    const pos = this.currentSourcePos();
    const node = this.sourceNode;
    this.sourceNode = null;
    node.stop();
    this.sourceOffset = keepPosition ? pos : 0;
    this.sourcePosition.set(this.sourceOffset);
    this.sourcePlaying.set(false);
  }

  seekSource(sec: number): void {
    if (this.sourcePlaying()) this.playSource(sec);
    else {
      this.sourceOffset = sec;
      this.sourcePosition.set(sec);
    }
  }

  private currentSourcePos(): number {
    if (!this.sourceNode) return this.sourceOffset;
    return this.sourceOffset + (this.ctx.currentTime - this.sourceStartedAt);
  }

  // ---------- Sample recording ----------

  async startRecording(): Promise<void> {
    const setOn = await this.recorder;
    this.recChunks = [];
    setOn(true);
  }

  /** Stop capturing; returns the raw stereo capture at the context rate. */
  async stopRecording(discard = false): Promise<AudioBuffer | null> {
    const setOn = await this.recorder;
    setOn(false);
    await new Promise((r) => setTimeout(r, 50)); // let in-flight worklet messages land
    const chunks = this.recChunks;
    this.recChunks = [];
    if (discard || !chunks.length) return null;
    const length = chunks.reduce((n, c) => n + c[0].length, 0);
    const buf = this.ctx.createBuffer(2, length, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const out = buf.getChannelData(ch);
      let o = 0;
      for (const c of chunks) {
        out.set(c[ch] ?? c[0], o);
        o += c[0].length;
      }
    }
    return buf;
  }

  /** Seconds captured so far in the current recording. */
  recordedSeconds(): number {
    return this.recChunks.reduce((n, c) => n + c[0].length, 0) / this.ctx.sampleRate;
  }

  private async initRecorder(): Promise<(on: boolean) => void> {
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    sink.connect(this.ctx.destination);

    // AudioWorklet only exists in secure contexts (https or localhost). Over plain http, e.g.
    // a Tailscale IP, fall back to the deprecated but still supported ScriptProcessorNode.
    if (!this.ctx.audioWorklet) {
      let on = false;
      const node = this.ctx.createScriptProcessor(4096, 2, 2);
      node.onaudioprocess = (e) => {
        if (!on) return;
        const b = e.inputBuffer;
        this.recChunks.push(Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).slice()));
      };
      this.inputTrim.connect(node);
      node.connect(sink);
      return (v) => (on = v);
    }

    const url = URL.createObjectURL(new Blob([RECORDER_WORKLET], { type: 'text/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(this.ctx, 'su-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit',
    });
    node.port.onmessage = (e: MessageEvent<Float32Array[]>) => this.recChunks.push(e.data);
    this.inputTrim.connect(node);
    node.connect(sink);
    return (v) => node.port.postMessage(v);
  }
}
