import { installationIdPattern, relevantPreferences } from './shared/preferences';
import { editLocalPreference, loadLocalPreferences, localPreferencesKey, parseLocalPreferences } from './local-preferences';

const storageKey = 'moodshiftPersonalization';
type Settings = { installationId: string; enabled: boolean; useSupermemory: boolean };
function parseSettings(value: unknown): Settings | undefined {
  const settings = value as Settings | undefined;
  if (typeof settings?.installationId === 'string' && installationIdPattern.test(settings.installationId)) {
    return {
      installationId: settings.installationId, enabled: settings.enabled === true,
      useSupermemory: typeof settings.useSupermemory === 'boolean' ? settings.useSupermemory : settings.enabled === true,
    };
  }
}

async function updateSettings(changes: Partial<Omit<Settings, 'installationId'>> = {}): Promise<Settings> {
  return navigator.locks.request(storageKey, async () => {
    const stored = parseSettings((await chrome.storage.local.get(storageKey))[storageKey]);
    const next = { installationId: crypto.randomUUID(), enabled: false, useSupermemory: false, ...stored, ...changes };
    if (stored && next.enabled === stored.enabled && next.useSupermemory === stored.useSupermemory) return stored;
    await chrome.storage.local.set({ [storageKey]: next });
    return next;
  });
}

export function mountPersonalization(root: HTMLElement, onChange: () => void) {
  const query = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const enable = query<HTMLInputElement>('#memory-enabled');
  const form = query<HTMLFormElement>('#memory-form');
  const field = query<HTMLInputElement>('#memory-preference');
  const save = query<HTMLButtonElement>('#memory-save');
  const cancel = query<HTMLButtonElement>('#memory-cancel-edit');
  const localList = query<HTMLUListElement>('#memory-local-list');
  const state = query<HTMLParagraphElement>('#memory-status');
  let settings: Settings | undefined;
  let ready = false;
  let busy = false;
  let preferences: Awaited<ReturnType<typeof loadLocalPreferences>> = [];
  let editingId: string | undefined;

  function controls(): void {
    enable.disabled = !ready || busy;
    field.disabled = !ready || busy;
    save.disabled = field.disabled || !field.value.trim();
    cancel.disabled = busy;
    for (const button of localList.querySelectorAll('button')) button.disabled = busy;
  }

  function setSettings(next?: Settings): void {
    const changed = !!settings?.enabled !== !!next?.enabled || (next?.enabled
      && (settings?.installationId !== next.installationId || settings.useSupermemory !== next.useSupermemory));
    settings = next;
    ready = true;
    enable.checked = next?.enabled === true;
    controls();
    if (changed) onChange();
  }

  function setEditing(id?: string, text = ''): void {
    editingId = id;
    field.value = text;
    save.textContent = id ? 'Save changes' : 'Save locally';
    cancel.hidden = !id;
    controls();
  }

  function showLocal(next: typeof preferences): void {
    if (JSON.stringify(preferences) === JSON.stringify(next)) return;
    preferences = next;
    localList.replaceChildren(...next.map(({ id, text }) => {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = text;
      const actions = document.createElement('div');
      actions.className = 'saved-preset-actions';
      for (const action of ['Edit', 'Delete']) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = action;
        button.setAttribute('aria-label', `${action} preference: ${text}`);
        button.addEventListener('click', () => {
          if (action === 'Edit') {
            setEditing(id, text);
            field.focus();
          } else {
            void run(async () => {
              showLocal(await editLocalPreference({ id, remove: true }));
              if (editingId === id) setEditing();
              return 'Local preference deleted.';
            }).then(() => field.focus());
          }
        });
        actions.append(button);
      }
      row.append(label, actions);
      return row;
    }));
    localList.hidden = !next.length;
    controls();
    if (settings?.enabled) onChange();
  }

  async function run(work: () => Promise<string>, status = state): Promise<string> {
    if (busy) return 'Wait for the current preference action to finish.';
    busy = true;
    controls();
    status.textContent = 'Working…';
    try {
      const message = await work();
      status.textContent = message;
      return message;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update your preferences. Try again.';
      status.textContent = message;
      return message;
    } finally {
      busy = false;
      controls();
    }
  }

  function remember(preference: string, id?: string): Promise<string> {
    return run(async () => {
      showLocal(await editLocalPreference({ id, text: preference }));
      if (editingId === id && field.value.trim() === preference.trim()) setEditing();
      return id ? 'Local preference updated.' : 'Preference saved on this device.';
    });
  }

  enable.addEventListener('change', () => {
    const enabled = enable.checked;
    if (!enabled && settings) setSettings({ ...settings, enabled: false });
    void run(async () => {
      try { setSettings(await updateSettings({ enabled })); } catch {
        setSettings(parseSettings((await chrome.storage.local.get(storageKey))[storageKey]));
        throw new Error('Could not save the personalization setting.');
      }
      return enabled ? 'Personalization enabled.' : 'Personalization disabled. Saved preferences are kept.';
    });
  });
  field.addEventListener('input', controls);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!save.disabled) void remember(field.value, editingId);
  });
  cancel.addEventListener('click', () => { setEditing(); field.focus(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[storageKey]) setSettings(parseSettings(changes[storageKey].newValue));
    if (changes[localPreferencesKey]) {
      try { showLocal(parseLocalPreferences(changes[localPreferencesKey].newValue)); }
      catch { state.textContent = 'Could not read saved local preferences.'; }
    }
  });
  void chrome.storage.local.get(storageKey)
    .then(values => setSettings(parseSettings(values[storageKey])))
    .catch(() => { state.textContent = 'Could not read personalization settings.'; });
  void loadLocalPreferences().then(showLocal).catch(() => { state.textContent = 'Could not read saved local preferences.'; });

  return {
    remember,
    context(prompt: string) {
      if (!settings?.enabled) return {};
      const localPreferences = relevantPreferences(prompt, preferences.map(row => row.text));
      return {
        localPreferences: localPreferences.length ? localPreferences : undefined,
      };
    },
  };
}
