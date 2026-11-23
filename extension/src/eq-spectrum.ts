import { frequencyAt, spectrumSize } from './shared/eq-response';
import { eqSpectrumPort } from './shared/tuning';

/** Only pulls spectrum samples while at least one Domain Expansion page is visible. */
export class EqSpectrum {
  private readonly subscribers = new Set<chrome.runtime.Port>();
  private source?: AudioNode;
  private analyser?: AnalyserNode;
  private listening = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly bins = new Uint8Array(2048);
  private readonly levels = Array<number>(spectrumSize).fill(0);
  private readonly bandEnds = Array<number>(spectrumSize + 1).fill(0);

  constructor(private readonly audible: () => boolean) {
    chrome.runtime.onConnect.addListener(port => {
      if (port.name !== eqSpectrumPort || port.sender?.url !== chrome.runtime.getURL('domain.html')) return;
      this.subscribers.add(port);
      port.onDisconnect.addListener(() => {
        this.subscribers.delete(port);
        this.update();
      });
      this.update();
    });
  }

  setSource(source?: AudioNode): void {
    this.pause();
    this.source = source;
    this.analyser = undefined;
    this.update();
  }

  private update(): void {
    if (!this.source || !this.subscribers.size) { this.pause(); return; }
    if (this.listening) return;
    if (!this.analyser) {
      this.analyser = this.source.context.createAnalyser();
      this.analyser.fftSize = this.bins.length * 2;
      this.analyser.smoothingTimeConstant = 0.72;
      this.analyser.minDecibels = -90;
      this.analyser.maxDecibels = -22;
      const hzPerBin = this.source.context.sampleRate / this.analyser.fftSize;
      for (let i = 0; i <= spectrumSize; i++) this.bandEnds[i] = Math.floor(frequencyAt(i / spectrumSize) / hzPerBin);
    }
    this.source.connect(this.analyser);
    this.listening = true;
    this.timer = setInterval(() => this.publish(), 50);
  }

  private pause(): void {
    clearInterval(this.timer);
    if (this.listening) this.source!.disconnect(this.analyser!);
    this.listening = false;
  }

  private publish(): void {
    if (!this.audible()) this.levels.fill(0);
    else {
      this.analyser!.getByteFrequencyData(this.bins);
      for (let i = 0; i < spectrumSize; i++) {
        let level = 0;
        for (let bin = this.bandEnds[i]; bin <= this.bandEnds[i + 1] && bin < this.bins.length; bin++) {
          level = Math.max(level, this.bins[bin]);
        }
        this.levels[i] = level;
      }
    }
    for (const port of this.subscribers) {
      try { port.postMessage(this.levels); } catch { this.subscribers.delete(port); }
    }
    if (!this.subscribers.size) this.pause();
  }
}
