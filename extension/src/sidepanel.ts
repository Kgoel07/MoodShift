import { effectKeys, effectSpecs, neutralEffects, presets, type EffectPatch } from './shared/effects';
import { mountLyrics } from './lyrics-panel';
import { mountChords } from './chords-panel';
import { mountSavedPresets } from './saved-presets-panel';
import { applySavedPreset, type SavedPreset } from './saved-presets';
import { mountPersonalization } from './personalization-panel';
import { mountPanelTabs } from './panel-tabs';
import { mountReverb } from './reverb-panel';
import { explicitPreference } from './shared/preferences';
import { meterChannel, toWorker, type MeterUpdate, type StatusChanged, type WorkerCommand } from './shared/messages';
import { directStemIntent, parseInterpretation, silentFeatures, type AudioFeatures, type CaptureStatus, type MonitorMode, type StemMode } from './shared/types';
import { deployment, demoCodePattern, usesCloudStems } from './shared/deployment';
import { apiErrorDetail, apiRequest, demoCodeKey } from './api-client';

mountPanelTabs();

const statusLabel = document.querySelector<HTMLParagraphElement>('#status')!;
const chords = mountChords(document.querySelector<HTMLElement>('#chords')!);
const lyrics = mountLyrics(document.querySelector<HTMLElement>('#lyrics')!, chords.setPlayback);
const stopButton = document.querySelector<HTMLButtonElement>('#stop')!;
const meter = document.querySelector<HTMLMeterElement>('#meter')!;
const inputStatus = document.querySelector<HTMLParagraphElement>('#input-status')!;
const feedback = document.querySelector<HTMLParagraphElement>('#feedback')!;
const controls = document.querySelector<HTMLFieldSetElement>('#controls')!;
const presetGroup = document.querySelector<HTMLDivElement>('#presets')!;
const monitorButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')];
const stemButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-stem]')];
const stemLabel = document.querySelector<HTMLParagraphElement>('#stem-status')!;
document.querySelector<HTMLElement>('#stem-buffer')!.textContent =
  `Worker · ${usesCloudStems() ? 'Cloud' : 'This device'} · ${deployment.stemDelaySeconds}s playback buffer`;
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
const reverb = mountReverb(document.querySelector<HTMLElement>('#audio-effects')!, patch => {
  if (status.phase === 'capturing') void command({ type: 'SET_REVERB', sessionId: status.session.id, patch });
}, cancelInterpretation);

if (deployment.mode === 'production') {
  document.querySelector<HTMLElement>('#cloud-settings')!.hidden = false;
  document.querySelector<HTMLElement>('#cloud-stem-note')!.hidden = !usesCloudStems();
  const settings = document.querySelector<HTMLFormElement>('#cloud-code-form')!;
  const field = document.querySelector<HTMLInputElement>('#cloud-code')!;
  const result = document.querySelector<HTMLElement>('#cloud-code-status')!;
  settings.addEventListener('submit', async event => {
    event.preventDefault();
    const code = field.value.trim();
    if (code && !demoCodePattern.test(code)) {
      result.textContent = 'Enter a 32–128 character code using letters, numbers, hyphens, or underscores.';
      return;
    }
    try {
      if (code) await chrome.storage.local.set({ [demoCodeKey]: code });
      else await chrome.storage.local.remove(demoCodeKey);
      cancelInterpretation();
      field.value = '';
      result.textContent = code ? 'Private demo code saved.' : 'Private demo code cleared.';
    } catch {
      result.textContent = 'Could not update the private demo code.';
    }
  });
}

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
  inputStatus.textContent = capture?.outputPaused ? 'Audio output paused. Click MoodShift on the source tab to retry.'
    : capture?.session.muted ? 'Source tab muted.'
    : capture && features.isSilent ? 'Paused or silent input.' : '';
}

function displayValue(value: number, unit: string): string {
  if (unit === '%') return `${Math.round(value * 100)}%`;
  return `${Number(value.toFixed(1))} ${unit}`;
}

