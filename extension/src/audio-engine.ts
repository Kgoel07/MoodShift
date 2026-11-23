import { effectSpecs, neutralEffects, type AudioEffectState } from './shared/effects';
import type { MonitorMode } from './shared/types';
import { LocalReverb } from './reverb';
import { defaultReverb, type ReverbSettings } from './shared/reverb';

const timeConstant = 0.075; // About 98% of the transition in 300 ms.
const dbToGain = (db: number) => 10 ** (db / 20);

export class AudioEngine {
  private readonly nodes: AudioNode[] = [];
  private readonly source = this.track(this.context.createMediaStreamSource(this.stream));
  readonly analyser = this.track(this.context.createAnalyser());
  private readonly original = this.gain(0);
  private readonly modified = this.gain(1);
  private readonly master = this.gain(1);
  private readonly monitorOut = this.gain(1);
  private readonly reverb = new LocalReverb(this.context, this.monitorOut, this.master);
  private reverbSettings: ReverbSettings = { ...defaultReverb };
  private readonly fullInput = this.gain(1);
  private readonly stemInput = this.gain(0);
  private activeStem = false;
  private monitor: MonitorMode = 'modified';
  private resyncUntil = 0;
  private readonly outputGain = this.gain(1);
  private readonly bass = this.filter('lowshelf', 150);
  private readonly treble = this.filter('highshelf', 4000);
  private readonly highpass = this.filter('highpass', effectSpecs.highpassHz.neutral);
  private readonly lowpass = this.filter('lowpass', effectSpecs.lowpassHz.neutral);
  private readonly highpassDry = this.gain(1);
  private readonly highpassWet = this.gain(0);
  private readonly highpassOut = this.gain(1);
  private readonly lowpassDry = this.gain(1);
  private readonly lowpassWet = this.gain(0);
  private readonly lowpassOut = this.gain(1);
  private readonly distortionDry = this.gain(1);
  private readonly distortionWet = this.gain(0);
  private readonly effectsInput = this.gain(1);
  private readonly spaceDry = this.gain(1);
  private readonly delaySend = this.gain(0);
  private readonly delayReturn = this.gain(0);
  private readonly delay = this.track(this.context.createDelay(0.5));
  private readonly feedback = this.gain(0);
  private effects: Readonly<AudioEffectState> = neutralEffects;

