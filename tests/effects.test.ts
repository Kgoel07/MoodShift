import { describe, expect, it } from 'vitest';
import { applyPatch, clampEffects, clampPatch, effectKeys, neutralEffects, presets } from '../extension/src/shared/effects';

const bounds = {
  bassDb: [-12, 8, 0], trebleDb: [-12, 8, 0], highpassHz: [20, 1500, 20],
  lowpassHz: [600, 20000, 20000], reverbMix: [0, 0.55, 0], delayMs: [0, 500, 0],
  delayMix: [0, 0.35, 0], delayFeedback: [0, 0.4, 0], distortion: [0, 0.5, 0],
  outputGainDb: [-12, 3, 0],
};

describe('effect state', () => {
  it.each(effectKeys)('uses the PRD neutral and clamps both bounds for %s', key => {
    const [min, max, neutral] = bounds[key];
    expect(neutralEffects[key]).toBe(neutral);
    expect(clampPatch({ [key]: -1e5 })).toEqual({ [key]: min });
    expect(clampPatch({ [key]: 1e5 })).toEqual({ [key]: max });
  });

  it.each([
    null, [], { bassDb: NaN }, { bassDb: Infinity }, { bassDb: '3' },
    { tempo: 0.5 }, JSON.parse('{"__proto__":{"bassDb":8}}'),
  ])('rejects malformed effect input %j', value => {
    expect(() => clampPatch(value)).toThrow();
  });

  it('preserves other fields through repeated patches', () => {
    const initial = applyPatch(neutralEffects, { reverbMix: 0.3, bassDb: 1 });
    const next = applyPatch(initial, { bassDb: 3 });
    expect(next).toEqual({ ...initial, bassDb: 3 });
    expect(applyPatch(next, { bassDb: 3 })).toEqual(next);
    expect(initial.bassDb).toBe(1);
    expect(clampEffects(next)).toEqual(next);
    expect(() => clampEffects({ bassDb: 3 })).toThrow();
  });

  it('replaces existing values with deterministic presets and resets to neutral', () => {
    const initial = applyPatch(neutralEffects, { reverbMix: 0.4, bassDb: 7, distortion: 0.3 });
    expect(applyPatch(initial, presets.Dreamy)).toEqual({ ...neutralEffects, reverbMix: 0.33, trebleDb: -2 });
    expect(applyPatch(initial, presets.Warm)).toEqual({ ...neutralEffects, bassDb: 2, trebleDb: -3 });
    expect(applyPatch(initial, presets.Underwater)).toEqual({ ...neutralEffects, lowpassHz: 1000 });
    expect(applyPatch(initial, presets['Bass Boost'])).toEqual({ ...neutralEffects, bassDb: 5 });
    expect(applyPatch(initial, presets['Clear Voice'])).toEqual({ ...neutralEffects, highpassHz: 100, bassDb: -2, trebleDb: 2 });
    expect(applyPatch(initial, neutralEffects)).toEqual(neutralEffects);
  });
});
