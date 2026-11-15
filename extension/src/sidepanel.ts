import { effectKeys, effectSpecs, neutralEffects, presets, type EffectPatch } from './shared/effects';
import { mountLyrics } from './lyrics-panel';
import { mountChords } from './chords-panel';
import { mountSavedPresets } from './saved-presets-panel';
import { applySavedPreset, type SavedPreset } from './saved-presets';
import { mountPersonalization } from './personalization-panel';
import { mountPanelTabs } from './panel-tabs';
import { explicitPreference } from './shared/preferences';
import { meterChannel, toWorker, type MeterUpdate, type StatusChanged, type WorkerCommand } from './shared/messages';
import { directStemIntent, parseInterpretation, silentFeatures, type AudioFeatures, type CaptureStatus, type MonitorMode, type StemMode } from './shared/types';
import { usesCloudStems } from './shared/deployment';
import { apiFeedback, apiRequest, DemoAccessRequired } from './api-client';

mountPanelTabs();

const logoPath = chrome.runtime.getManifest().icons?.[128];
if (logoPath) {
  const logo = new Image(32, 32);
  logo.className = 'brand-logo';
  logo.alt = '';
  logo.addEventListener('load', () => document.querySelector('.brand-mark')?.replaceWith(logo), { once: true });
  logo.src = chrome.runtime.getURL(logoPath);
}

const statusLabel = document.querySelector<HTMLParagraphElement>('#status')!;
const chords = mountChords(document.querySelector<HTMLElement>('#chords')!);
const lyrics = mountLyrics(document.querySelector<HTMLElement>('#lyrics')!,
  document.querySelector<HTMLElement>('#current-song')!, chords.setPlayback);
const stopButton = document.querySelector<HTMLButtonElement>('#stop')!;
const meter = document.querySelector<HTMLMeterElement>('#meter')!;
const inputStatus = document.querySelector<HTMLParagraphElement>('#input-status')!;
const feedback = document.querySelector<HTMLParagraphElement>('#feedback')!;
const controls = document.querySelector<HTMLFieldSetElement>('#controls')!;
const presetGroup = document.querySelector<HTMLDivElement>('#presets')!;
const monitorButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')];
const stemButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-stem]')];
const stemLabel = document.querySelector<HTMLParagraphElement>('#stem-status')!;
const form = document.querySelector<HTMLFormElement>('#interpret')!;
const promptInput = document.querySelector<HTMLTextAreaElement>('#prompt')!;
const applyButton = document.querySelector<HTMLButtonElement>('#apply')!;
let status: CaptureStatus = { phase: 'ready' };
let refreshId = 0;
let commandId = 0;
let stopping = false;
let queuedEdits: EffectPatch = {};
let editTimer: ReturnType<typeof setTimeout> | undefined;
let commandPending = false;
let presetApplying = false;
let interpretation: { id: string; controller: AbortController } | undefined;
const savedPresets = mountSavedPresets(document.querySelector<HTMLElement>('#saved-presets')!, readCapture, restorePreset);
const personalization = mountPersonalization(document.querySelector<HTMLElement>('#personalization')!, () => {
  if (interpretation) {
    cancelInterpretation();
    feedback.textContent = 'Personalization changed. Submit the prompt again.';
  }
});

document.querySelector<HTMLElement>('#cloud-stem-note')!.hidden = !usesCloudStems();

function updateApply(): void {
  applyButton.disabled = status.phase !== 'capturing' || stopping || commandPending
    || interpretation !== undefined || Object.keys(queuedEdits).length > 0 || !promptInput.value.trim();
  savedPresets.setCaptureReady(status.phase === 'capturing' && !stopping && !commandPending
    && !interpretation && !Object.keys(queuedEdits).length
    && status.stem.phase !== 'loading' && status.stem.phase !== 'buffering');
}

function cancelInterpretation(): void {
  interpretation?.controller.abort();
  interpretation = undefined;
  updateApply();
}

function renderMeter(features: AudioFeatures): void {
  const capture = status.phase === 'capturing' ? status : undefined;
  meter.value = capture && !capture.session.muted && !capture.outputPaused ? Math.sqrt(features.rms) : 0;
  inputStatus.textContent = capture?.outputPaused ? 'Playback paused. Click MoodShift on the playing tab to reconnect.'
    : capture?.session.muted ? 'This tab is muted.'
    : capture && features.isSilent ? 'Waiting for audio…' : '';
}

