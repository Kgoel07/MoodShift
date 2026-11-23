import { customBandLimit, defaultBands, type EqSettings } from './shared/equalizer';
import { effectiveFrequency, equalizerResponse } from './shared/eq-response';

/** One optional peaking-filter cascade. Flat or disabled EQ uses only the dry route. */
export class EqualizerStage {
  private readonly dry = this.context.createGain();
  private readonly wet = this.context.createGain();
  private readonly trim = this.context.createGain();
  private filters: BiquadFilterNode[] = [];
  private connected = false;
  private enabled = false;
  private detachTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly context: AudioContext, private readonly input: AudioNode, private readonly output: AudioNode) {
    this.wet.gain.value = 0;
    this.input.connect(this.dry).connect(this.output);
  }

  update(eq: EqSettings): void {
    const active = eq.enabled && eq.bands.some(band => band.gain !== 0);
    if (!active && !this.enabled) return;
    clearTimeout(this.detachTimer);
    const now = this.context.currentTime;
    const ramp = (param: AudioParam, value: number) => {
      param.cancelAndHoldAtTime(now);
      param.setTargetAtTime(value, now, 0.01);
    };
    if (active) {
      if (!this.filters.length) {
        this.filters = Array.from({ length: defaultBands.length + customBandLimit }, () => {
          const filter = this.context.createBiquadFilter();
          filter.type = 'peaking';
          return filter;
        });
      }
      const { trimDb } = equalizerResponse(eq, this.context.sampleRate);
      const attenuation = 10 ** (trimDb / 20);
      this.trim.gain.cancelAndHoldAtTime(now);
      if (!this.connected) this.trim.gain.setValueAtTime(attenuation, now);
      else {
        // Apply attenuation quickly before boosts arrive, then restore gain after cuts settle.
        this.trim.gain.setTargetAtTime(attenuation, now, attenuation < this.trim.gain.value ? 0.003 : 0.022);
      }
      this.filters.forEach((filter, index) => {
        const band = eq.bands[index];
        if (band) {
          const frequency = effectiveFrequency(band.frequency, this.context.sampleRate);
          ramp(filter.frequency, frequency);
          ramp(filter.Q, band.q);
        }
        ramp(filter.gain, band?.gain ?? 0);
      });
      if (!this.connected) this.attach();
    }
    if (active !== this.enabled) {
      ramp(this.dry.gain, +!active);
      ramp(this.wet.gain, +active);
    }
    this.enabled = active;
    if (!active) this.detachTimer = setTimeout(() => this.detach(), 75);
  }

  private attach(): void {
    let tail: AudioNode = this.input.connect(this.trim);
    for (const filter of this.filters) tail = tail.connect(filter);
    tail.connect(this.wet).connect(this.output);
    this.connected = true;
  }

  private detach(): void {
    if (!this.connected) return;
    this.input.disconnect(this.trim);
    this.trim.disconnect();
    for (const node of this.filters) node.disconnect();
    this.wet.disconnect(this.output);
    this.connected = false;
  }

  close(): void {
    clearTimeout(this.detachTimer);
    this.detach();
    this.input.disconnect(this.dry);
    this.dry.disconnect(this.output);
  }
}
