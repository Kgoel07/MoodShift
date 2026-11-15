import { effectKeys, effectSpecs, neutralEffects, presets, type EffectPatch } from './shared/effects';
import { meterChannel, toWorker, type MeterUpdate, type StatusChanged, type WorkerCommand } from './shared/messages';
import { directStemIntent, parseInterpretation, silentFeatures, type AudioFeatures, type CaptureStatus, type MonitorMode, type StemMode } from './shared/types';
import { stemDelaySeconds } from './shared/stem-pcm';

const statusLabel = document.querySelector<HTMLParagraphElement>('#status')!;
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
let interpretation: { id: string; controller: AbortController } | undefined;

function updateApply(): void {
  applyButton.disabled = status.phase !== 'capturing' || stopping || commandPending
    || interpretation !== undefined || Object.keys(queuedEdits).length > 0 || !promptInput.value.trim();
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
    cancelInterpretation();
    stopping = false;
    feedback.textContent = '';
  }
  status = next;
  updateApply();
  const enabled = next.phase === 'capturing' && !stopping;
  stopButton.disabled = !enabled;
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
    case 'buffering': stemLabel.textContent = 'Buffering stem audio…'; break;
    case 'active':
      stemLabel.textContent = next.phase === 'capturing' && next.monitor === 'original'
        ? 'Original · Live mix. Modified resumes the delayed stem.'
        : `Active · Audio trails video by about ${stemDelaySeconds} s.`;
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
        feedback.textContent = `Effects updated. Stem unavailable · ${reply.message}`;
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
    const response = await fetch('http://127.0.0.1:8787/api/interpret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt, currentEffects: effects,
        audioFeatures: session.muted || outputPaused ? silentFeatures : features,
      }),
      signal: request.controller.signal,
    });
    const body = await response.json();
    if (interpretation?.id !== request.id) return;
    if (!response.ok) {
      const detail = typeof body?.error === 'string' ? body.error.slice(0, 240) : 'Check the local proxy.';
      if (response.status === 504) throw new Error('Gemini timed out. Try again.');
      if (response.status >= 500 || response.status === 429) throw new GeminiUnavailable(detail);
      throw new Error(detail);
    }
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
      const detail = error instanceof GeminiUnavailable ? error.message : 'Start the local proxy with npm run dev:server.';
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
