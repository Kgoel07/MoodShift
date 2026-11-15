import { editPreset, listPresets, savedPresetsKey, type SavedPreset } from './saved-presets';
import type { CaptureStatus } from './shared/types';

type Capture = Extract<CaptureStatus, { phase: 'capturing' }>;

export function mountSavedPresets(
  root: HTMLElement,
  readCapture: () => Promise<Capture>,
  restore: (preset: SavedPreset) => Promise<string>,
) {
  const query = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const select = query<HTMLSelectElement>('#saved-preset-list');
  const name = query<HTMLInputElement>('#saved-preset-name');
  const description = query<HTMLInputElement>('#saved-preset-description');
  const save = query<HTMLButtonElement>('#saved-preset-save');
  const apply = query<HTMLButtonElement>('#saved-preset-apply');
  const rename = query<HTMLButtonElement>('#saved-preset-rename');
  const update = query<HTMLButtonElement>('#saved-preset-update');
  const remove = query<HTMLButtonElement>('#saved-preset-delete');
  const status = query<HTMLParagraphElement>('#saved-preset-status');
  const notice = query<HTMLParagraphElement>('#saved-preset-notice');
  let presets: SavedPreset[] = [];
  let captureReady = false;
  let busy = false;
  let needsReload = false;
  let reloadId = 0;

  function controls(): void {
    const exists = presets.some(preset => preset.id === select.value);
    select.disabled = busy;
    name.disabled = busy;
    description.disabled = busy;
    save.disabled = busy || !captureReady || !name.value.trim();
    apply.disabled = busy || !captureReady || !exists;
    update.disabled = busy || !captureReady || !exists;
    rename.disabled = busy || !exists || !name.value.trim();
    remove.disabled = busy || !exists;
  }

  function fillName(): void {
    const preset = presets.find(item => item.id === select.value);
    name.value = preset?.name ?? '';
    description.value = preset?.description ?? '';
    controls();
  }

  async function reload(preferred = select.value): Promise<void> {
    const id = ++reloadId;
    const result = await listPresets();
    if (id !== reloadId) return;
    presets = result.presets;
    select.replaceChildren(new Option(presets.length ? 'Select a saved preset' : 'No saved presets', ''),
      ...presets.map(preset => new Option(preset.name, preset.id)));
    select.value = presets.some(preset => preset.id === preferred) ? preferred : '';
    notice.textContent = result.skipped ? 'Some stored presets use an invalid or unsupported format.' : '';
    controls();
  }

  async function run(work: () => Promise<string>): Promise<void> {
    if (busy) return;
    busy = true;
    status.textContent = '';
    controls();
    try { status.textContent = await work(); } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Could not access saved presets.';
    } finally {
      busy = false;
      controls();
      if (needsReload) {
        needsReload = false;
        refresh();
      }
    }
  }

  select.addEventListener('change', () => { fillName(); status.textContent = ''; });
  name.addEventListener('input', controls);
  save.addEventListener('click', () => void run(async () => {
    const id = await editPreset({ type: 'save', name: name.value, description: description.value, capture: await readCapture() });
    await reload(id);
    fillName();
    return 'Preset saved.';
  }));
  rename.addEventListener('click', () => void run(async () => {
    const id = await editPreset({ type: 'rename', id: select.value, name: name.value, description: description.value });
    await reload(id);
    fillName();
    return 'Preset details saved.';
  }));
  update.addEventListener('click', () => void run(async () => {
    await editPreset({ type: 'update', id: select.value, capture: await readCapture() });
    await reload();
    return 'Preset audio settings updated.';
  }));
  remove.addEventListener('click', () => void run(async () => {
    await editPreset({ type: 'delete', id: select.value });
    await reload('');
    fillName();
    return 'Preset deleted.';
  }));
  apply.addEventListener('click', () => void run(async () => {
    const { presets: current } = await listPresets();
    const preset = current.find(item => item.id === select.value);
    if (!preset) throw new Error('This preset is no longer available.');
    status.textContent = 'Applying preset…';
    return restore(preset);
  }));
  const refresh = () => void reload().catch(() => { notice.textContent = 'Could not read saved presets.'; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[savedPresetsKey]) return;
    if (busy) needsReload = true;
    else refresh();
  });
  refresh();
  return {
    setCaptureReady(ready: boolean) {
      captureReady = ready;
      controls();
    },
  };
}
