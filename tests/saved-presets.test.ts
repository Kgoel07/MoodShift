import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySavedPreset, editPreset, listPresets, savedPresetsKey, validatePreset, type SavedPreset } from '../extension/src/saved-presets';
import { neutralEffects } from '../extension/src/shared/effects';
import type { Reply, WorkerCommand } from '../extension/src/shared/messages';
import { silentFeatures, type CaptureStatus } from '../extension/src/shared/types';

type Capture = Extract<CaptureStatus, { phase: 'capturing' }>;
const capture: Capture = {
  phase: 'capturing', session: { id: 'current', tabId: 42, title: 'Music', muted: false },
  effects: { ...neutralEffects, reverbMix: 0.283 }, revision: 0, outputPaused: false,
  monitor: 'original', stem: { phase: 'active', mode: 'vocals' }, features: silentFeatures,
};

let storage: Record<string, unknown>;
function save(captured = capture) {
  return editPreset({ type: 'save', name: ' Midnight Drive ', description: ' Soft ', capture: captured });
}

beforeEach(() => {
  storage = {};
  vi.stubGlobal('chrome', { storage: { local: {
    async get(key: string) { return { [key]: structuredClone(storage[key]) }; },
    async set(values: Record<string, unknown>) { Object.assign(storage, structuredClone(values)); },
  } } });
  let queue = Promise.resolve();
  vi.stubGlobal('navigator', { locks: { request<T>(_name: string, work: () => Promise<T>) {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  } } });
});
afterEach(() => vi.unstubAllGlobals());

describe('local saved presets', () => {
  it('saves the complete settings, reloads, renames and updates explicitly, then deletes', async () => {
    const id = (await save())!;
    const [original] = (await listPresets()).presets;
    expect(original).toMatchObject({
      id, name: 'Midnight Drive', description: 'Soft', schemaVersion: 1,
      audioSettings: capture.effects, stemMode: 'vocals', monitor: 'original',
    });
    await expect(save()).rejects.toThrow('already uses this name');
    await editPreset({ type: 'rename', id, name: ' Late Night ', description: ' Roomy ' });
    const [renamed] = (await listPresets()).presets;
    expect(renamed).toMatchObject({
      name: 'Late Night', description: 'Roomy', audioSettings: original.audioSettings, createdAt: original.createdAt,
    });
    const current = { ...capture, effects: { ...capture.effects, bassDb: 4 } };
    expect((await listPresets()).presets[0].audioSettings.bassDb).toBe(0);
    await editPreset({ type: 'update', id, capture: current });
    expect((await listPresets()).presets[0]).toMatchObject({ ...renamed, updatedAt: expect.any(String), audioSettings: current.effects });
    await editPreset({ type: 'delete', id });
    expect(await listPresets()).toEqual({ presets: [], skipped: 0 });
  });

  it('clamps numeric values and preserves unusable future records in storage', async () => {
    await save();
    const [base] = (await listPresets()).presets;
    const rows = [
      { ...base, schemaVersion: 2 },
      { ...base, audioSettings: { ...neutralEffects, bassDb: 40 } },
      { ...base, audioSettings: { bassDb: 4 } },
      { ...base, audioSettings: { ...neutralEffects, reverbMix: Infinity } },
    ];
    storage[savedPresetsKey] = rows;
    const result = await listPresets();
    expect(result.skipped).toBe(3);
    expect(result.presets[0].audioSettings.bassDb).toBe(8);
    await editPreset({ type: 'delete', id: base.id });
    expect(storage[savedPresetsKey]).toEqual([rows[0], rows[2], rows[3]]);
    expect(() => validatePreset({ ...base, stemMode: 'drums' })).toThrow();
    await expect(save({ ...capture, stem: { phase: 'buffering', mode: 'vocals' } })).rejects.toThrow('Wait');
  });

  it('keeps both records when saves overlap', async () => {
    await Promise.all([save(), editPreset({ type: 'save', name: 'Other', capture })]);
    expect((await listPresets()).presets.map(row => row.name)).toEqual(['Midnight Drive', 'Other']);
  });
});

describe('restoring a saved preset', () => {
  let preset: SavedPreset;
  const before: Capture = {
    ...capture, effects: { ...neutralEffects }, monitor: 'modified', stem: { phase: 'idle', mode: 'full' },
  };
  beforeEach(async () => {
    await save();
    [preset] = (await listPresets()).presets;
  });

  it('restores exact values through DSP, stem, and monitor ACKs with no network call', async () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const ack = (status: Capture): Reply => ({ ok: true, status });
    const effects = { ...before, effects: preset.audioSettings, revision: 1 };
    const stem = { ...effects, stem: capture.stem };
    const send = vi.fn<(message: WorkerCommand) => Promise<Reply>>()
      .mockResolvedValueOnce(ack(effects)).mockResolvedValueOnce(ack(stem))
      .mockResolvedValueOnce(ack({ ...stem, monitor: preset.monitor }));
    const restored = await applySavedPreset(preset, before, () => true, send);
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { type: 'APPLY_EFFECTS', sessionId: 'current', patch: preset.audioSettings, baseRevision: 0 },
      { type: 'SET_STEM', sessionId: 'current', mode: 'vocals', baseRevision: 1 },
      { type: 'SET_MONITOR', sessionId: 'current', monitor: 'original', baseRevision: 1 },
    ]);
    expect(restored.status).toMatchObject({ effects: preset.audioSettings, monitor: 'original', stem: capture.stem });
    expect(restored.limitation).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
  });

  it('reports an unavailable stem and requires an exact, current effects ACK', async () => {
    const fallback: Capture = {
      ...before, effects: preset.audioSettings, monitor: 'original',
      stem: { phase: 'unavailable', mode: 'full', message: 'Helper offline.' },
    };
    const send = vi.fn<(message: WorkerCommand) => Promise<Reply>>()
      .mockResolvedValueOnce({ ok: true, status: fallback }).mockResolvedValueOnce({ ok: false, message: 'Helper offline.' })
      .mockResolvedValueOnce({ ok: true, status: fallback });
    expect(await applySavedPreset(preset, before, () => true, send)).toEqual({ status: fallback, limitation: 'Helper offline.' });
    send.mockResolvedValue({ ok: true, status: before });
    await expect(applySavedPreset(preset, before, () => true, send)).rejects.toThrow('changed');
    await expect(applySavedPreset(preset, before, () => false, send)).rejects.toThrow('superseded');
  });
});
