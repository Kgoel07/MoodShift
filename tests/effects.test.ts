import { describe, expect, it } from 'vitest';
import { applyPatch, clampEffects, clampPatch, effectKeys, neutralEffects } from '../extension/src/shared/effects';
import { activeMoodScene, moodScenes } from '../extension/src/shared/mood-scenes';
import { silentFeatures, type CaptureStatus } from '../extension/src/shared/types';

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

  it('replaces the whole mix with each distinct, in-range scene', () => {
    const initial = applyPatch(neutralEffects, { reverbMix: 0.4, bassDb: 7, distortion: 0.3 });
    expect(moodScenes.map(({ name, subtitle }) => [name, subtitle])).toEqual([
      ['Midnight Drive', 'Deep & atmospheric'], ['Deep Focus', 'Calm & balanced'],
      ['Karaoke Night', 'Your turn to sing'], ['Energy Rush', 'Punchy & powerful'],
      ['Rainy Evening', 'Warm & mellow'], ['Cloud Nine', 'Dreamy & spacious'],
    ]);
    expect(new Set(moodScenes.map(scene => JSON.stringify(scene.effects))).size).toBe(6);
    expect(moodScenes.filter(scene => scene.stemMode === 'instrumental').map(scene => scene.id)).toEqual(['karaoke-night']);
    for (const scene of moodScenes) {
      expect(clampEffects(scene.effects)).toEqual(scene.effects);
      expect(applyPatch(initial, scene.effects)).toEqual(scene.effects);
      expect(scene.effects.distortion).toBe(0);
      expect(scene.effects.outputGainDb).toBeLessThanOrEqual(0);
    }
    expect(applyPatch(initial, neutralEffects)).toEqual(neutralEffects);
  });

  it('highlights only an exact audible match, including an active Instrumental karaoke mix', () => {
    const cloud = moodScenes.find(scene => scene.id === 'cloud-nine')!;
    const karaoke = moodScenes.find(scene => scene.id === 'karaoke-night')!;
    const capture: Extract<CaptureStatus, { phase: 'capturing' }> = {
      phase: 'capturing', session: { id: 'capture', tabId: 1, title: 'Music', muted: false },
      effects: { ...cloud.effects }, revision: 1, monitor: 'modified', stem: { phase: 'idle', mode: 'full' },
      features: silentFeatures, outputPaused: false,
    };
    expect(activeMoodScene(capture, {})).toBe(cloud);
    expect(activeMoodScene(capture, { trebleDb: -1 })).toBeUndefined();
    expect(activeMoodScene({ ...capture, monitor: 'original' }, {})).toBeUndefined();
    expect(activeMoodScene({ ...capture, effects: { ...cloud.effects, reverbMix: 0.2 } }, {})).toBeUndefined();
    const karaokeCapture = { ...capture, effects: { ...karaoke.effects } };
    expect(activeMoodScene({ ...karaokeCapture, stem: { phase: 'buffering', mode: 'instrumental' } }, {})).toBeUndefined();
    expect(activeMoodScene({ ...karaokeCapture, stem: { phase: 'unavailable', mode: 'full', message: 'Unavailable' } }, {})).toBeUndefined();
    expect(activeMoodScene({ ...karaokeCapture, stem: { phase: 'active', mode: 'instrumental' } }, {})).toBe(karaoke);
  });
});
