import { installationIdPattern, relevantPreferences } from './shared/preferences';
import { apiErrorDetail, apiRequest } from './api-client';
import { deployment } from './shared/deployment';
import { editLocalPreference, loadLocalPreferences, localPreferencesKey, parseLocalPreferences, soundPreferenceText } from './local-preferences';

const storageKey = 'moodshiftPersonalization';
type Settings = { installationId: string; enabled: boolean; useSupermemory: boolean };
type Action = { action: 'remember'; preference: string; enabled: true } | { action: 'view' } | { action: 'clear' };

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
  const remoteEnabled = query<HTMLInputElement>('#memory-remote-enabled');
  const remoteSave = query<HTMLButtonElement>('#memory-remote-save');
  const remoteField = query<HTMLInputElement>('#memory-remote-preference');
  const remoteForm = query<HTMLFormElement>('#memory-remote-form');
  const view = query<HTMLButtonElement>('#memory-view');
  const clear = query<HTMLButtonElement>('#memory-clear');
  const list = query<HTMLUListElement>('#memory-list');
  const state = query<HTMLParagraphElement>('#memory-status');
  const remoteState = query<HTMLParagraphElement>('#memory-remote-status');
  let settings: Settings | undefined;
  let ready = false;
  let busy = false;
  let clearing = false;
  let preferences: Awaited<ReturnType<typeof loadLocalPreferences>> = [];
  let editingId: string | undefined;

  function controls(): void {
    enable.disabled = !ready || busy;
    field.disabled = !ready || busy;
    save.disabled = field.disabled || !field.value.trim();
    cancel.disabled = busy;
    remoteEnabled.disabled = !ready || busy;
    remoteField.disabled = !settings?.enabled || !settings.useSupermemory || busy;
    remoteSave.disabled = remoteField.disabled || !remoteField.value.trim();
    view.disabled = !ready || busy;
    clear.disabled = !ready || busy;
    for (const button of localList.querySelectorAll('button')) button.disabled = busy;
  }

  function setSettings(next?: Settings): void {
    const changed = !!settings?.enabled !== !!next?.enabled || (next?.enabled
      && (settings?.installationId !== next.installationId || settings.useSupermemory !== next.useSupermemory));
    settings = next;
    ready = true;
    enable.checked = next?.enabled === true;
    remoteEnabled.checked = next?.useSupermemory === true;
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

  function showPreferences(preferences: readonly string[]): void {
    list.replaceChildren(...preferences.map(text => {
      const node = document.createElement('li');
      node.textContent = text;
      return node;
    }));
    list.hidden = !preferences.length;
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
      const message = error instanceof TypeError && status === remoteState ? (deployment.mode === 'development'
        ? 'Could not reach the local proxy.' : 'Could not reach the configured cloud API.')
        : error instanceof Error ? error.message : 'Could not complete the preference action.';
      status.textContent = message;
      return message;
    } finally {
      busy = false;
      controls();
    }
  }

  async function remote(action: Action): Promise<unknown> {
    const latest = await updateSettings();
    if (action.action === 'remember' && (!latest.enabled || !latest.useSupermemory)) {
      throw new Error('Enable personalization and Supermemory to save a cloud preference.');
    }
    const response = await apiRequest('/api/memory', { ...action, installationId: latest.installationId }, AbortSignal.timeout(6500));
    if (!response.ok) throw new Error(await apiErrorDetail(response));
    return response.json();
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
  remoteEnabled.addEventListener('change', () => {
    const useSupermemory = remoteEnabled.checked;
    void run(async () => {
      try { setSettings(await updateSettings({ useSupermemory })); }
      catch (error) { remoteEnabled.checked = settings?.useSupermemory === true; throw error; }
      return useSupermemory ? 'Supermemory enabled for compatible backends.' : 'Supermemory disabled. Remote preferences are kept.';
    }, remoteState);
  });
  remoteField.addEventListener('input', controls);
  remoteForm.addEventListener('submit', event => {
    event.preventDefault();
    if (remoteSave.disabled) return;
    void run(async () => {
      const text = soundPreferenceText(remoteField.value);
      const reply = await remote({ action: 'remember', preference: text, enabled: true }) as { remembered?: boolean; processing?: boolean };
      if (reply?.remembered !== true) throw new Error('Supermemory did not confirm the preference.');
      remoteField.value = '';
      return reply.processing ? 'Preference sent to Supermemory. Indexing may take a moment.' : 'Preference saved to Supermemory.';
    }, remoteState);
  });
  view.addEventListener('click', () => void run(async () => {
    showPreferences([]);
    const reply = await remote({ action: 'view' }) as { preferences?: unknown; hasMore?: boolean };
    if (!Array.isArray(reply?.preferences) || !reply.preferences.every(text => typeof text === 'string')) {
      throw new Error('Supermemory returned an unreadable preference list.');
    }
    showPreferences(reply.preferences.slice(0, 30));
    return reply.hasMore ? 'Showing up to 30 indexed preferences.' : reply.preferences.length ? 'Preferences from Supermemory.' : 'No indexed preferences found.';
  }, remoteState));
  clear.addEventListener('click', () => void run(async () => {
    clearing = true;
    onChange();
    try {
      const reply = await remote({ action: 'clear' }) as { cleared?: boolean };
      if (reply?.cleared !== true) throw new Error('Supermemory did not confirm deletion.');
      showPreferences([]);
      return 'Supermemory confirmed remote preferences were cleared.';
    } finally {
      clearing = false;
    }
  }, remoteState));
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
        personalization: settings.useSupermemory && !clearing ? { enabled: true as const, installationId: settings.installationId } : undefined,
      };
    },
  };
}
