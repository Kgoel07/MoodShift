import { statusChanged, toAudio, type AudioCommand, type Reply, type StemCodeReply, type StemCodeRequest, type WorkerMessage } from './shared/messages';
import type { CaptureStatus, SourceTab } from './shared/types';
import { usesCloudStems } from './shared/deployment';
import { cloudDemoCode } from './api-client';
import { installLyricsLookup } from './lyrics-provider';
import { installChordLookup } from './chords-provider';
import { platformFor } from './shared/track';
import { changeTuning, readTuning, tuningKey } from './shared/tuning';
import { controlState, loadControlPresets, loadDisplay } from './control-state';
import { applyControls, changeDisplay, isDisplayControl, parseControlActions } from './shared/controls';
import { storeDisplay } from './shared/display-settings';
import { effectKeys } from './shared/effects';

installLyricsLookup();
installChordLookup();

const offscreenUrl = chrome.runtime.getURL('offscreen.html');
let creating: Promise<void> | undefined;
let operations: Promise<void> = Promise.resolve();
let starting: SourceTab | undefined;
let failure: string | undefined;
const voiceUrl = chrome.runtime.getURL('voice.html');
let openingVoice: Promise<void> | undefined;

function openVoice(): Promise<void> {
  openingVoice ??= (async () => {
    const [window] = await chrome.runtime.getContexts({ documentUrls: [voiceUrl] });
    if (window && window.windowId >= 0) {
      try { await chrome.windows.update(window.windowId, { focused: true }); return; }
      catch { /* The previous window closed after the lookup. */ }
    }
    await chrome.windows.create({ url: voiceUrl, type: 'popup', width: 370, height: 335, focused: true });
  })().finally(() => { openingVoice = undefined; });
  return openingVoice;
}

chrome.commands.onCommand.addListener(command => {
  if (command === 'voice-command') void openVoice().catch(() => console.warn('MoodShift could not open voice commands.'));
});

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [offscreenUrl],
  });
  return contexts.length > 0;
}

function ensureOffscreen(): Promise<void> {
  creating ??= (async () => {
    if (await hasOffscreen()) return;
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Keep the selected tab audible while applying live audio effects.',
    });
  })().finally(() => { creating = undefined; });
  return creating;
}

function queue<T>(work: () => Promise<T>): Promise<T> {
  const next = operations.then(work);
  operations = next.then(() => undefined, () => undefined);
  return next;
}

async function audioStatus(): Promise<CaptureStatus> {
  if (!await hasOffscreen()) return { phase: 'ready' };
  try {
    const reply = await toAudio({ type: 'READ' });
    if (reply.ok) return reply.status;
    return { phase: 'error', message: reply.message };
  } catch (error) {
    if (await hasOffscreen()) throw error;
    return { phase: 'ready' };
  }
}

async function status(): Promise<CaptureStatus> {
  if (starting) return { phase: 'starting', source: starting, tuning: await storedTuning() };
  const current = await audioStatus();
  if (current.phase === 'capturing') return current;
  const tuning = await storedTuning();
  return failure ? { phase: 'error', message: failure, tuning } : { ...current, tuning };
}

async function storedTuning() {
  try { return readTuning((await chrome.storage.local.get(tuningKey))[tuningKey]); }
  catch (error) { console.warn('MoodShift could not load pitch and EQ settings', error); return readTuning(undefined); }
}

async function remember(current: CaptureStatus): Promise<void> {
  if (current.phase === 'capturing') await chrome.storage.session.set({ capture: current.session });
  else await chrome.storage.session.remove('capture');
}

async function stop(sessionId: string): Promise<CaptureStatus> {
  const current = await audioStatus();
  if (current.phase !== 'capturing' || current.session.id !== sessionId) return current;
  const reply = await toAudio({ type: 'STOP', sessionId });
  if (!reply.ok) throw new Error(reply.message);
  await remember(reply.status);
  return reply.status;
}

