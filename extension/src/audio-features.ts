import { silentFeatures, type AudioFeatures } from './shared/types';

export class AudioFeaturesMeter {
  private readonly timeDomain: Float32Array<ArrayBuffer>;
  private readonly spectrum: Float32Array<ArrayBuffer>;
  private readonly history: { at: number; values: Omit<AudioFeatures, 'isSilent'> }[] = [];

  constructor(private readonly analyser: AnalyserNode, private readonly sampleRate: number) {
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    this.timeDomain = new Float32Array(analyser.fftSize);
    this.spectrum = new Float32Array(analyser.frequencyBinCount);
  }

  sample(now = performance.now()): AudioFeatures {
    const { rms, bassEnergy, midEnergy, trebleEnergy, brightness } = silentFeatures;
    const values = { rms, bassEnergy, midEnergy, trebleEnergy, brightness };
    this.analyser.getFloatTimeDomainData(this.timeDomain);
    this.analyser.getFloatFrequencyData(this.spectrum);
    let squares = 0;
    for (const value of this.timeDomain) squares += value * value;
    values.rms = Math.min(1, Math.sqrt(squares / this.timeDomain.length));
    if (values.rms >= 0.001) {
      let bass = 0;
      let mid = 0;
      let treble = 0;
      let weighted = 0;
      for (let bin = 1; bin < this.spectrum.length; bin++) {
        const hz = bin * this.sampleRate / this.analyser.fftSize;
        const power = 10 ** (this.spectrum[bin] / 10);
        if (hz < 250) bass += power;
        else if (hz < 2000) mid += power;
        else treble += power;
        weighted += Math.min(hz, 10000) * power;
      }
      const total = bass + mid + treble;
      if (total > 0) {
        values.bassEnergy = bass / total;
        values.midEnergy = mid / total;
        values.trebleEnergy = treble / total;
        values.brightness = weighted / (total * 10000);
      }
    }
    this.history.push({ at: now, values });
    while (this.history[0].at < now - 2000) this.history.shift();
    const average = { ...silentFeatures };
    const keys = ['rms', 'bassEnergy', 'midEnergy', 'trebleEnergy', 'brightness'] as const;
    for (const key of keys) {
      const total = this.history.reduce((sum, entry) => sum + entry.values[key], 0);
      average[key] = Math.min(1, total / this.history.length);
    }
    average.isSilent = this.history.every(entry => entry.values.rms < 0.001);
    return average;
  }
}
