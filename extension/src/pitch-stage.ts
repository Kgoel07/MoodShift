import type { PitchPlayback, PitchSettings } from './shared/pitch';

interface StretchNode extends AudioWorkletNode {
  configure(config: { blockMs: number; intervalMs: number; splitComputation: boolean }): Promise<void>;
  latency(): Promise<number>;
  schedule(config: { active: boolean; semitones?: number; formantCompensation?: boolean }): Promise<unknown>;
}
interface StretchFactory {
  (context: BaseAudioContext, options: AudioWorkletNodeOptions): Promise<StretchNode>;
  moduleUrl: string;
}

function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Pitch processor did not respond.')), 3000);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export async function loadStretch(context: BaseAudioContext, url: string): Promise<{ node: StretchNode; latency: number }> {
  const { default: factory } = await import(url) as { default: StretchFactory };
  // The shipped module also registers the worklet. Use a packaged URL so MV3 needs no blob scripts.
  factory.moduleUrl = url;
  const pending = factory(context, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  let node: StretchNode;
  try {
    node = await withDeadline(pending);
  } catch (error) {
    void pending.then(late => late.port.close(), () => undefined);
    throw error;
  }
  try {
    await withDeadline(node.configure({ blockMs: 80, intervalMs: 20, splitComputation: true }));
    const latency = await withDeadline(node.latency());
    if (!Number.isFinite(latency) || latency <= 0 || latency > 0.25) throw new Error('Invalid pitch latency.');
    return { node, latency };
  } catch (error) {
    node.port.close();
    throw error;
  }
}

const fadeTimeConstant = 0.007; // The gain settles within 1% in about 35 ms.

/** Owns one optional worklet in the capture's existing audio context. */
export class PitchStage {
  private readonly dry = this.context.createGain();
  private readonly wet = this.context.createGain();
  private processor?: StretchNode;
  private delay = 0;
  private warmUntil = 0;
  private target = 0;
  private applied = 0;
  private attached = false;
  private working = false;
  private disposed = false;
  private detachTimer?: ReturnType<typeof setTimeout>;
  private warmTimer?: ReturnType<typeof setTimeout>;
  private resumeWarm?: () => void;
  private state: PitchPlayback = { phase: 'bypass', latencySeconds: 0 };

  constructor(private readonly context: AudioContext, private readonly input: AudioNode, private readonly output: AudioNode,
    private readonly moduleUrl: string, private readonly onChange: () => void) {
    this.wet.gain.value = 0;
    input.connect(this.dry).connect(output);
  }

  get status(): PitchPlayback { return this.state; }

  update(settings: PitchSettings): void {
    const target = settings.enabled ? settings.semitones : 0;
    if (target === this.target && this.state.phase !== 'unavailable') return;
    this.target = target;
    if (target === 0) {
      this.finishWarmup();
      this.bypass();
      return;
    }
    clearTimeout(this.detachTimer);
    if (this.state.phase !== 'active') this.changeState('starting');
    if (!this.working) void this.applyLatest();
  }

  private changeState(phase: PitchPlayback['phase']): void {
    if (phase === this.state.phase) return;
    this.state = { phase, latencySeconds: phase === 'active' ? this.delay : 0 };
    this.onChange();
  }

  private async applyLatest(): Promise<void> {
    this.working = true;
    try {
      if (!this.processor) {
        const { node, latency } = await loadStretch(this.context, this.moduleUrl);
        if (this.disposed) { node.port.close(); return; }
        this.processor = node;
        this.delay = latency;
        node.onprocessorerror = () => {
          if (this.processor === node && !this.disposed) this.fail(new Error('Pitch audio worklet stopped.'));
        };
      }
      const node = this.processor;
      while (!this.disposed && this.processor === node && this.target !== 0) {
        if (!this.attached) {
          this.input.connect(node).connect(this.wet).connect(this.output);
          this.attached = true;
          this.warmUntil = 0;
        }
        const target = this.target;
        if (target !== this.applied || this.warmUntil === 0) {
          await withDeadline(node.schedule({ active: true, semitones: target, formantCompensation: true }));
          this.applied = target;
          if (this.warmUntil === 0) this.warmUntil = this.context.currentTime + this.delay + 0.02;
        }
        await this.warmup();
        if (!this.target || this.disposed || this.processor !== node) break;
        if (this.target !== target || !this.attached) continue;
        this.fade(true);
        this.changeState('active');
        break;
      }
    } catch (error) {
      if (!this.disposed) this.fail(error);
    } finally {
      this.working = false;
    }
  }

  private async warmup(): Promise<void> {
    // Use audio time so a suspended context cannot make an unprimed processor audible.
    while (this.target && this.attached && this.context.currentTime < this.warmUntil) {
      await new Promise<void>(resolve => {
        this.resumeWarm = resolve;
        this.warmTimer = setTimeout(() => this.finishWarmup(), Math.max(16, (this.warmUntil - this.context.currentTime) * 1000));
      });
    }
  }

  private finishWarmup(): void {
    clearTimeout(this.warmTimer);
    this.resumeWarm?.();
    this.resumeWarm = undefined;
  }

  private fade(active: boolean): void {
    const now = this.context.currentTime;
    for (const [param, target] of [[this.dry.gain, +!active], [this.wet.gain, +active]] as const) {
      param.cancelAndHoldAtTime(now);
      param.setTargetAtTime(target, now, fadeTimeConstant);
    }
  }

  private bypass(): void {
    this.fade(false);
    this.changeState('bypass');
    clearTimeout(this.detachTimer);
    this.detachTimer = setTimeout(() => this.detach(), 60);
  }

  private detach(): void {
    if (!this.attached || !this.processor) return;
    void this.processor.schedule({ active: false }).catch(() => undefined);
    this.input.disconnect(this.processor);
    this.processor.disconnect(this.wet);
    this.wet.disconnect(this.output);
    this.attached = false;
    this.applied = 0;
    this.warmUntil = 0;
  }

  private fail(error: unknown): void {
    console.warn('MoodShift pitch processor failed', error);
    this.finishWarmup();
    clearTimeout(this.detachTimer);
    this.fade(false);
    this.detach();
    this.processor?.port.close();
    this.processor = undefined;
    this.changeState(this.target ? 'unavailable' : 'bypass');
  }

  close(): void {
    this.disposed = true;
    this.finishWarmup();
    clearTimeout(this.detachTimer);
    this.detach();
    this.processor?.port.close();
    this.input.disconnect(this.dry);
    this.dry.disconnect(this.output);
  }
}
