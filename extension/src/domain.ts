import { EqChart, gainLabel } from './eq-chart';
import { mountEqPresetControls } from './eq-preset-controls';
import { TuningClient, type TuningView } from './tuning-client';
import { defaultBands, customBandLimit, eqRange, isDefaultBand, type EqBand } from './shared/equalizer';
import { spectrumSize } from './shared/eq-response';
import { eqSpectrumPort } from './shared/tuning';
import type { StatusChanged } from './shared/messages';

const find = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const report = (message: string) => { find('#domain-status').textContent = message; };
const client = new TuningClient(report);
const plot = find('#domain-plot');
const points = find('#domain-points');
const chart = new EqChart(find<HTMLCanvasElement>('#domain-canvas'), false, positionPoints);
const picker = find<HTMLSelectElement>('#domain-band');
const enabled = find<HTMLInputElement>('#domain-enabled');
const remove = find<HTMLButtonElement>('#point-delete');
const add = find<HTMLButtonElement>('#point-add');
const inputs = { frequency: find<HTMLInputElement>('#point-frequency'), gain: find<HTMLInputElement>('#point-gain'), q: find<HTMLInputElement>('#point-q') };
const knobs = new Map<string, HTMLButtonElement>();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let view: TuningView = client.view;
let selected = defaultBands[0].id as string;
let drag: { pointer: number; point: string; xOffset: number; yOffset: number; last?: Pick<EqBand, 'frequency' | 'gain'> } | undefined;
let spectrum: chrome.runtime.Port | undefined;

function positionPoints(): void {
  for (const band of view.settings.eq.bands) {
    const button = knobs.get(band.id);
    if (!button) continue;
    const { x, y } = chart.position(band);
    button.style.left = `${x}px`;
    button.style.top = `${y}px`;
  }
}

function selectPoint(id: string): void {
  if (selected === id) return;
  selected = id;
  renderPointFields(true);
}

function renderPointFields(force = false): void {
  const bands = view.settings.eq.bands;
  const band = bands.find(point => point.id === selected) ?? bands[0];
  selected = band.id;
  picker.value = selected;
  for (const key of ['frequency', 'gain', 'q'] as const) {
    if (force || document.activeElement !== inputs[key]) inputs[key].value = String(band[key]);
  }
  for (const [id, button] of knobs) button.setAttribute('aria-pressed', String(id === selected));
  remove.disabled = isDefaultBand(selected);
  add.disabled = bands.length >= defaultBands.length + customBandLimit;
}

function syncSpectrum(): void {
  const shouldRun = view.status.phase === 'capturing' && !document.hidden && !reducedMotion.matches;
  if (!shouldRun) {
    const previous = spectrum;
    spectrum = undefined;
    previous?.disconnect();
    chart.setSpectrum();
    return;
  }
  if (spectrum) return;
  const port = chrome.runtime.connect({ name: eqSpectrumPort });
  spectrum = port;
  port.onMessage.addListener((message: unknown) => {
    if (spectrum !== port || !Array.isArray(message) || message.length !== spectrumSize) return;
    chart.setSpectrum(message);
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (spectrum === port) { spectrum = undefined; chart.setSpectrum(); }
  });
}

function createPoint(id: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'eq-point';
  button.dataset.eqPoint = id;
  button.addEventListener('click', () => selectPoint(id));
  button.addEventListener('focus', () => selectPoint(id));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const band = view.settings.eq.bands.find(band => band.id === id);
    if (!band) return;
    event.preventDefault();
    const patch = event.key === 'ArrowUp' || event.key === 'ArrowDown'
      ? { gain: band.gain + (event.key === 'ArrowUp' ? 0.5 : -0.5) }
      : { frequency: band.frequency * (event.key === 'ArrowRight' ? 1.06 : 1 / 1.06) };
    client.edit({ kind: 'eq-band', id, patch });
  });
  points.append(button);
  knobs.set(id, button);
  return button;
}

