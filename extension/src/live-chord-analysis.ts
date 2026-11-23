const pitchNames = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// Each FFT peak votes for its nearest pitch class. The octave-independent profile
// is compared with the 12 major and 12 minor triads.
export function estimateChord(spectrum: Float32Array, sampleRate: number): string | null {
  const hzPerBin = sampleRate / (2 * spectrum.length);
  const start = Math.ceil(65 / hzPerBin);
  const end = Math.min(Math.floor(1600 / hzPerBin), spectrum.length - 2);
  let loudest = -Infinity;
  for (let bin = start; bin <= end; bin++) loudest = Math.max(loudest, spectrum[bin]);
  if (loudest < -72) return null;

  const chroma = new Float32Array(12);
  let total = 0;
  for (let bin = start; bin <= end; bin++) {
    const left = spectrum[bin - 1];
    const peak = spectrum[bin];
    const right = spectrum[bin + 1];
    if (peak < loudest - 26 || peak <= left || peak < right) continue;
    const curvature = left - 2 * peak + right;
    const correction = Number.isFinite(curvature) && curvature ? 0.5 * (left - right) / curvature : 0;
    const frequency = (bin + correction) * hzPerBin;
    const midi = 69 + 12 * Math.log2(frequency / 440);
    const closest = Math.round(midi);
    const pitch = ((closest % 12) + 12) % 12;
    // Downweight upper harmonics that coincide with a strong lower peak.
    let weight = 10 ** ((peak - loudest) / 25) * (1 - Math.abs(midi - closest));
    for (const harmonic of [2, 3, 4, 5]) {
      const fundamental = Math.round(frequency / (hzPerBin * harmonic));
      if (fundamental >= start && Math.max(spectrum[fundamental - 1], spectrum[fundamental], spectrum[fundamental + 1]) > peak - 3) {
        weight *= 0.4;
        break;
      }
    }
    chroma[pitch] += weight;
    total += weight;
  }
  if (!total) return null;

  let chord: string | null = null;
  let best = 0;
  let runnerUp = 0;
  for (let root = 0; root < 12; root++) {
    for (const third of [3, 4]) {
      const rootEnergy = chroma[root];
      const thirdEnergy = chroma[(root + third) % 12];
      const fifthEnergy = chroma[(root + 7) % 12];
      const balance = Math.min(rootEnergy, thirdEnergy, fifthEnergy) / total;
      const coverage = (rootEnergy + thirdEnergy + fifthEnergy) / total;
      if (balance < 0.075 || coverage < 0.61) continue;
      const score = coverage + balance * 0.65;
      if (score > best) {
        runnerUp = best;
        best = score;
        chord = pitchNames[root] + (third === 3 ? 'm' : '');
      } else runnerUp = Math.max(runnerUp, score);
    }
  }
  return best - runnerUp >= 0.075 ? chord : null;
}

export class LiveChordAnalyzer {
  readonly node: AnalyserNode;
  private readonly spectrum: Float32Array<ArrayBuffer>;
  private previous?: string | null;
  private stable: string | null = null;

  constructor(private readonly context: AudioContext) {
    this.node = context.createAnalyser();
    this.node.fftSize = 16_384;
    this.node.smoothingTimeConstant = 0.2;
    this.spectrum = new Float32Array(this.node.frequencyBinCount);
  }

  get windowCenter(): number {
    return this.node.fftSize / (2 * this.context.sampleRate);
  }

  sample(audible: boolean): string | null {
    if (!audible) {
      this.previous = this.stable = null;
      return null;
    }
    this.node.getFloatFrequencyData(this.spectrum);
    const candidate = estimateChord(this.spectrum, this.context.sampleRate);
    if (candidate === this.previous) this.stable = candidate;
    this.previous = candidate;
    return this.stable;
  }
}
