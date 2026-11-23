import { CommandFeedbackError, runNaturalCommand } from './natural-command';
import { toWorker, type StatusChanged } from './shared/messages';
import { voiceMaxBytes, voiceMaxSeconds, voiceMimeTypes } from './shared/voice-audio';

const listen = document.querySelector<HTMLButtonElement>('#voice-listen')!;
const cancel = document.querySelector<HTMLButtonElement>('#voice-cancel')!;
const status = document.querySelector<HTMLElement>('#voice-status')!;
const transcript = document.querySelector<HTMLElement>('#voice-transcript')!;
let source: string | undefined;
let request: AbortController | undefined;
let microphone: MediaStream | undefined;
let recorder: MediaRecorder | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let phase: 'idle' | 'permission' | 'recording' | 'sending' | 'applying' = 'idle';
let refreshId = 0;

function supportedFormat() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== 'function') return;
  return voiceMimeTypes.find(type => MediaRecorder.isTypeSupported(`${type};codecs=opus`));
}

function show(next: typeof phase, message?: string): void {
  phase = next;
  listen.textContent = next === 'recording' ? 'Send command' : '🎙️ Listen';
  listen.disabled = !source || (next !== 'idle' && next !== 'recording') || !supportedFormat();
  cancel.hidden = next === 'idle' || next === 'applying';
  status.toggleAttribute('data-listening', next === 'recording');
  if (message) status.textContent = message;
}

function stopTracks(): void {
  microphone?.getTracks().forEach(track => track.stop());
  microphone = undefined;
}

function end(message?: string): void {
  clearTimeout(timer);
  request?.abort();
  request = undefined;
  if (recorder?.state === 'recording') recorder.stop();
  recorder = undefined;
  stopTracks();
  show('idle', message);
}

async function refreshSource(): Promise<void> {
  const id = ++refreshId;
  try {
    const reply = await toWorker({ type: 'GET_STATUS' });
    if (id !== refreshId) return;
    const next = reply.ok && reply.status.phase === 'capturing' ? reply.status.session.id : undefined;
    const initial = source === undefined;
    if (source !== next && request) end('The playing tab changed. Try again.');
    source = next;
    const message = !supportedFormat() ? 'Microphone recording is unavailable in this browser.'
      : !source ? 'Select a playing tab with the MoodShift icon first.' : initial ? 'Click Listen, then speak your command.' : undefined;
    show(phase, phase === 'idle' ? message : undefined);
  } catch { if (id === refreshId && !request) show('idle', 'Couldn’t connect to MoodShift. Try reopening voice commands.'); }
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function submit(clip: Blob, mimeType: typeof voiceMimeTypes[number], current: AbortController, sessionId: string): Promise<void> {
  try {
    if (!clip.size) { end('No audio was recorded. Try speaking again.'); return; }
    const data = await base64(clip);
    current.signal.throwIfAborted();
    const result = await runNaturalCommand({ mimeType, data }, { sessionId, signal: current.signal,
      applying: () => show('applying', 'Applying…') });
    if (request === current) {
      transcript.textContent = result.transcript ?? '';
      transcript.hidden = !result.transcript;
      end(result.message);
    }
  } catch (error) {
    if (request === current) end(error instanceof CommandFeedbackError ? error.message : 'Couldn’t apply that voice command. Try again.');
  }
}

function sendRecording(): void {
  if (recorder?.state !== 'recording') return;
  clearTimeout(timer);
  show('sending', 'Interpreting…');
  recorder.stop();
}

async function startRecording(sessionId: string, mimeType: typeof voiceMimeTypes[number]): Promise<void> {
  const current = request = new AbortController();
  transcript.textContent = '';
  transcript.hidden = true;
  show('permission', 'Waiting for microphone access…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    if (request !== current || document.hidden) {
      stream.getTracks().forEach(track => track.stop());
      if (request === current) end('Voice command cancelled.');
      return;
    }
    microphone = stream;
    const input = recorder = new MediaRecorder(stream, { mimeType: `${mimeType};codecs=opus`, audioBitsPerSecond: 32_000 });
    const chunks: Blob[] = [];
    let bytes = 0;
    input.ondataavailable = ({ data }) => {
      if (request !== current) return;
      bytes += data.size;
      if (bytes > voiceMaxBytes) end('The recording is too large. Try a shorter command.');
      else if (data.size) chunks.push(data);
    };
    input.onerror = () => { if (request === current) end('Recording failed. Check your microphone and try again.'); };
    input.onstop = () => {
      if (request !== current) return;
      if (phase !== 'sending') { end('The microphone stopped. Try recording again.'); return; }
      recorder = undefined;
      stopTracks();
      void submit(new Blob(chunks, { type: mimeType }), mimeType, current, sessionId);
    };
    input.start(250);
    timer = setTimeout(sendRecording, voiceMaxSeconds * 1000);
    show('recording', '🎙️ Listening…');
  } catch (error) {
    if (request !== current) return;
    end(error instanceof DOMException && error.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow it for this extension in your browser and try again.'
      : error instanceof DOMException && error.name === 'NotFoundError' ? 'Connect a microphone and try again.'
      : 'Couldn’t start recording. Check your browser and system microphone settings.');
  }
}

listen.addEventListener('click', () => {
  if (phase === 'recording') { sendRecording(); return; }
  const format = supportedFormat();
  if (format && source && !request && !document.hidden) void startRecording(source, format);
});
cancel.addEventListener('click', () => end('Voice command cancelled.'));
async function closeTab(): Promise<void> {
  end();
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
  else window.close();
}
document.querySelector('#voice-close')!.addEventListener('click', () => { void closeTab(); });
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') { if (request) end('Voice command cancelled.'); else void closeTab(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && phase === 'recording') end('Voice command cancelled.'); });
window.addEventListener('blur', () => { if (phase === 'recording') end('Voice command cancelled.'); });
window.addEventListener('pagehide', () => end());
chrome.runtime.onMessage.addListener((message: StatusChanged) => {
  if (message.target === 'panel' && message.type === 'STATUS_CHANGED') void refreshSource();
});
void refreshSource();