const sliders = effectKeys.filter(key => key !== 'reverbMix').map(key => {
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
  lyrics.setSource(next.phase === 'capturing' ? next.session : undefined);
  updateApply();
  stopButton.disabled = next.phase !== 'capturing' || stopping;
  const enabled = !stopButton.disabled && !presetApplying;
  reverb.render(next, enabled);
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
    case 'loading': stemLabel.textContent = 'Connecting to the local model…'; break;
    case 'buffering': stemLabel.textContent = `Buffering stem audio · ${deployment.stemDelaySeconds} s delay…`; break;
    case 'active':
      stemLabel.textContent = next.phase === 'capturing' && next.monitor === 'original'
        ? 'Original · Live mix. Modified resumes the delayed stem.'
        : `Active · Audio trails video by about ${deployment.stemDelaySeconds} s.`;
      break;
    case 'unavailable': stemLabel.textContent = `Unavailable · ${stem.message}`; break;
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
    case 'error': statusLabel.textContent = `Error · ${next.message}`; break;
  }
}

async function readCapture() {
  if (status.phase !== 'capturing' || commandPending || stopping || interpretation || Object.keys(queuedEdits).length) {
    throw new Error('Wait for the current audio change to finish.');
  }
  const sessionId = status.session.id;
  const reply = await toWorker({ type: 'GET_STATUS' });
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
    if (!current()) throw new Error('Preset application was superseded.');
    refreshId++;
    render(result.status);
    return result.limitation ? `Effects and monitor applied. Stem unavailable · ${result.limitation}` : `Applied ✓ · ${preset.name}`;
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
  if (message.type === 'APPLY_EFFECTS' || message.type === 'SET_STEM' || message.type === 'SET_REVERB') feedback.textContent = 'Applying…';
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
        feedback.textContent = `Effects updated. Stem unavailable · ${reply.message}`;
        void refresh();
        return;
      }
    }
    refreshId++;
    render(reply.status);
    if ((message.type === 'APPLY_EFFECTS' || message.type === 'SET_STEM' || message.type === 'SET_REVERB')
      && reply.status.phase === 'capturing' && reply.status.session.id === message.sessionId) {
      feedback.textContent = detail ? `Applied ✓ · ${detail}` : 'Applied ✓';
    }
  } catch (error) {
    if (id !== commandId) return;
    stopping = false;
    feedback.textContent = `Error · ${error instanceof Error ? error.message : String(error)}`;
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
    if (id === refreshId) render(reply.ok ? reply.status : { phase: 'error', message: reply.message });
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

class GeminiUnavailable extends Error {}

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
    feedback.textContent = 'Unsupported · Beat, drum and bass isolation require separate stems.';
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
      const detail = await apiErrorDetail(response);
      if (response.status === 504) throw new Error('Gemini timed out. Try again.');
      if (response.status >= 500 || response.status === 429) throw new GeminiUnavailable(detail);
      throw new Error(detail);
    }
    const body = await response.json();
    if (interpretation?.id !== request.id) return;
    const result = parseInterpretation(body, effects);
    const detail = [result.summary, result.unsupported.length ? `Unsupported · ${result.unsupported.join(', ')}` : '']
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
    if (request.controller.signal.aborted) {
      feedback.textContent = 'Error · Gemini timed out. Try again.';
    } else if (error instanceof TypeError || error instanceof GeminiUnavailable) {
      const detail = error instanceof GeminiUnavailable ? error.message : deployment.mode === 'development'
        ? 'Start the local proxy with npm run dev:server.' : 'Check the configured cloud API connection.';
      feedback.textContent = `Offline · Gemini unavailable. Presets and manual controls still work. ${detail}`;
    } else {
      feedback.textContent = `Error · ${error instanceof Error ? error.message : 'Invalid Gemini reply.'}`;
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
    renderMeter(event.data.features);
  }
});
void refresh();
