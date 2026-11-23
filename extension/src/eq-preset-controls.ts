import { eqPresets } from './shared/equalizer';
import { deleteEqPreset, eqPresetsKey, loadEqPresets, readEqPresets, saveEqPreset, type EqPreset } from './eq-presets';
import type { TuningClient } from './tuning-client';

export function mountEqPresetControls(root: HTMLElement, client: TuningClient, report: (message: string) => void): void {
  const select = root.querySelector<HTMLSelectElement>('[data-eq-preset]')!;
  const form = root.querySelector<HTMLFormElement>('#eq-preset-form');
  const name = form?.querySelector<HTMLInputElement>('input');
  const remove = root.querySelector<HTMLButtonElement>('#eq-preset-delete');
  let presets: EqPreset[] = [];
  let busy = false;

  function refreshSelection(): void {
    const { settings, ready } = client.view;
    const id = settings.eq.preset ?? '';
    select.value = [...select.options].some(option => option.value === id) ? id : '';
    select.disabled = busy || !ready;
    if (remove) remove.hidden = !presets.some(preset => preset.id === select.value);
  }

  function drawPresets(): void {
    const custom = new Option('Custom curve', '');
    custom.disabled = true;
    select.replaceChildren(custom, ...Object.entries(eqPresets).map(([id, { name }]) => new Option(name, id)));
    if (presets.length) {
      const saved = document.createElement('optgroup');
      saved.label = 'Saved EQ presets';
      for (const preset of presets) saved.append(new Option(preset.name, preset.id));
      select.append(saved);
    }
    refreshSelection();
  }

  async function run(work: () => Promise<string>): Promise<void> {
    if (busy) return;
    busy = true;
    refreshSelection();
    try { report(await work()); }
    catch (error) { report(error instanceof Error ? error.message : 'Couldn’t update your EQ presets.'); }
    finally { busy = false; refreshSelection(); }
  }

  select.addEventListener('change', () => {
    const saved = presets.find(preset => preset.id === select.value);
    client.edit({ kind: 'eq-preset', preset: select.value, ...(saved ? { bands: saved.bands } : {}) });
  });
  form?.addEventListener('submit', event => {
    event.preventDefault();
    if (!client.view.ready || !name) return;
    void run(async () => {
      const preset = await saveEqPreset(name.value, client.view.settings.eq.bands);
      name.value = '';
      presets = await loadEqPresets();
      drawPresets();
      return `Saved ${preset.name}.`;
    });
  });
  remove?.addEventListener('click', () => {
    const id = select.value;
    if (!presets.some(preset => preset.id === id)) return;
    void run(async () => {
      await deleteEqPreset(id);
      client.edit({ kind: 'eq-forget', preset: id });
      return 'EQ preset deleted.';
    });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[eqPresetsKey]) return;
    presets = readEqPresets(changes[eqPresetsKey].newValue);
    drawPresets();
  });
  client.subscribe(refreshSelection);
  drawPresets();
  void loadEqPresets().then(saved => { presets = saved; drawPresets(); })
    .catch(() => report('Couldn’t load your saved EQ presets.'));
}
