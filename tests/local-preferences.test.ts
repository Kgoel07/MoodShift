import { afterEach, expect, it, vi } from 'vitest';
import { editLocalPreference, loadLocalPreferences, localPreferencesKey } from '../extension/src/local-preferences';
import { relevantPreferences } from '../extension/src/shared/preferences';

afterEach(() => vi.unstubAllGlobals());

it('stores, reloads, edits and deletes local preferences independently from existing settings and presets', async () => {
  const existing = { moodshiftSavedPresets: [{ name: 'Saved mix' }], moodshiftPersonalization: { enabled: true } };
  let storage: Record<string, unknown> = structuredClone(existing);
  const mount = () => vi.stubGlobal('chrome', { storage: { local: {
    get: async (key: string) => ({ [key]: structuredClone(storage[key]) }),
    set: async (values: Record<string, unknown>) => { storage = { ...storage, ...structuredClone(values) }; },
  } } });
  vi.stubGlobal('navigator', { locks: { request: (_key: string, work: () => unknown) => work() } });
  mount();
  expect(await loadLocalPreferences()).toEqual([]);
  const [saved] = await editLocalPreference({ text: '  I like warm bass.  ' });
  mount();
  expect(await loadLocalPreferences()).toEqual([saved]);
  expect(saved.text).toBe('I like warm bass.');
  await expect(editLocalPreference({ text: 'i like warm bass.' })).rejects.toThrow('already saved');
  await expect(editLocalPreference({ text: 'a'.repeat(241) })).rejects.toThrow('240 characters');
  await expect(editLocalPreference({ id: saved.id, text: 'Less distortion' }))
    .resolves.toEqual([{ id: saved.id, text: 'Less distortion' }]);
  await expect(editLocalPreference({ id: saved.id, remove: true })).resolves.toEqual([]);
  expect(storage).toEqual({ ...existing, [localPreferencesKey]: [] });
});

it('selects matching preferences first and gives broad mood prompts a bounded recent context', () => {
  const preferences = ['Softer treble', 'Warm bass and minimal distortion', 'Small room reverb', 'Quiet volume', 'Short delay'];
  expect(relevantPreferences('Reduce the bass and distortion', preferences)).toEqual([preferences[1]]);
  expect(relevantPreferences('Make this song more relaxing', preferences)).toEqual(preferences.slice(0, 4));
  expect(relevantPreferences('More bass', [])).toEqual([]);
});