type AudioEdit = Extract<AudioCommand, { type: 'APPLY_EFFECTS' | 'SET_TUNING' | 'SET_MONITOR' | 'SET_REVERB' }>;
async function updateAudio(message: AudioEdit): Promise<Reply> {
  const reply = await toAudio(message);
  if (reply.ok) {
    try {
      if (reply.status.tuning && (message.type === 'SET_TUNING' || (message.type === 'APPLY_EFFECTS' && message.tuning))) {
        await chrome.storage.local.set({ [tuningKey]: reply.status.tuning });
      }
    } finally { statusChanged(); }
  }
  return reply;
}

const same = (before: unknown, after: unknown) => JSON.stringify(before) === JSON.stringify(after);
type ControlCommand = Extract<WorkerMessage, { type: 'APPLY_CONTROLS' }>;
const staleCommand = 'Settings changed while Gemini was working. Try the command again.';

async function dispatchControls(message: ControlCommand): Promise<Reply> {
  const prepared = await queue(async () => {
    const actions = parseControlActions(message.actions);
    const [capture, display, saved] = await Promise.all([audioStatus(), loadDisplay(), loadControlPresets()]);
    if (capture.phase !== 'capturing' || capture.session.id !== message.sessionId || capture.revision !== message.baseRevision
      || (actions.some(action => isDisplayControl(action.control)) && !same(display, message.expectedDisplay))) throw new Error(staleCommand);
    const before = controlState(capture, display);
    const plan = applyControls(before, actions, saved);
    const patch = Object.fromEntries(effectKeys.filter(key => before.effects[key] !== plan.effects[key]).map(key => [key, plan.effects[key]]));
    const reverbChanged = !same(before.reverb, plan.reverb);
    const pitchChanged = !same(before.tuning.pitch, plan.tuning.pitch);
    const eqChanged = !same(before.tuning.eq, plan.tuning.eq);
    const restartReverbSpeed = actions.some(action => action.control === 'reverb.preset' || action.control === 'preset.saved'
      || (action.control === 'reverb.enabled' && action.value === true));
    const displayPatch = storeDisplay(plan.display, display);
    const anyEffects = Object.keys(patch).length > 0 || reverbChanged || restartReverbSpeed;
    let current = capture;
    if (anyEffects || pitchChanged || eqChanged) {
      const reply = await updateAudio({ type: 'APPLY_EFFECTS', sessionId: message.sessionId, baseRevision: capture.revision, patch,
        ...(pitchChanged || eqChanged ? { tuning: plan.tuning } : {}),
        ...(reverbChanged || restartReverbSpeed ? { reverb: plan.reverb, restartReverbSpeed } : {}),
      });
      if (!reply.ok) throw new Error(reply.message);
      if (reply.status.phase !== 'capturing' || reply.status.session.id !== message.sessionId) throw new Error(staleCommand);
      current = reply.status;
    }
    const displayChanged = Object.keys(displayPatch).length > 0;
    if (displayChanged) await chrome.storage.local.set(displayPatch);
    return { current, plan, pitchChanged, applied: anyEffects || eqChanged || displayChanged };
  });

  let { current, applied } = prepared;
  const { plan, pitchChanged } = prepared;
  const notices: string[] = [];
  const sessionId = message.sessionId;
  if (plan.selectStem && (current.stem.mode !== plan.stemMode || current.stem.phase !== (plan.stemMode === 'full' ? 'idle' : 'active'))) {
    // A stem may buffer for several seconds. Keep the capture queue available to Stop and manual controls.
    const reply = await toAudio({ type: 'SET_STEM', sessionId, mode: plan.stemMode, baseRevision: current.revision });
    if (reply.ok && reply.status.phase === 'capturing' && reply.status.session.id === sessionId) {
      current = reply.status;
      applied = true;
    } else {
      notices.push('The separated mix could not be enabled.');
      if (pitchChanged && current.audioTiming?.pitch.phase === 'starting') {
        const next = await audioStatus();
        if (next.phase === 'capturing' && next.session.id === sessionId && same(next.tuning?.pitch, plan.tuning.pitch)) current = next;
      }
    }
  }
  if (current.monitor !== plan.monitor && !notices.length) {
    const reply = await queue(() => updateAudio({ type: 'SET_MONITOR', sessionId, monitor: plan.monitor, baseRevision: current.revision }));
    if (!reply.ok || reply.status.phase !== 'capturing' || reply.status.session.id !== sessionId) throw new Error(staleCommand);
    current = reply.status;
    applied = true;
  }
  if (pitchChanged && plan.tuning.pitch.enabled && plan.tuning.pitch.semitones !== 0) {
    const until = Date.now() + 4000;
    while (current.audioTiming?.pitch.phase === 'starting' && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const next = await audioStatus();
      if (next.phase !== 'capturing' || next.session.id !== sessionId || !same(next.tuning?.pitch, plan.tuning.pitch)) throw new Error(staleCommand);
      current = next;
    }
    if (current.audioTiming?.pitch.phase === 'active') applied = true;
    else notices.push('Pitch could not start.');
  } else applied ||= pitchChanged;
  if (prepared.applied && plan.reverb.preset === 'slowed' && plan.effects.reverbMix > 0 && current.reverb?.speed.state === 'unavailable') {
    notices.push('Playback slowing is unavailable on this tab.');
  }
  statusChanged();
  return { ok: true, status: current, applied, notices };
}

