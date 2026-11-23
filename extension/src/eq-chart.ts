import { effectiveFrequency, equalizerResponse, frequencyAt, frequencyPosition } from './shared/eq-response';
import { eqRange, type EqBand, type EqSettings } from './shared/equalizer';

export function frequencyLabel(hz: number): string {
  return hz >= 1000 ? `${Number((hz / 1000).toFixed(1))}k` : String(Math.round(hz));
}

export const gainLabel = (gain: number) => `${gain > 0 ? '+' : ''}${gain.toFixed(1)}`;
const gainSpan = eqRange.maxGain - eqRange.minGain;
const clampUnit = (n: number) => Math.max(0, Math.min(1, n));
const points = 256;

/** Draws the target response of the actual cascade, plus optional live log-bin spectrum data. */
export class EqChart {
  private readonly context = this.canvas.getContext('2d')!;
  private readonly colors = getComputedStyle(this.canvas);
  private readonly accent = this.colors.getPropertyValue('--accent').trim();
  private readonly muted = this.colors.getPropertyValue('--muted').trim();
  private readonly line = this.colors.getPropertyValue('--line').trim();
  private readonly curve = new Float32Array(points + 1);
  private width = 0;
  private height = 0;
  private ratio = 1;
  private rate = 48000;
  private spectrum?: number[];
  private eq?: EqSettings;
  trimDb = 0;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly compact: boolean, onResize?: () => void) {
    new ResizeObserver(([{ contentRect }]) => {
      this.width = contentRect.width;
      this.height = contentRect.height;
      this.ratio = Math.min(devicePixelRatio, 2);
      canvas.width = Math.round(this.width * this.ratio);
      canvas.height = Math.round(this.height * this.ratio);
      this.draw();
      onResize?.();
    }).observe(canvas);
  }

  private get left() { return this.compact ? 26 : 48; }
  private get top() { return this.compact ? 8 : 18; }
  private get graphWidth() { return Math.max(1, this.width - this.left - (this.compact ? 9 : 22)); }
  private get graphHeight() { return Math.max(1, this.height - this.top - (this.compact ? 18 : 30)); }
  private y(gain: number) { return this.top + (eqRange.maxGain - gain) / gainSpan * this.graphHeight; }

  position(band: EqBand) {
    return { x: this.left + frequencyPosition(band.frequency) * this.graphWidth, y: this.y(band.gain) };
  }

  editAt(clientX: number, clientY: number, clamp = true): Pick<EqBand, 'frequency' | 'gain'> | undefined {
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.x - this.left) / this.graphWidth;
    const y = (clientY - rect.y - this.top) / this.graphHeight;
    if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return;
    return { frequency: Math.round(frequencyAt(clampUnit(x))), gain: Number((eqRange.maxGain - gainSpan * clampUnit(y)).toFixed(1)) };
  }

  setEq(eq: EqSettings, rate = 48000): void {
    if (this.eq === eq && this.rate === rate) return;
    this.eq = eq;
    this.rate = rate;
    const { gainDb, trimDb } = equalizerResponse(eq, rate);
    this.trimDb = trimDb;
    for (let i = 0; i <= points; i++) this.curve[i] = gainDb(frequencyAt(i / points));
    this.draw();
  }

  setSpectrum(data?: number[]): void {
    this.spectrum = data;
    this.draw();
  }

  private draw(): void {
    const { context: ctx, left, top, graphHeight: height, graphWidth: width } = this;
    if (!this.width || !this.height) return;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.font = `${this.compact ? 9 : 11}px system-ui, sans-serif`;
    ctx.strokeStyle = this.line;
    ctx.fillStyle = this.muted;
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (const db of this.compact ? [-12, 0, 12] : [-12, -6, 0, 6, 12]) {
      const y = this.y(db);
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke();
      ctx.fillText(`${db > 0 ? '+' : ''}${db}${this.compact ? '' : ' dB'}`, left - 5, y);
    }
    ctx.textAlign = 'center';
    const ticks = this.compact ? [60, 400, 3000, 10_000] : [20, 60, 200, 600, 2000, 6000, 20_000];
    for (const hz of ticks) {
      const x = left + frequencyPosition(hz) * width;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
      ctx.fillText(frequencyLabel(hz), x, top + height + (this.compact ? 9 : 15));
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    if (this.spectrum?.length) {
      ctx.beginPath();
      ctx.moveTo(left, top + height);
      this.spectrum.forEach((level, i, values) => {
        const x = left + i / (values.length - 1) * width;
        const y = top + height * (1 - level / 255 * 0.86);
        ctx.lineTo(x, y);
      });
      ctx.lineTo(left + width, top + height);
      ctx.closePath();
      ctx.fillStyle = this.accent;
      ctx.globalAlpha = 0.17;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    for (let i = 0; i <= points; i++) {
      const frequency = frequencyAt(i / points);
      if (frequency > effectiveFrequency(frequency, this.rate)) break;
      const x = left + i / points * width, y = this.y(this.curve[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = this.compact ? 1.6 : 2;
    ctx.stroke();
    ctx.restore();
  }
}
