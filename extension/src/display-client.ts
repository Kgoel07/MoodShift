import { loadDisplay } from './control-state';
import { displayKeys, type DisplaySettings } from './shared/display-settings';
import { toWorker } from './shared/messages';

export function observeDisplay(render: (settings: DisplaySettings) => void, failure = () => {}): void {
  let generation = 0;
  const refresh = () => {
    const id = ++generation;
    void loadDisplay().then(settings => { if (id === generation) render(settings); }, failure);
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && displayKeys.some(key => Object.hasOwn(changes, key))) refresh();
  });
  refresh();
}

export async function setDisplay(control: string, value: number | boolean): Promise<void> {
  const reply = await toWorker({ type: 'SET_DISPLAY', action: { control, operation: 'set', value } });
  if (!reply.ok) throw new Error(reply.message);
}
