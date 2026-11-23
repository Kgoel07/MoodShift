import { statusChanged, toAudio, type Reply, type StemCodeReply, type StemCodeRequest, type WorkerMessage } from './shared/messages';
import type { CaptureStatus, SourceTab } from './shared/types';
import { usesCloudStems } from './shared/deployment';
import { cloudDemoCode } from './api-client';
import { installLyricsLookup } from './lyrics-provider';
import { installChordLookup } from './chords-provider';

installLyricsLookup();
installChordLookup();

const offscreenUrl = chrome.runtime.getURL('offscreen.html');
let creating: Promise<void> | undefined;
let operations: Promise<void> = Promise.resolve();
let starting: SourceTab | undefined;
let failure: string | undefined;

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
  if (starting) return { phase: 'starting', source: starting };
  const current = await audioStatus();
  return failure && current.phase !== 'capturing' ? { phase: 'error', message: failure } : current;
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
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: source.tabId });
    const reply = await toAudio({ type: 'START', session, streamId });
    if (!reply.ok) throw new Error(reply.message);
    await remember(reply.status);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failure = `Capture failed. Play audio and click MoodShift on that tab to retry. ${detail}`;
  } finally {
    starting = undefined;
    statusChanged();
  }
}

chrome.action.onClicked.addListener(tab => {
  void chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  if (tab.id === undefined) return;
  const source = { tabId: tab.id, title: tab.title || 'Selected tab', muted: tab.mutedInfo?.muted ?? false };
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

chrome.tabs.onUpdated.addListener((tabId, { title, mutedInfo }) => {
  if (title === undefined && mutedInfo === undefined) return;
  void queue(async () => {
    const current = await audioStatus();
    if (current.phase !== 'capturing' || current.session.tabId !== tabId) return;
    const reply = await toAudio({
      type: 'UPDATE_TAB', sessionId: current.session.id, title, muted: mutedInfo?.muted,
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
        return await Promise.race([
          chrome.tabs.sendMessage(capture.tabId, { type: 'REVERB_PLAYBACK', owner: message.owner, enabled: message.enabled }, { frameId: 0 }),
          new Promise(resolve => { timeout = setTimeout(() => resolve({ state: 'unavailable', message: 'Reverb active. The player did not answer the speed request.' }), 1200); }),
        ]);
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
  const operation: Promise<Reply> = message.type === 'GET_STATUS'
    ? status().then(current => ({ ok: true, status: current }))
    : queue(async () => {
      if (message.type === 'STOP') {
        const current = await stop(message.sessionId);
        statusChanged();
        return { ok: true, status: current };
      }
      if (message.type !== 'APPLY_EFFECTS' && message.type !== 'SET_MONITOR' && message.type !== 'SET_REVERB') {
        return { ok: false, message: 'Unknown audio command.' };
      }
      if (!await hasOffscreen()) return { ok: false, message: 'Select an audio tab with the MoodShift icon.' };
      const reply = await toAudio(message);
      if (reply.ok) statusChanged();
      return reply;
    });
  void operation.then(
    sendResponse,
    error => sendResponse({ ok: false, message: String(error.message ?? error) } satisfies Reply),
  );
  return true;
});
