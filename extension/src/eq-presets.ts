import { customEqPreset, validateBands, type EqBand } from './shared/equalizer';

export const eqPresetsKey = 'moodshiftEqPresets';
const maxPresets = 30;
export interface EqPreset { id: string; name: string; bands: EqBand[]; }

export function readEqPresets(input: unknown): EqPreset[] {
  if (!Array.isArray(input)) return [];
  const result = new Map<string, EqPreset>();
  for (const row of input.slice(0, maxPresets)) {
    if (typeof row?.id !== 'string' || !customEqPreset.test(row.id) || typeof row?.name !== 'string'
      || !row.name.trim() || row.name.length > 48) continue;
    try { result.set(row.id, { id: row.id, name: row.name.trim(), bands: validateBands(row.bands) }); }
    catch { /* Keep the available presets if one row is invalid. */ }
  }
  return [...result.values()];
}

export async function loadEqPresets(): Promise<EqPreset[]> {
  return readEqPresets((await chrome.storage.local.get(eqPresetsKey))[eqPresetsKey]);
}

export async function saveEqPreset(name: string, bands: EqBand[]): Promise<EqPreset> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 48) throw new Error('Enter a name between 1 and 48 characters.');
  const preset = { id: `eq:${crypto.randomUUID()}`, name: trimmed, bands: validateBands(bands) };
  return navigator.locks.request(eqPresetsKey, async () => {
    const presets = await loadEqPresets();
    if (presets.some(row => row.name.toLowerCase() === trimmed.toLowerCase())) throw new Error('An EQ preset already uses that name.');
    if (presets.length >= maxPresets) throw new Error('Delete an EQ preset before saving another.');
    await chrome.storage.local.set({ [eqPresetsKey]: [...presets, preset] });
    return preset;
  });
}

export async function deleteEqPreset(id: string): Promise<void> {
  await navigator.locks.request(eqPresetsKey, async () => {
    const presets = await loadEqPresets();
    await chrome.storage.local.set({ [eqPresetsKey]: presets.filter(preset => preset.id !== id) });
  });
}
