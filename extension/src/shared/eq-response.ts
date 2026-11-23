import { eqRange, type EqSettings } from './equalizer';

export const spectrumSize = 128;
const logSpan = Math.log(eqRange.maxHz / eqRange.minHz);
export const frequencyAt = (position: number) => eqRange.minHz * Math.exp(position * logSpan);
export const frequencyPosition = (frequency: number) => Math.log(frequency / eqRange.minHz) / logSpan;
export const effectiveFrequency = (frequency: number, rate: number) => Math.min(frequency, rate * 0.499);

/** The cascaded peaking-filter response specified by Web Audio, including automatic headroom. */
export function equalizerResponse(eq: EqSettings, rate: number) {
  const bands = eq.enabled ? eq.bands.filter(band => band.gain !== 0) : [];
  const coefficients = bands.map(({ frequency, gain, q }) => {
    const omega = 2 * Math.PI * effectiveFrequency(frequency, rate) / rate;
    const alpha = Math.sin(omega) / (2 * q);
    const amplitude = 10 ** (gain / 40);
    return { center: Math.cos(omega), numerator: alpha * amplitude, denominator: alpha / amplitude };
  });
  const rawDb = (hz: number): number => {
    const omega = 2 * Math.PI * effectiveFrequency(hz, rate) / rate;
    const cosine = Math.cos(omega), sine = Math.sin(omega);
    let db = 0;
    for (const { center, numerator, denominator } of coefficients) {
      const realSquared = (cosine - center) ** 2;
      db += 10 * Math.log10((realSquared + (numerator * sine) ** 2) / (realSquared + (denominator * sine) ** 2));
    }
    return db;
  };
  let peak = 0;
  if (bands.some(band => band.gain > 0)) {
    for (let i = 0; i <= 240; i++) peak = Math.max(peak, rawDb(frequencyAt(i / 240)));
    for (const band of bands) peak = Math.max(peak, rawDb(band.frequency));
  }
  const trimDb = Math.min(0, 12 - peak);
  return { trimDb, gainDb: (hz: number) => rawDb(hz) + trimDb };
}