async function select(source: SourceTab): Promise<void> {
  try {
    failure = undefined;
    const current = await audioStatus();
    if (current.phase === 'capturing' && current.session.tabId === source.tabId && !current.outputPaused) return;
    starting = source;
    statusChanged();
    if (current.phase === 'capturing') await stop(current.session.id);
    await ensureOffscreen();
    const session = { ...source, id: crypto.randomUUID() };
    const tuning = await storedTuning();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: source.tabId });
    const reply = await toAudio({ type: 'START', session, streamId, tuning });
    if (!reply.ok) throw new Error(reply.message);
    await remember(reply.status);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn('MoodShift capture setup failed', detail);
    failure = 'Play audio, then click MoodShift on that tab again. If it still fails, refresh the tab.';
  } finally {
    starting = undefined;
    statusChanged();
  }
}

chrome.action.onClicked.addListener(tab => {
  void chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  if (tab.id === undefined) return;
  const source = { tabId: tab.id, title: tab.title || 'Selected tab', muted: tab.mutedInfo?.muted ?? false,
    platform: platformFor(tab.url) };
  void queue(() => select(source));
});

chrome.tabs.onRemoved.addListener(tabId => {
  void queue(async () => {
    const current = await audioStatus();
    if (current.phase !== 'capturing' || current.session.tabId !== tabId) return;
    await stop(current.session.id);
    statusChanged();
  }).catch(console.error);
});

chrome.tabs.onUpdated.addListener((tabId, { title, mutedInfo, url }, tab) => {
  if (title === undefined && mutedInfo === undefined && url === undefined) return;
  void queue(async () => {
    const current = await audioStatus();
    if (current.phase !== 'capturing' || current.session.tabId !== tabId) return;
    const reply = await toAudio({
      type: 'UPDATE_TAB', sessionId: current.session.id, title, muted: mutedInfo?.muted,
      platform: url || tab.url ? platformFor(url ?? tab.url) : undefined,
    });
    if (reply.ok) {
      await remember(reply.status);
      statusChanged();
    }
  }).catch(console.error);
});

chrome.tabCapture.onStatusChanged.addListener(({ status: captureState, tabId }) => {
  if (captureState !== 'stopped' && captureState !== 'error') return;
  void queue(async () => {
    const current = await audioStatus();
    if (current.phase !== 'capturing' || current.session.tabId !== tabId) return;
    const captures = await chrome.tabCapture.getCapturedTabs();
    // A delayed event from a previous session can arrive after recapturing this tab.
    if (captures.some(capture => capture.tabId === tabId && capture.status === 'active')) return;
    await stop(current.session.id);
    statusChanged();
  }).catch(console.error);
});

