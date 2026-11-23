import { clampEffects, effectKeys, type AudioEffectState } from './shared/effects';
import { toWorker } from './shared/messages';
import type { CaptureStatus, MonitorMode, StemMode } from './shared/types';
import { validateReverb, type ReverbSettings } from './shared/reverb';

type Capture = Extract<CaptureStatus, { phase: 'capturing' }>;
export interface SavedPreset {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
  audioSettings: AudioEffectState;
  stemMode: StemMode;
  monitor: MonitorMode;
  reverb?: ReverbSettings;
}

export const savedPresetsKey = 'moodshiftSavedPresets';

function details(name: string, description?: string) {
  const trimmed = name.trim();
  const note = description?.trim();
  if (!trimmed || trimmed.length > 64 || (note?.length ?? 0) > 200) {
    throw new Error('Enter a name up to 64 characters and an optional description up to 200.');
  }
  return { name: trimmed, description: note || undefined };
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validatePreset(value: unknown): SavedPreset {
  const preset = value as Partial<SavedPreset> | null;
  if (preset?.schemaVersion !== 1 || typeof preset.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(preset.id)
    || !validDate(preset.createdAt) || !validDate(preset.updatedAt) || preset.updatedAt < preset.createdAt
    || typeof preset.name !== 'string' || (preset.description !== undefined && typeof preset.description !== 'string')
    || (preset.stemMode !== 'full' && preset.stemMode !== 'instrumental' && preset.stemMode !== 'vocals')
    || (preset.monitor !== 'original' && preset.monitor !== 'modified')) {
    throw new Error('This preset uses an invalid or unsupported format.');
  }
  return {
    schemaVersion: 1, id: preset.id, createdAt: preset.createdAt, updatedAt: preset.updatedAt,
    ...details(preset.name, preset.description), audioSettings: clampEffects(preset.audioSettings),
    stemMode: preset.stemMode, monitor: preset.monitor,
    ...(preset.reverb === undefined ? {} : { reverb: validateReverb(preset.reverb) }),
  };
}

function storedPreset(value: unknown): SavedPreset | undefined {
  try { return validatePreset(value); } catch { return undefined; }
}

function snapshot(capture: Capture) {
  if (capture.stem.phase === 'loading' || capture.stem.phase === 'buffering') {
    throw new Error('Wait for stem selection to finish before saving.');
  }
  const reverb = capture.reverb;
  return { audioSettings: capture.effects, stemMode: capture.stem.mode, monitor: capture.monitor,
    ...(reverb ? { reverb: { preset: reverb.preset, duration: reverb.duration, lastAmount: reverb.lastAmount } } : {}) };
}

async function read(): Promise<unknown[]> {
  const data = (await chrome.storage.local.get(savedPresetsKey))[savedPresetsKey];
  if (data === undefined) return [];
  if (!Array.isArray(data)) throw new Error('Saved presets could not be read.');
  return data;
}

export async function listPresets() {
  const rows = await read();
  const presets = rows.map(storedPreset).filter((preset): preset is SavedPreset => preset !== undefined);
  return { presets, skipped: rows.length - presets.length };
}

type PresetEdit =
  | { type: 'save'; name: string; description?: string; capture: Capture }
  | { type: 'rename'; id: string; name: string; description?: string }
  | { type: 'update'; id: string; capture: Capture }
  | { type: 'delete'; id: string };

export async function editPreset(edit: PresetEdit): Promise<string | undefined> {
  return navigator.locks.request(savedPresetsKey, async () => {
    const rows = await read();
    const existing = rows.map(storedPreset);
    const index = edit.type === 'save' ? rows.length : existing.findIndex(preset => preset?.id === edit.id);
    if (index < 0) throw new Error('This preset is no longer available.');
    if (edit.type === 'delete') {
      rows.splice(index, 1);
      await chrome.storage.local.set({ [savedPresetsKey]: rows });
      return;
    }
    const updatedAt = new Date().toISOString();
    const saved = existing[index];
    const preset = validatePreset(edit.type === 'save'
      ? { ...snapshot(edit.capture), ...details(edit.name, edit.description), id: crypto.randomUUID(),
          createdAt: updatedAt, updatedAt, schemaVersion: 1 }
      : { ...saved, updatedAt: saved && saved.updatedAt > updatedAt ? saved.updatedAt : updatedAt,
          ...(edit.type === 'rename' ? details(edit.name, edit.description) : snapshot(edit.capture)) });
    if (existing.some(row => row && row.id !== preset.id && row.name.toLowerCase() === preset.name.toLowerCase())) {
      throw new Error('A preset already uses this name. Choose another name or update that preset.');
    }
    rows[index] = preset;
    await chrome.storage.local.set({ [savedPresetsKey]: rows });
    return preset.id;
  });
}

export async function applySavedPreset(input: SavedPreset, capture: Capture, current: () => boolean, send = toWorker) {
  const preset = validatePreset(input);
  const sessionId = capture.session.id;
  const assertCurrent = () => {
    if (!current()) throw new Error('Preset application was superseded.');
  };
  const requireCapture = (reply: Awaited<ReturnType<typeof toWorker>>): Capture => {
    assertCurrent();
    if (!reply.ok) throw new Error(reply.message);
    if (reply.status.phase !== 'capturing' || reply.status.session.id !== sessionId) {
      throw new Error('The selected tab changed during preset application.');
    }
    return reply.status;
  };
  let status = requireCapture(await send({
    type: 'APPLY_EFFECTS', sessionId, patch: preset.audioSettings, baseRevision: capture.revision,
    ...(preset.reverb ? { reverb: preset.reverb } : {}),
  }));
  const matches = () => effectKeys.every(key => status.effects[key] === preset.audioSettings[key])
    && (!preset.reverb || (status.reverb && status.reverb.preset === preset.reverb.preset
      && status.reverb.duration === preset.reverb.duration && status.reverb.lastAmount === preset.reverb.lastAmount));
  if (!matches()) throw new Error('Audio settings changed during preset application.');
  let limitation: string | undefined;
  if (status.stem.mode !== preset.stemMode
    || (preset.stemMode !== 'full' && status.stem.phase !== 'active')) {
    const reply = await send({ type: 'SET_STEM', sessionId, mode: preset.stemMode, baseRevision: status.revision });
    assertCurrent();
    if (reply.ok) status = requireCapture(reply);
    else {
      limitation = reply.message;
      status = requireCapture(await send({ type: 'GET_STATUS' }));
      if (!matches()) throw new Error('Audio settings changed during preset application.');
    }
  }
  if (status.monitor !== preset.monitor) {
    status = requireCapture(await send({ type: 'SET_MONITOR', sessionId, monitor: preset.monitor, baseRevision: status.revision }));
  }
  if (!matches() || status.monitor !== preset.monitor) throw new Error('Audio settings changed during preset application.');
  if (status.stem.mode !== preset.stemMode || (preset.stemMode !== 'full' && status.stem.phase !== 'active')) {
    limitation ??= 'The requested stem is unavailable.';
  }
  return { status, limitation };
}