  constructor(private readonly context: AudioContext, private readonly stream: MediaStream) {
    this.source.connect(this.analyser);
    this.source.connect(this.original).connect(this.monitorOut);
    const limiter = this.track(context.createDynamicsCompressor());
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 16;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    this.master.connect(limiter).connect(context.destination);

    this.source.connect(this.fullInput).connect(this.bass).connect(this.treble);
    this.stemInput.connect(this.bass);
    this.treble.connect(this.highpassDry).connect(this.highpassOut);
    this.treble.connect(this.highpass).connect(this.highpassWet).connect(this.highpassOut);
    this.highpassOut.connect(this.lowpassDry).connect(this.lowpassOut);
    this.highpassOut.connect(this.lowpass).connect(this.lowpassWet).connect(this.lowpassOut);

    const shaper = this.track(context.createWaveShaper());
    const curve = new Float32Array(2049);
    for (let index = 0; index < curve.length; index++) {
      const x = 2 * index / (curve.length - 1) - 1;
      curve[index] = Math.tanh(2.5 * x) / 2.5;
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    this.lowpassOut.connect(this.distortionDry).connect(this.effectsInput);
    this.lowpassOut.connect(shaper).connect(this.distortionWet).connect(this.effectsInput);

    this.effectsInput.connect(this.spaceDry).connect(this.outputGain);
    this.delay.delayTime.value = 0.01;
    this.effectsInput.connect(this.delaySend).connect(this.delay).connect(this.delayReturn).connect(this.outputGain);
    this.delay.connect(this.feedback).connect(this.delay);
    this.outputGain.connect(this.modified).connect(this.monitorOut);
  }

  private track<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  private gain(value: number): GainNode {
    const node = this.track(this.context.createGain());
    node.gain.value = value;
    return node;
  }

  private filter(type: BiquadFilterType, hz: number): BiquadFilterNode {
    const node = this.track(this.context.createBiquadFilter());
    node.type = type;
    node.frequency.value = Math.min(hz, this.context.sampleRate / 2);
    node.Q.value = -3;
    return node;
  }

  setReverb(settings: ReverbSettings): void {
    this.reverbSettings = settings;
    this.reverb.update(settings, this.effects.reverbMix);
  }

  private ramp(param: AudioParam, value: number): void {
    const now = this.context.currentTime;
    param.cancelAndHoldAtTime(now);
    param.setTargetAtTime(value, now, timeConstant);
  }

  setMonitor(mode: MonitorMode): void {
    this.monitor = mode;
    if (this.activeStem || this.context.currentTime < this.resyncUntil) {
      this.resync(this.original.gain, this.modified.gain, mode === 'original');
      return;
    }
    this.ramp(this.original.gain, mode === 'original' ? 1 : 0);
    this.ramp(this.modified.gain, mode === 'modified' ? 1 : 0);
  }

  connectStem(capture: AudioNode, playback: AudioNode): void {
    this.source.connect(capture);
    playback.connect(this.stemInput);
  }

  disconnectStem(capture: AudioNode): void {
    this.source.disconnect(capture);
  }

  setStemActive(active: boolean): void {
    if (active === this.activeStem) return;
    this.activeStem = active;
    this.resync(this.fullInput.gain, this.stemInput.gain, !active);
    this.resyncUntil = this.context.currentTime + 0.05;
    this.resync(this.original.gain, this.modified.gain, this.monitor === 'original');
  }

  private resync(first: AudioParam, second: AudioParam, useFirst: boolean): void {
    const now = this.context.currentTime;
    const dip = now + 0.025;
    const selected = useFirst ? first : second;
    for (const param of [first, second]) {
      param.cancelAndHoldAtTime(now);
      param.linearRampToValueAtTime(0, dip);
    }
    selected.linearRampToValueAtTime(1, dip + 0.025);
  }

  setMuted(muted: boolean): void {
    this.ramp(this.master.gain, muted ? 0 : 1);
  }

  setEffects(next: AudioEffectState): void {
    const previous = this.effects;
    if (previous.bassDb !== next.bassDb) this.ramp(this.bass.gain, next.bassDb);
    if (previous.trebleDb !== next.trebleDb) this.ramp(this.treble.gain, next.trebleDb);
    if (previous.highpassHz !== next.highpassHz) {
      this.setCut(this.highpass, this.highpassDry, this.highpassWet, next.highpassHz, neutralEffects.highpassHz);
    }
    if (previous.lowpassHz !== next.lowpassHz) {
      this.setCut(this.lowpass, this.lowpassDry, this.lowpassWet, next.lowpassHz, neutralEffects.lowpassHz);
    }
    if (previous.distortion !== next.distortion) {
      this.ramp(this.distortionDry.gain, 1 - next.distortion);
      this.ramp(this.distortionWet.gain, next.distortion);
    }

    const echo = next.delayMs > 0 ? next.delayMix : 0;
    const oldEcho = previous.delayMs > 0 ? previous.delayMix : 0;
    if (next.delayMs !== previous.delayMs && next.delayMs > 0) {
      this.ramp(this.delay.delayTime, next.delayMs / 1000);
    }
    if (oldEcho !== echo || next.delayFeedback !== previous.delayFeedback) {
      this.ramp(this.feedback.gain, echo > 0 ? next.delayFeedback : 0);
    }
    if (previous.reverbMix !== next.reverbMix) this.reverb.update(this.reverbSettings, next.reverbMix);
    if (oldEcho !== echo) {
      this.ramp(this.spaceDry.gain, 1 - echo);
      this.ramp(this.delayReturn.gain, echo * (1 - next.delayFeedback));
      this.ramp(this.delaySend.gain, echo > 0 ? 1 : 0);
    } else if (next.delayFeedback !== previous.delayFeedback && echo > 0) {
      this.ramp(this.delayReturn.gain, echo * (1 - next.delayFeedback));
    }
    if (previous.outputGainDb !== next.outputGainDb) this.ramp(this.outputGain.gain, dbToGain(next.outputGainDb));
    this.effects = next;
  }

  private setCut(filter: BiquadFilterNode, dry: GainNode, wet: GainNode, hz: number, neutral: number): void {
    const active = hz !== neutral;
    this.ramp(filter.frequency, Math.min(hz, this.context.sampleRate / 2));
    this.ramp(dry.gain, active ? 0 : 1);
    this.ramp(wet.gain, active ? 1 : 0);
  }

  disconnect(): void {
    this.reverb.disconnect();
    this.nodes.forEach(node => node.disconnect());
  }
}