function render(next: TuningView): void {
  view = next;
  const { eq } = next.settings;
  const capture = next.status.phase === 'capturing' ? next.status : undefined;
  find('#domain-source').textContent = capture?.session.title ?? 'Start capture to hear your EQ';
  find<HTMLFieldSetElement>('#domain-toolbar').disabled = !next.ready;
  find<HTMLFieldSetElement>('#point-controls').disabled = !next.ready;
  enabled.checked = eq.enabled;
  chart.setEq(eq, capture?.audioTiming?.sampleRate);
  const trim = find('#eq-trim');
  trim.hidden = chart.trimDb >= -0.05;
  trim.textContent = `Automatic headroom ${chart.trimDb.toFixed(1)} dB`;
  for (const [id, button] of knobs) {
    if (eq.bands.some(band => band.id === id)) continue;
    button.remove();
    knobs.delete(id);
  }
  let custom = 0;
  const options: HTMLOptionElement[] = [];
  for (const band of eq.bands) {
    const name = defaultBands.find(entry => entry.id === band.id)?.name ?? `Custom ${++custom}`;
    options.push(new Option(`${name} · ${band.frequency} Hz`, band.id));
    const button = knobs.get(band.id) ?? createPoint(band.id);
    button.disabled = !next.ready;
    button.setAttribute('aria-label', `${name}, ${band.frequency} Hz, ${gainLabel(band.gain)} dB, Q ${band.q}`);
    button.title = `${name} · ${band.frequency} Hz · ${gainLabel(band.gain)} dB`;
  }
  // Retain the native select while dragging so its focus and keyboard behavior stay intact.
  if (options.length !== picker.options.length || options.some((option, i) => option.text !== picker.options[i]?.text
    || option.value !== picker.options[i]?.value)) picker.replaceChildren(...options);
  renderPointFields();
  positionPoints();
  syncSpectrum();
}

function addPoint(frequency: number, gain: number): string | undefined {
  if (add.disabled) { report(`You can add up to ${customBandLimit} custom points.`); return; }
  const point = { id: `point:${crypto.randomUUID()}`, frequency, gain, q: 1 };
  client.edit({ kind: 'eq-add', point });
  selectPoint(point.id);
  return point.id;
}

plot.addEventListener('pointerdown', event => {
  if (drag || event.button !== 0 || !view.ready) return;
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-eq-point]');
  let id = button?.dataset.eqPoint;
  if (!id) {
    const value = chart.editAt(event.clientX, event.clientY, false);
    if (!value) return;
    id = addPoint(value.frequency, value.gain);
    if (!id) return;
  }
  selectPoint(id);
  const rect = button?.getBoundingClientRect();
  drag = { pointer: event.pointerId, point: id,
    xOffset: rect ? event.clientX - rect.x - rect.width / 2 : 0,
    yOffset: rect ? event.clientY - rect.y - rect.height / 2 : 0 };
  plot.setPointerCapture(event.pointerId);
  knobs.get(id)?.focus({ preventScroll: true });
  event.preventDefault();
});

plot.addEventListener('pointermove', event => {
  if (drag?.pointer !== event.pointerId || !view.settings.eq.bands.some(band => band.id === drag?.point)) return;
  drag.last = chart.editAt(event.clientX - drag.xOffset, event.clientY - drag.yOffset);
  if (drag.last) client.edit({ kind: 'eq-band', id: drag.point, patch: drag.last }, true);
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
  plot.addEventListener(name, event => {
    if (drag?.pointer !== event.pointerId) return;
    const { last, point } = drag;
    drag = undefined;
    if (last && view.settings.eq.bands.some(band => band.id === point)) client.edit({ kind: 'eq-band', id: point, patch: last });
  });
}

for (const [property, input] of Object.entries(inputs)) {
  input.addEventListener('change', () => {
    if (Number.isFinite(input.valueAsNumber)) client.edit({ kind: 'eq-band', id: selected, patch: { [property]: input.valueAsNumber } });
    renderPointFields(true);
  });
}
picker.addEventListener('change', () => selectPoint(picker.value));
remove.addEventListener('click', () => client.edit({ kind: 'eq-remove', id: selected }));
add.addEventListener('click', () => {
  const id = addPoint(Math.round(Math.sqrt(eqRange.minHz * eqRange.maxHz)), 0);
  if (id) knobs.get(id)?.focus({ preventScroll: true });
});
enabled.addEventListener('change', () => client.edit({ kind: 'eq-enabled', enabled: enabled.checked }));
find('#domain-reset').addEventListener('click', () => client.edit({ kind: 'eq-reset' }));
find('#domain-close').addEventListener('click', () => window.close());
document.addEventListener('visibilitychange', syncSpectrum);
reducedMotion.addEventListener('change', syncSpectrum);
window.addEventListener('pagehide', () => spectrum?.disconnect());
chrome.runtime.onMessage.addListener((message: StatusChanged) => {
  if (message.target === 'panel' && message.type === 'STATUS_CHANGED') void client.refresh();
});
mountEqPresetControls(document.body, client, report);
client.subscribe(render);
void client.refresh();