function stemNotice(detail: string): string {
  if (/another stem session is active/i.test(detail)) return 'Vocals and Instrumental are busy. Try again shortly.';
  if (/muted|unmute|audio output paused/i.test(detail)) return 'Resume or unmute the tab and try again.';
  if (/(?:access|private demo) code/i.test(detail)) return new DemoAccessRequired().message;
  return 'Could not switch the mix. Try again.';
}

function displayValue(value: number, unit: string): string {
  if (unit === '%') return `${Math.round(value * 100)}%`;
  return `${Number(value.toFixed(1))} ${unit}`;
}

const sliders = effectKeys.map(key => {
  const spec = effectSpecs[key];
  const label = document.createElement('label');
  const text = document.createElement('span');
  const value = document.createElement('output');
  const input = document.createElement('input');
  text.textContent = spec.label;
  input.id = `effect-${key}`;
  value.htmlFor = input.id;
  input.type = 'range';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  label.append(text, value, input);
  controls.append(label);
  input.addEventListener('input', () => {
    cancelInterpretation();
    queuedEdits[key] = input.valueAsNumber;
    updateApply();
    value.textContent = displayValue(input.valueAsNumber, spec.unit);
    clearTimeout(editTimer);
    editTimer = setTimeout(flushEdits, 45);
  });
  input.addEventListener('change', flushEdits);
  return { key, input, value };
});

for (const [name, patch] of [...Object.entries(presets), ['Reset', neutralEffects] as const]) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = name;
  button.addEventListener('click', () => {
    clearEdits();
    applyLocal(patch);
  });
  presetGroup.append(button);
}

function clearEdits(): void {
  clearTimeout(editTimer);
  queuedEdits = {};
}

function flushEdits(): void {
  const patch = queuedEdits;
  clearEdits();
  if (Object.keys(patch).length > 0) applyLocal(patch);
}

function applyLocal(patch: EffectPatch): void {
  cancelInterpretation();
  if (status.phase === 'capturing') void command({ type: 'APPLY_EFFECTS', sessionId: status.session.id, patch });
}

for (const button of monitorButtons) {
  button.addEventListener('click', () => {
    if (status.phase !== 'capturing') return;
    const monitor = button.dataset.mode as MonitorMode;
    void command({ type: 'SET_MONITOR', sessionId: status.session.id, monitor });
  });
}

for (const button of stemButtons) {
  button.addEventListener('click', () => {
    if (status.phase !== 'capturing') return;
    cancelInterpretation();
    void command({ type: 'SET_STEM', mode: button.dataset.stem as StemMode, sessionId: status.session.id });
  });
}

function render(next: CaptureStatus): void {
  const previousId = status.phase === 'capturing' ? status.session.id : undefined;
  const nextId = next.phase === 'capturing' ? next.session.id : undefined;
  if (previousId !== nextId) {
    clearEdits();
    commandId++;
    commandPending = false;
    presetApplying = false;
    cancelInterpretation();
    stopping = false;
    feedback.textContent = '';
  }
  status = next;
  chords.setCapture(nextId);
  lyrics.setSource(next.phase === 'capturing' ? next.session : undefined);
  lyrics.setTiming(next.phase === 'capturing' ? next.audioTiming : undefined);
  updateApply();
  stopButton.disabled = next.phase !== 'capturing' || stopping;
  const enabled = !stopButton.disabled && !presetApplying;
  controls.disabled = !enabled;
  for (const button of presetGroup.querySelectorAll('button')) button.disabled = !enabled;
  for (const button of monitorButtons) {
    button.disabled = !enabled;
    button.setAttribute('aria-pressed', String(button.dataset.mode === (next.phase === 'capturing' ? next.monitor : 'modified')));
  }
  const stem = next.phase === 'capturing' ? next.stem : undefined;
  for (const button of stemButtons) {
    button.disabled = !enabled;
    button.setAttribute('aria-pressed', String(button.dataset.stem === (stem?.mode ?? 'full')));
  }
  switch (stem?.phase) {
    case 'loading':
    case 'buffering': stemLabel.textContent = 'Preparing audio…'; break;
    case 'active':
      stemLabel.textContent = next.phase === 'capturing' && next.monitor === 'original'
        ? 'Playing the original mix.'
        : stem.mode === 'vocals' ? 'Playing vocals.' : 'Playing instrumental.';
      break;
    case 'unavailable': stemLabel.textContent = `Full mix selected. ${stemNotice(stem.message)}`; break;
    default: stemLabel.textContent = '';
  }
  const effects = next.phase === 'capturing' ? next.effects : neutralEffects;
  for (const { key, input, value } of sliders) {
    const setting = queuedEdits[key] ?? effects[key];
    input.value = String(setting);
    value.textContent = displayValue(setting, effectSpecs[key].unit);
  }
  renderMeter(next.phase === 'capturing' ? next.features : silentFeatures);
  switch (next.phase) {
    case 'ready': statusLabel.textContent = 'Ready · Click MoodShift on the tab you want to hear.'; break;
    case 'starting': statusLabel.textContent = `Capturing… · ${next.source.title}`; break;
    case 'capturing': statusLabel.textContent = `Listening to this tab · ${next.session.title}`; break;
    case 'error': statusLabel.textContent = 'Could not connect. Click MoodShift on the playing tab to try again.'; break;
  }
}

