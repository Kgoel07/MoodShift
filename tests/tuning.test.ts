import { describe, expect, it } from 'vitest';
import { readEqPresets } from '../extension/src/eq-presets';
import { equalizerResponse, frequencyAt, frequencyPosition } from '../extension/src/shared/eq-response';
import { changeEq, customBandLimit, defaultBands, defaultEqualizer, eqPresets, validateBands, type EqBand } from '../extension/src/shared/equalizer';
import { pitchSettings } from '../extension/src/shared/pitch';
import { changeTuning, defaultTuning, readTuning, validateTuning } from '../extension/src/shared/tuning';

const point: EqBand = { id: 'point:12345678-1234-4123-8123-123456789abc', frequency: 768, gain: -3.3, q: 2.65 };

describe('pitch and EQ state', () => {
  it('bounds pitch values to tenths of a semitone and rejects malformed storage', () => {
    expect(defaultTuning().pitch).toEqual({ enabled: false, semitones: 0 });
    expect(pitchSettings({ enabled: true, semitones: 3.256 }).semitones).toBe(3.3);
    expect(pitchSettings({ enabled: false, semitones: -360 }).semitones).toBe(-6);
    expect(pitchSettings({ enabled: true, semitones: 6.025 }).semitones).toBe(6);
    for (const semitones of [NaN, Infinity, '3', undefined]) expect(() => pitchSettings({ enabled: true, semitones })).toThrow();
  });

  it('keeps unrelated pitch, EQ and Q values across edits, resets and persistence', () => {
    const tuning = changeTuning(defaultTuning(), { kind: 'pitch', patch: { semitones: -3.4, enabled: true } });
    const withPoint = changeTuning(tuning, { kind: 'eq-add', point });
    const changed = changeTuning(withPoint, { kind: 'eq-band', id: point.id, patch: { frequency: 634.8, gain: -28 } });
    expect(changed.eq.preset).toBeNull();
    expect(changed.eq.bands.at(-1)).toEqual({ ...point, frequency: 635, gain: -12 });
    expect(changed.pitch).toBe(tuning.pitch);
    expect(readTuning(JSON.parse(JSON.stringify(changed)))).toEqual(changed);
    expect(readTuning({ pitch: 'invalid', eq: changed.eq })).toEqual({ pitch: defaultTuning().pitch, eq: changed.eq });
    expect(validateTuning(changed)).toEqual(changed);
    const disabled = changeTuning(changed, { kind: 'pitch', patch: { enabled: false } });
    expect(disabled.pitch).toEqual({ enabled: false, semitones: -3.4 });
    expect(changeTuning(disabled, { kind: 'pitch', patch: { semitones: 0 } }).eq).toBe(changed.eq);
    expect(changeTuning(disabled, { kind: 'eq-reset' })).toEqual({ pitch: disabled.pitch, eq: defaultEqualizer() });
  });

  it('keeps the six base bands and limits custom points', () => {
    expect(defaultBands.map(band => band.frequency)).toEqual([60, 170, 400, 1000, 3000, 10_000]);
    const eq = changeEq(defaultEqualizer(), { kind: 'eq-add', point });
    expect(changeEq(eq, { kind: 'eq-remove', id: point.id }).bands).toEqual(defaultEqualizer().bands);
    expect(() => changeEq(eq, { kind: 'eq-remove', id: 'sub' })).toThrow();
    expect(() => validateBands([...eq.bands, point])).toThrow();
    expect(() => validateBands(eq.bands.slice(1))).toThrow();
    let full = defaultEqualizer();
    for (let i = 0; i < customBandLimit; i++) {
      full = changeEq(full, { kind: 'eq-add', point: { ...point, id: point.id.slice(0, -2) + String(i).padStart(2, '0') } });
    }
    expect(() => changeEq(full, { kind: 'eq-add', point })).toThrow();
    expect(() => changeEq(eq, { kind: 'eq-band', id: point.id, patch: { q: NaN } })).toThrow();
  });

  it('recalls each built-in EQ and keeps all fields in stored custom presets', () => {
    const eq = defaultEqualizer();
    for (const [preset, { gains }] of Object.entries(eqPresets)) {
      const recalled = changeEq({ ...eq, enabled: false }, { kind: 'eq-preset', preset });
      expect(recalled).toMatchObject({ enabled: true, preset });
      expect(recalled.bands.map(band => band.gain)).toEqual(gains);
    }
    const id = 'eq:12345678-1234-4123-8123-123456789abc';
    const custom = { id, name: 'Demo EQ', bands: [...eq.bands, point] };
    expect(readEqPresets([null, { ...custom, bands: [] }, custom])).toEqual([custom]);
    const restored = changeEq(eq, { kind: 'eq-preset', preset: id, bands: custom.bands });
    expect(restored).toEqual({ enabled: true, preset: id, bands: custom.bands });
    expect(changeEq(restored, { kind: 'eq-forget', preset: id })).toEqual({ ...restored, preset: null });
  });
});

describe('equalizer response', () => {
  const eq = defaultEqualizer();
  it('maps frequency logarithmically and stays neutral when flat or bypassed', () => {
    expect(frequencyAt(0)).toBe(20);
    expect(frequencyAt(1)).toBeCloseTo(20_000);
    expect(frequencyAt(0.5)).toBeCloseTo(Math.sqrt(20 * 20_000));
    expect(frequencyPosition(frequencyAt(0.75))).toBeCloseTo(0.75);
    expect(equalizerResponse(eq, 48000).gainDb(1000)).toBe(0);
    expect(equalizerResponse({ ...eq, enabled: false, bands: [point] }, 48000).gainDb(point.frequency)).toBe(0);
  });

  it('applies the requested boost or cut at each center and narrows with higher Q', () => {
    for (const band of eq.bands) {
      for (const gain of [10, -8]) {
        const curve = equalizerResponse({ ...eq, bands: [{ ...band, gain }] }, 48000);
        expect(curve.gainDb(band.frequency)).toBeCloseTo(gain, 6);
        expect(Math.abs(curve.gainDb(band.frequency / 2))).toBeLessThan(Math.abs(gain) / 2);
      }
    }
    const at = (q: number) => equalizerResponse({ ...eq, bands: [{ ...point, gain: 8, q }] }, 48000).gainDb(1000);
    expect(at(3)).toBeLessThan(at(0.5));
  });

  it('includes headroom when multiple boosts overlap', () => {
    const bands = eq.bands.map(band => ({ ...band, frequency: 900, gain: 8 }));
    const curve = equalizerResponse({ ...eq, bands }, 48000);
    expect(curve.trimDb).toBeCloseTo(-36);
    expect(curve.gainDb(900)).toBeCloseTo(12);
    expect(curve.gainDb(80)).toBeLessThan(-30);
  });
});
