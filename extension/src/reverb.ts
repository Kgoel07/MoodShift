import { reverbPresets, validateReverb, type ReverbSettings } from './shared/reverb';
import { effectSpecs } from './shared/effects';

export function impulseSamples(rate: number, settings: ReverbSettings): Float32Array[] {
  const config = validateReverb(settings), preset = reverbPresets[config.preset];
  const length = Math.ceil(rate * config.duration), start = Math.round(rate * preset.preDelay);
  const response = [new Float32Array(length), new Float32Array(length)];
  const coefficient = 1 - Math.exp(-2 * Math.PI * preset.toneHz / rate);
  for (let channel = 0; channel < 2; channel++) {
    let seed = 12345 + channel * 9817, filtered = 0, energy = 0;
    const samples = response[channel];
    for (let i = start; i < length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      filtered += coefficient * (seed / 2147483648 - 1 - filtered);
      const time = (i - start) / rate;
      samples[i] = filtered * Math.exp(-6.91 * time / (config.duration - preset.preDelay)) * Math.min(1, time / 0.01);
      energy += samples[i] ** 2;
    }
    const gain = 1 / Math.sqrt(Math.max(1e-8, energy));
    for (let i = start; i < length; i++) samples[i] *= gain;
  }
  return response;
}

interface Return { convolver: ConvolverNode; gain: GainNode; timer?: ReturnType<typeof setTimeout>; }
/** One dry route and smoothly exchanged convolution returns after the monitor mix. */
export class LocalReverb {
  private readonly dry = this.context.createGain();
  private readonly cache = new Map<string, AudioBuffer>();
  private readonly returns = new Set<Return>();
  private active?: Return;
  private key = '';
  private pending?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private readonly context: AudioContext, private readonly input: AudioNode, private readonly output: AudioNode) {
    input.connect(this.dry).connect(output);
  }
  private ramp(param: AudioParam, value: number): void {
    param.cancelAndHoldAtTime(this.context.currentTime);
    param.linearRampToValueAtTime(value, this.context.currentTime + 0.3);
  }
  private retire(branch: Return): void {
    this.ramp(branch.gain.gain, 0);
    clearTimeout(branch.timer);
    branch.timer = setTimeout(() => {
      this.input.disconnect(branch.convolver);
      branch.convolver.disconnect(); branch.gain.disconnect();
      this.returns.delete(branch);
    }, 350);
  }
  update(settings: ReverbSettings, amount: number): void {
    if (this.closed) return;
    const config = validateReverb(settings);
    if (!Number.isFinite(amount) || amount < 0 || amount > effectSpecs.reverbMix.max) throw new Error('Invalid reverb amount.');
    clearTimeout(this.pending);
    this.ramp(this.dry.gain, Math.sqrt(1 - amount));
    if (!amount) {
      if (this.active) this.retire(this.active);
      this.active = undefined; this.key = '';
      return;
    }
    const key = `${config.preset}:${config.duration}`;
    if (key === this.key && this.active) { this.ramp(this.active.gain.gain, Math.sqrt(amount) * 0.8); return; }
    // Coalesce duration scrubbing. The existing return keeps playing during generation.
    this.pending = setTimeout(() => {
      if (this.closed) return;
      let buffer = this.cache.get(key);
      if (!buffer) {
        const channels = impulseSamples(this.context.sampleRate, config);
        buffer = this.context.createBuffer(2, channels[0].length, this.context.sampleRate);
        channels.forEach((samples, channel) => buffer!.getChannelData(channel).set(samples));
      }
      this.cache.delete(key); this.cache.set(key, buffer);
      if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
      const convolver = this.context.createConvolver(), gain = this.context.createGain();
      convolver.normalize = false; convolver.buffer = buffer; gain.gain.value = 0;
      this.input.connect(convolver).connect(gain).connect(this.output);
      if (this.active) this.retire(this.active);
      this.active = { convolver, gain }; this.returns.add(this.active); this.key = key;
      this.ramp(gain.gain, Math.sqrt(amount) * 0.8);
    }, 80);
  }
  disconnect(): void {
    this.closed = true; clearTimeout(this.pending);
    this.input.disconnect(this.dry); this.dry.disconnect();
    for (const branch of this.returns) {
      clearTimeout(branch.timer); this.input.disconnect(branch.convolver);
      branch.convolver.disconnect(); branch.gain.disconnect();
    }
    this.returns.clear(); this.cache.clear();
  }
}