async function readCapture() {
  if (status.phase !== 'capturing' || commandPending || stopping || interpretation || Object.keys(queuedEdits).length) {
    throw new Error('Wait for the current audio change to finish.');
  }
  const sessionId = status.session.id;
  const reply = await toWorker({ type: 'GET_STATUS' }).catch(error => {
    console.warn('MoodShift could not read the active audio session', error);
    throw new Error('Could not connect. Reopen MoodShift and try again.');
  });
  if (!reply.ok || reply.status.phase !== 'capturing' || reply.status.session.id !== sessionId
    || status.phase !== 'capturing' || status.session.id !== sessionId || commandPending || stopping
    || interpretation || Object.keys(queuedEdits).length) {
    throw new Error('Select a tab and wait for the current audio change to finish.');
  }
  return reply.status;
}

async function restorePreset(preset: SavedPreset): Promise<string> {
  const capture = await readCapture();
  const id = ++commandId;
  commandPending = true;
  presetApplying = true;
  refreshId++;
  render(status);
  const current = () => id === commandId;
  try {
    const result = await applySavedPreset(preset, capture, current);
    if (!current()) throw new Error('The selected tab changed.');
    refreshId++;
    render(result.status);
    if (!result.limitation) return `Applied ✓ · ${preset.name}`;
    console.warn('MoodShift applied the preset without switching the mix', result.limitation);
    return `Effects applied. ${stemNotice(result.limitation)}`;
  } catch (error) {
    console.warn('MoodShift could not apply the preset', error);
    throw new Error('Could not apply the preset. Try again.');
  } finally {
    if (current()) {
      presetApplying = false;
      commandPending = false;
      render(status);
      void refresh();
    }
  }
}

async function command(message: Exclude<WorkerCommand, { type: 'GET_STATUS' }>, detail = '', stemMode?: StemMode): Promise<void> {
  const id = ++commandId;
  commandPending = true;
  updateApply();
  refreshId++;
  if (message.type === 'APPLY_EFFECTS' || message.type === 'SET_STEM') feedback.textContent = 'Applying…';
  try {
    let reply = await toWorker(message);
    if (id !== commandId) return;
    if (!reply.ok) throw new Error(reply.message);
    if (message.type === 'APPLY_EFFECTS' && stemMode && reply.status.phase === 'capturing') {
      reply = await toWorker({
        type: 'SET_STEM', mode: stemMode, sessionId: message.sessionId, baseRevision: reply.status.revision,
      });
      if (id !== commandId) return;
      if (!reply.ok) {
        console.warn('MoodShift could not switch the mix', reply.message);
        feedback.textContent = `Effects applied. ${stemNotice(reply.message)}`;
        void refresh();
        return;
      }
    }
    refreshId++;
    render(reply.status);
    if ((message.type === 'APPLY_EFFECTS' || message.type === 'SET_STEM')
      && reply.status.phase === 'capturing' && reply.status.session.id === message.sessionId) {
      feedback.textContent = detail ? `Applied ✓ · ${detail}` : 'Applied ✓';
    }
  } catch (error) {
    if (id !== commandId) return;
    stopping = false;
    console.warn('MoodShift audio change failed', error);
    feedback.textContent = message.type === 'SET_STEM' ? stemNotice(String(error))
      : message.type === 'STOP' ? 'Could not stop MoodShift. Try again.' : 'Could not change the sound. Try again.';
    void refresh();
  } finally {
    if (id === commandId) {
      commandPending = false;
      updateApply();
    }
  }
}

