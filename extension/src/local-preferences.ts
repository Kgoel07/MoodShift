import { installationIdPattern, preferenceLimit, preferenceTextPattern, relevantPreferences } from './shared/preferences';

export const localPreferencesKey = 'moodshiftSoundPreferences';
export const personalizationKey = 'moodshiftPersonalization';
const maxPreferences = 30;
type Preference = { id: string; text: string };
type Edit = { id?: string; text: string } | { id: string; remove: true };

export function parseLocalPreferences(value: unknown): Preference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxPreferences || !value.every(row =>
    typeof row?.id === 'string' && installationIdPattern.test(row.id) && typeof row.text === 'string'
    && row.text.length <= preferenceLimit && preferenceTextPattern.test(row.text) && row.text.trim() === row.text)) {
    throw new Error('Could not read saved local preferences.');
  }
  return value;
}

export function soundPreferenceText(text: string): string {
  const trimmed = text.trim();
  if (!preferenceTextPattern.test(trimmed) || trimmed.length > preferenceLimit) {
    throw new Error(`Enter a single sound preference up to ${preferenceLimit} characters.`);
  }
  return trimmed;
}

export async function loadLocalPreferences(): Promise<Preference[]> {
  return parseLocalPreferences((await chrome.storage.local.get(localPreferencesKey))[localPreferencesKey]);
}

export async function promptPreferences(prompt: string): Promise<string[] | undefined> {
  const values = await chrome.storage.local.get([personalizationKey, localPreferencesKey]);
  if ((values[personalizationKey] as { enabled?: boolean } | undefined)?.enabled !== true) return;
  const matches = relevantPreferences(prompt, parseLocalPreferences(values[localPreferencesKey]).map(row => row.text));
  return matches.length ? matches : undefined;
}

export async function editLocalPreference(edit: Edit): Promise<Preference[]> {
  return navigator.locks.request(localPreferencesKey, async () => {
    const preferences = await loadLocalPreferences();
    const index = edit.id === undefined ? -1 : preferences.findIndex(row => row.id === edit.id);
    if (edit.id !== undefined && index < 0) throw new Error('This preference is no longer available.');
    if ('remove' in edit) preferences.splice(index, 1);
    else {
      const text = soundPreferenceText(edit.text);
      if (preferences.some(row => row.id !== edit.id && row.text.toLowerCase() === text.toLowerCase())) {
        throw new Error('This sound preference is already saved.');
      }
      if (index >= 0) preferences.splice(index, 1);
      if (preferences.length >= maxPreferences) throw new Error(`Delete a preference before saving more than ${maxPreferences}.`);
      preferences.unshift({ id: edit.id ?? crypto.randomUUID(), text });
    }
    await chrome.storage.local.set({ [localPreferencesKey]: preferences });
    return preferences;
  });
}
