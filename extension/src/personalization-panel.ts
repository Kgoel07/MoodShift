import { installationIdPattern, preferenceLimit } from './shared/preferences';

const storageKey = 'moodshiftPersonalization';
type Settings = { installationId: string; enabled: boolean };
type Action = { action: 'remember'; preference: string; enabled: true } | { action: 'view' } | { action: 'clear' };

function parseSettings(value: unknown): Settings | undefined {
  const settings = value as Settings | undefined;
  if (typeof settings?.installationId === 'string' && installationIdPattern.test(settings.installationId)) {
    return { installationId: settings.installationId, enabled: settings.enabled === true };
  }
}

async function updateSettings(enabled?: boolean): Promise<Settings> {
  return navigator.locks.request(storageKey, async () => {
    const stored = parseSettings((await chrome.storage.local.get(storageKey))[storageKey]);
    if (stored && (enabled === undefined || stored.enabled === enabled)) return stored;
    const next = { installationId: stored?.installationId ?? crypto.randomUUID(), enabled: enabled ?? false };
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
  const view = query<HTMLButtonElement>('#memory-view');
  const clear = query<HTMLButtonElement>('#memory-clear');
  const list = query<HTMLUListElement>('#memory-list');
  const state = query<HTMLParagraphElement>('#memory-status');
  let settings: Settings | undefined;
  let ready = false;
  let busy = false;
  let clearing = false;

  function controls(): void {
    enable.disabled = !ready || busy;
    field.disabled = !settings?.enabled || busy;
    save.disabled = field.disabled || !field.value.trim();
    view.disabled = !ready || busy;
    clear.disabled = !ready || busy;
  }

  function setSettings(next?: Settings): void {
    const changed = !!settings?.enabled !== !!next?.enabled || (next?.enabled && settings?.installationId !== next?.installationId);
    settings = next;
    ready = true;
    enable.checked = next?.enabled === true;
    controls();
    if (changed) onChange();
  }

  function showPreferences(preferences: readonly string[]): void {
    list.replaceChildren(...preferences.map(text => {
      const node = document.createElement('li');
      node.textContent = text;
      return node;
    }));
    list.hidden = !preferences.length;
  }

  async function run(work: () => Promise<string>): Promise<string> {
    if (busy) return 'Wait for the current preference action to finish.';
    busy = true;
    controls();
    state.textContent = 'Working…';
    try {
      const message = await work();
      state.textContent = message;
      return message;
    } catch (error) {
      const message = error instanceof TypeError ? 'Could not reach the local proxy.'
        : error instanceof Error ? error.message : 'Could not complete the preference action.';
      state.textContent = message;
      return message;
    } finally {
      busy = false;
      controls();
    }
  }

  async function remote(action: Action): Promise<unknown> {
    const latest = await updateSettings();
    if (action.action === 'remember' && !latest.enabled) throw new Error('Enable personalization to remember a preference.');
    const response = await fetch('http://127.0.0.1:8787/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...action, installationId: latest.installationId }),
      signal: AbortSignal.timeout(6500),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(typeof result?.error === 'string' ? result.error.slice(0, 240) : 'Supermemory could not complete the request.');
    }
    return result;
  }

  function remember(preference: string): Promise<string> {
    return run(async () => {
      if (!settings?.enabled) throw new Error('Enable personalization to remember a preference.');
      const text = preference.trim();
      if (!text || text.length > preferenceLimit || /[\u0000-\u001f\u007f]/.test(text)) {
        throw new Error(`Enter a single sound preference up to ${preferenceLimit} characters.`);
      }
      const reply = await remote({ action: 'remember', preference: text, enabled: true }) as { remembered?: boolean; processing?: boolean };
      if (reply?.remembered !== true) throw new Error('Supermemory did not confirm the preference.');
      if (field.value.trim() === text) field.value = '';
      return reply.processing ? 'Preference sent to Supermemory. Indexing may take a moment.' : 'Preference saved to Supermemory.';
    });
  }

  enable.addEventListener('change', () => {
    const enabled = enable.checked;
    if (!enabled && settings) setSettings({ ...settings, enabled: false });
    void run(async () => {
      try { setSettings(await updateSettings(enabled)); } catch {
        setSettings(parseSettings((await chrome.storage.local.get(storageKey))[storageKey]));
        throw new Error('Could not save the personalization setting.');
      }
      return enabled ? 'Personalization enabled.' : 'Personalization disabled. Use Clear remote preferences to remove stored data.';
    });
  });
  field.addEventListener('input', controls);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!save.disabled) void remember(field.value);
  });
  view.addEventListener('click', () => void run(async () => {
    showPreferences([]);
    const reply = await remote({ action: 'view' }) as { preferences?: unknown; hasMore?: boolean };
    if (!Array.isArray(reply?.preferences) || !reply.preferences.every(text => typeof text === 'string')) {
      throw new Error('Supermemory returned an unreadable preference list.');
    }
    showPreferences(reply.preferences.slice(0, 30));
    return reply.hasMore ? 'Showing up to 30 indexed preferences.' : reply.preferences.length ? 'Preferences from Supermemory.' : 'No indexed preferences found.';
  }));
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
  }));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[storageKey]) setSettings(parseSettings(changes[storageKey].newValue));
  });
  void chrome.storage.local.get(storageKey)
    .then(values => setSettings(parseSettings(values[storageKey])))
    .catch(() => { state.textContent = 'Could not read personalization settings.'; });

  return {
    remember,
    context() {
      return settings?.enabled && !clearing ? { enabled: true as const, installationId: settings.installationId } : undefined;
    },
  };
}