async function refresh(): Promise<void> {
  const id = ++refreshId;
  try {
    const reply = await toWorker({ type: 'GET_STATUS' });
    if (id === refreshId) {
      const next = reply.ok ? reply.status : { phase: 'error' as const, message: reply.message };
      if (next.phase === 'error') console.warn('MoodShift could not connect', next.message);
      render(next);
    }
  } catch {
    if (id === refreshId) render({ phase: 'error', message: 'Reopen MoodShift to reconnect.' });
  }
}

stopButton.addEventListener('click', () => {
  if (status.phase !== 'capturing') return;
  clearEdits();
  cancelInterpretation();
  stopping = true;
  presetApplying = false;
  render(status);
  void command({ type: 'STOP', sessionId: status.session.id });
});

promptInput.addEventListener('input', updateApply);
promptInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const prompt = promptInput.value.trim();
  if (applyButton.disabled || !prompt || prompt.length > 500 || status.phase !== 'capturing') return;
  const preference = explicitPreference(prompt);
  if (preference) {
    const message = await personalization.remember(preference);
    if (promptInput.value.trim() === prompt && !interpretation) feedback.textContent = message;
    return;
  }
  const { session, effects, revision, features, outputPaused } = status;
  const direct = directStemIntent(prompt);
  if (direct === 'unsupported') {
    feedback.textContent = 'MoodShift can isolate vocals or play the instrumental mix.';
    return;
  }
  if (direct) {
    await command({ type: 'SET_STEM', sessionId: session.id, mode: direct });
    return;
  }
  const request = { id: crypto.randomUUID(), controller: new AbortController() };
  interpretation = request;
  updateApply();
  feedback.textContent = 'Interpreting…';
  const deadline = setTimeout(() => request.controller.abort(), 15_000);
  try {
    const response = await apiRequest('/api/interpret', {
        prompt, currentEffects: effects,
        audioFeatures: session.muted || outputPaused ? silentFeatures : features,
        ...personalization.context(prompt),
    }, request.controller.signal);
    if (!response.ok) {
      const message = await apiFeedback(response, 'effects');
      if (interpretation?.id === request.id) feedback.textContent = message;
      return;
    }
    const body = await response.json();
    if (interpretation?.id !== request.id) return;
    const result = parseInterpretation(body, effects);
    const detail = [result.summary, result.unsupported.length ? `Unavailable · ${result.unsupported.join(', ')}` : '']
      .filter(Boolean).join(' ');
    if (result.mode === 'unsupported') {
      feedback.textContent = detail;
      return;
    }
    if (result.mode === 'patch' && Object.keys(result.patch).length === 0) {
      if (result.stemMode) {
        await command({ type: 'SET_STEM', sessionId: session.id, mode: result.stemMode, baseRevision: revision }, detail);
      } else feedback.textContent = detail;
      return;
    }
    await command({
      type: 'APPLY_EFFECTS',
      sessionId: session.id,
      baseRevision: revision,
      patch: result.mode === 'reset' ? neutralEffects : result.patch,
    }, detail, result.stemMode);
  } catch (error) {
    if (interpretation?.id !== request.id) return;
    if (error instanceof DemoAccessRequired) feedback.textContent = error.message;
    else {
      console.warn('MoodShift could not apply the request', error);
      feedback.textContent = request.controller.signal.aborted ? 'That took too long. Try again.'
        : error instanceof TypeError ? 'Gemini unavailable. Presets and manual controls still work.'
          : 'Could not apply your request. Try rephrasing it.';
    }
  } finally {
    clearTimeout(deadline);
    if (interpretation?.id === request.id) interpretation = undefined;
    updateApply();
  }
});

chrome.runtime.onMessage.addListener((message: StatusChanged) => {
  if (message.target === 'panel' && message.type === 'STATUS_CHANGED') void refresh();
});
const meterUpdates = new BroadcastChannel(meterChannel);
meterUpdates.addEventListener('message', (event: MessageEvent<MeterUpdate>) => {
  if (status.phase === 'capturing' && status.session.id === event.data.sessionId) {
    status.features = event.data.features;
    lyrics.setTiming(event.data.audioTiming);
    renderMeter(event.data.features);
  }
});
void refresh();