chrome.runtime.onMessage.addListener((message: WorkerMessage | StemCodeRequest | {
  target: 'worker'; type: 'AUDIO_ENDED'; sessionId: string;
} | {
  target: 'worker'; type: 'SYNC_REVERB_RATE'; sessionId: string; owner: string; enabled: boolean;
}, sender, sendResponse) => {
  if (message.target !== 'worker') return;
  if (message.type === 'SYNC_REVERB_RATE') {
    if (sender.url !== offscreenUrl || sender.id !== chrome.runtime.id) return;
    void (async () => {
      const stored = await chrome.storage.session.get('capture');
      const capture = stored.capture as { id: string; tabId: number } | undefined;
      if (capture?.id !== message.sessionId) return { state: 'unavailable', message: 'Reverb active. The captured tab changed.' };
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const speed = await Promise.race([
          chrome.tabs.sendMessage(capture.tabId, { type: 'REVERB_PLAYBACK', owner: message.owner, enabled: message.enabled }, { frameId: 0 }),
          new Promise(resolve => { timeout = setTimeout(() => resolve({ state: 'unavailable', message: 'Reverb active. The player did not answer the speed request.' }), 1200); }),
        ]);
        return speed ?? { state: 'unavailable', message: 'Reverb active. Slowing is supported on YouTube only.' };
      } finally { clearTimeout(timeout); }
    })().then(sendResponse, () => sendResponse({ state: 'unavailable', message: 'Reverb active. Slowing is supported on YouTube only.' }));
    return true;
  }
  if (message.type === 'GET_STEM_CODE') {
    if (!usesCloudStems() || sender.id !== chrome.runtime.id || sender.url !== offscreenUrl) {
      sendResponse({ ok: false, message: 'Cloud stem authentication is unavailable.' } satisfies StemCodeReply);
      return;
    }
    void cloudDemoCode().then(
      code => sendResponse(code ? { ok: true, code } : { ok: false, message: 'Cloud stem authentication is unavailable.' }),
      error => sendResponse({ ok: false, message: error instanceof Error ? error.message : 'Could not read the private demo code.' } satisfies StemCodeReply),
    );
    return true;
  }
  if (message.type === 'AUDIO_ENDED') {
    if (sender.url === offscreenUrl) void queue(async () => remember(await audioStatus())).catch(console.error);
    return;
  }
  if (message.type === 'SET_STEM') {
    void toAudio(message).then(sendResponse, () => sendResponse({ ok: false, message: 'Select an audio tab with the MoodShift icon.' }));
    return true;
  }
  if (message.type === 'APPLY_CONTROLS') {
    void dispatchControls(message).then(sendResponse, error => sendResponse({ ok: false, message: String(error.message ?? error) } satisfies Reply));
    return true;
  }
  if (message.type === 'OPEN_VOICE') {
    if (sender.url !== chrome.runtime.getURL('sidepanel.html')) return;
    void openVoice().then(status).then(current => sendResponse({ ok: true, status: current } satisfies Reply),
      () => sendResponse({ ok: false, message: 'Couldn’t open voice commands.' } satisfies Reply));
    return true;
  }
  const operation: Promise<Reply> = message.type === 'GET_STATUS'
    ? status().then(current => ({ ok: true, status: current }))
    : queue(async () => {
      if (message.type === 'STOP') {
        const current = await stop(message.sessionId);
        statusChanged();
        return { ok: true, status: current.phase === 'capturing' ? current : { ...current, tuning: await storedTuning() } };
      }
      if (message.type === 'SET_DISPLAY') {
        const previous = await loadDisplay();
        const patch = storeDisplay(changeDisplay(previous, message.action), previous);
        if (Object.keys(patch).length) await chrome.storage.local.set(patch);
        return { ok: true, status: await status() };
      }
      if (message.type === 'SET_TUNING' && message.sessionId === undefined) {
        const current = await status();
        if (current.phase === 'capturing') return { ok: false, message: 'The selected tab changed. Please try again.' };
        const tuning = changeTuning(current.tuning!, message.edit);
        await chrome.storage.local.set({ [tuningKey]: tuning });
        statusChanged();
        return { ok: true, status: { ...current, tuning } };
      }
      if (message.type !== 'APPLY_EFFECTS' && message.type !== 'SET_MONITOR' && message.type !== 'SET_REVERB'
        && message.type !== 'SET_TUNING') {
        return { ok: false, message: 'Unknown audio command.' };
      }
      if (!await hasOffscreen()) return { ok: false, message: 'Select an audio tab with the MoodShift icon.' };
      return updateAudio(message);
    });
  void operation.then(
    sendResponse,
    error => sendResponse({ ok: false, message: String(error.message ?? error) } satisfies Reply),
  );
  return true;
});
