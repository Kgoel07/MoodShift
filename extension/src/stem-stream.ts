import type { AudioEngine } from './audio-engine';
import type { StemWorkerStart } from './shared/stem-pcm';
import type { StemMode } from './shared/types';
import { deployment, usesCloudStems } from './shared/deployment';
import type { StemCodeReply, StemCodeRequest } from './shared/messages';

type Stem = Exclude<StemMode, 'full'>;
type WorkerEvent = { type: 'buffering' } | { type: 'active'; queuedFrames: number } | { type: 'error'; message: string };

const loaded = new WeakMap<AudioContext, Promise<void>>();

export class StemStream {
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private node?: AudioWorkletNode;
  private worker?: Worker;
  private splitter?: ChannelSplitterNode;
  private playback?: GainNode;
  private vocals?: GainNode;
  private instrumental?: GainNode;
  private connected = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout>;
  private queuedFrames?: number;

  get playoutDelay(): number {
    return this.queuedFrames === undefined ? deployment.stemDelaySeconds : this.queuedFrames / this.context.sampleRate;
  }

  constructor(
    private readonly context: AudioContext,
    private readonly engine: AudioEngine,
    buffering: () => void,
    private readonly unavailable: (message: string) => void,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.timer = setTimeout(() => this.fail('The stem helper did not start in time.'), (deployment.stemDelaySeconds + 2.7) * 1000);
    void this.start(buffering).catch(() => this.fail('Could not initialize stem playback.'));
  }

  private async start(buffering: () => void): Promise<void> {
    let demoCode: string | undefined;
    if (usesCloudStems()) {
      try {
        const reply: StemCodeReply = await chrome.runtime.sendMessage({
          target: 'worker', type: 'GET_STEM_CODE',
        } satisfies StemCodeRequest);
        if (!reply.ok) throw new Error(reply.message);
        demoCode = reply.code;
      } catch (error) {
        this.fail(error instanceof Error ? error.message : 'Could not read the private demo code.');
        return;
      }
    }
    if (this.closed) return;
    let module = loaded.get(this.context);
    if (!module) {
      module = this.context.audioWorklet.addModule(chrome.runtime.getURL('stem-worklet.js'));
      loaded.set(this.context, module);
      void module.catch(() => loaded.delete(this.context));
    }
    await module;
    if (this.closed) return;
    const gain = () => {
      const node = this.context.createGain();
      node.gain.value = 0;
      return node;
    };
    const node = new AudioWorkletNode(this.context, 'stem-audio', {
      outputChannelCount: [4], channelCount: 2, channelCountMode: 'explicit',
    });
    this.node = node;
    const splitter = this.context.createChannelSplitter(4);
    this.splitter = splitter;
    node.connect(splitter);
    this.playback = this.context.createGain();
    this.vocals = gain();
    this.instrumental = gain();
    for (const [offset, branch] of [[0, this.vocals], [2, this.instrumental]] as const) {
      // Treat the two decoded channels as a stereo pair all the way to the DSP input.
      const stereo = this.context.createChannelMerger(2);
      splitter.connect(stereo, offset, 0);
      splitter.connect(stereo, offset + 1, 1);
      stereo.connect(branch).connect(this.playback);
    }
    this.engine.connectStem(node, this.playback);
    this.connected = true;
    const channel = new MessageChannel();
    const worker = new Worker(chrome.runtime.getURL('stem-worker.js'));
    this.worker = worker;
    worker.onmessage = ({ data }: MessageEvent<WorkerEvent>) => {
      if (this.closed) return;
      if (data.type === 'buffering') buffering();
      if (data.type === 'active') {
        this.queuedFrames = data.queuedFrames;
        clearTimeout(this.timer);
        this.resolveReady();
      }
      if (data.type === 'error') this.fail(data.message);
    };
    worker.onerror = () => this.fail('Stem communication failed.');
    node.onprocessorerror = () => this.fail('Chrome stopped the stem audio processor.');
    node.port.onmessage = ({ data }: MessageEvent<{ queuedFrames: number }>) => {
      if (!this.closed) this.queuedFrames = data.queuedFrames;
    };
    node.port.postMessage(channel.port1, [channel.port1]);
    worker.postMessage({
      port: channel.port2, sampleRate: this.context.sampleRate, sessionId: crypto.randomUUID().replaceAll('-', ''),
      demoCode,
    } satisfies StemWorkerStart, [channel.port2]);
  }

  select(mode: Stem): void {
    if (!this.vocals || !this.instrumental) return;
    const now = this.context.currentTime;
    for (const [branch, name] of [[this.vocals, 'vocals'], [this.instrumental, 'instrumental']] as const) {
      branch.gain.cancelAndHoldAtTime(now);
      branch.gain.linearRampToValueAtTime(Number(mode === name), now + 0.05);
    }
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.unavailable(message);
    this.close(message);
  }

  close(message = 'Stem selection was replaced or stopped.'): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.rejectReady(new Error(message));
    this.worker?.terminate();
    if (this.node) {
      if (this.connected) this.engine.disconnectStem(this.node);
      this.node.port.close();
    }
    // Give the engine's resync ramp time to fade the last playable frames.
    setTimeout(() => {
      this.node?.disconnect();
      this.splitter?.disconnect();
      this.vocals?.disconnect();
      this.instrumental?.disconnect();
      this.playback?.disconnect();
    }, 55);
  }
}
