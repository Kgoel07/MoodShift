import { CommandFeedbackError, runNaturalCommand } from './natural-command';
import { toWorker, type StatusChanged } from './shared/messages';

type SpeechResult = { isFinal: boolean; 0?: { transcript: string } };
interface Recognizer {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

const speechWindow = window as Window & { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer };
const getRecognizer = () => speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
const listen = document.querySelector<HTMLButtonElement>('#voice-listen')!;
const cancel = document.querySelector<HTMLButtonElement>('#voice-cancel')!;
const status = document.querySelector<HTMLElement>('#voice-status')!;
const transcript = document.querySelector<HTMLElement>('#voice-transcript')!;
let source: string | undefined;
let request: AbortController | undefined;
let recognizer: Recognizer | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let speaking = false;
let applying = false;

const speechErrors: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked. Allow it in Chrome and try again.',
  'service-not-allowed': 'Speech recognition is unavailable in this Chrome profile.',
  'audio-capture': 'Chrome couldn’t find a microphone. Connect one and try again.',
  'no-speech': 'I didn’t catch that. Try speaking again.',
  network: 'Chrome’s speech service couldn’t connect. Try again or type your command in MoodShift.',
};

function controls(): void {
  listen.disabled = !source || Boolean(request) || !getRecognizer();
  cancel.hidden = !request || applying;
  status.toggleAttribute('data-listening', speaking);
}

function releaseMicrophone(): void {
  clearTimeout(timer);
  speaking = false;
  const input = recognizer;
  recognizer = undefined;
  if (!input) return;
  input.onstart = input.onspeechend = input.onresult = input.onerror = input.onend = null;
  try { input.abort(); } catch { /* Chrome already ended the microphone session. */ }
}

function end(message?: string): void {
  releaseMicrophone();
  request?.abort();
  request = undefined;
  applying = false;
  if (message) status.textContent = message;
  controls();
}

async function refreshSource(): Promise<void> {
  try {
    const reply = await toWorker({ type: 'GET_STATUS' });
    const next = reply.ok && reply.status.phase === 'capturing' ? reply.status.session.id : undefined;
    if (source !== next && request) end('The playing tab changed. Try again.');
    source = next;
    if (!request && (!transcript.textContent || !source)) {
      status.textContent = !getRecognizer() ? 'Speech recognition is unavailable in this browser.'
        : source ? 'Click Listen, then speak your audio command.' : 'Select a playing tab with the MoodShift icon first.';
    }
  } catch { if (!request) status.textContent = 'Couldn’t connect to MoodShift. Try reopening voice commands.'; }
  controls();
}

async function submit(text: string, current: AbortController, sessionId: string): Promise<void> {
  transcript.textContent = text;
  transcript.hidden = false;
  status.textContent = 'Interpreting…';
  controls();
  try {
    const result = await runNaturalCommand(text, { sessionId, signal: current.signal, applying: () => {
      applying = true;
      status.textContent = 'Applying…';
      controls();
    } });
    if (request === current) end(result.message);
  } catch (error) {
    if (request === current) end(error instanceof CommandFeedbackError ? error.message : 'Couldn’t apply that command. Try again.');
  }
}

listen.addEventListener('click', () => {
  const Speech = getRecognizer();
  if (!Speech || !source || request || document.hidden) return;
  const sessionId = source;
  const current = request = new AbortController();
  transcript.textContent = '';
  transcript.hidden = true;
  status.textContent = 'Starting microphone…';
  controls();
  try {
    const input = recognizer = new Speech();
    input.continuous = false;
    input.interimResults = false;
    input.lang = navigator.language;
    input.onstart = () => {
      if (document.hidden || request !== current) { end('Listening cancelled.'); return; }
      speaking = true;
      status.textContent = '🎙️ Listening…';
      controls();
    };
    input.onspeechend = () => input.stop();
    input.onresult = event => {
      if (recognizer !== input || request !== current) return;
      const result = event.results[event.resultIndex];
      if (!result?.isFinal) return;
      const text = result[0]?.transcript.trim() ?? '';
      releaseMicrophone();
      if (!text || text.length > 500) { end('Try again with a short audio command.'); return; }
      void submit(text, current, sessionId);
    };
    input.onend = () => { if (recognizer === input) end('I didn’t catch that. Try speaking again.'); };
    input.onerror = event => { if (recognizer === input) end(speechErrors[event.error] ?? 'Couldn’t recognize speech. Try again.'); };
    timer = setTimeout(() => end('Listening ended. Try speaking again.'), 15_000);
    input.start();
  } catch { end('Couldn’t start the microphone. Check your Chrome permissions.'); }
});

cancel.addEventListener('click', () => end('Voice command cancelled.'));
document.querySelector('#voice-close')!.addEventListener('click', () => { end(); window.close(); });
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') { if (request) end('Voice command cancelled.'); else window.close(); }
});
window.addEventListener('blur', () => { if (speaking) end('Listening cancelled.'); });
document.addEventListener('visibilitychange', () => { if (document.hidden && request && !applying) end('Voice command cancelled.'); });
window.addEventListener('pagehide', () => end());
chrome.runtime.onMessage.addListener((message: StatusChanged) => {
  if (message.target === 'panel' && message.type === 'STATUS_CHANGED') void refreshSource();
});
void refreshSource();
