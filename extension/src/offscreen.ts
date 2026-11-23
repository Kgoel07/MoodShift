import { AudioEngine } from './audio-engine';
import { AudioFeaturesMeter } from './audio-features';
import { StemStream } from './stem-stream';
import { EqSpectrum } from './eq-spectrum';
import { LiveChordAnalyzer } from './live-chord-analysis';
import { liveChordPort, type LiveChordSample } from './shared/chords';
import { playoutDelay } from './playout-timing';
import { deployment } from './shared/deployment';
import { changeTuning, readTuning, validateTuning, type AudioTiming, type TuningSettings } from './shared/tuning';
import { applyPatch, neutralEffects, type AudioEffectState } from './shared/effects';
import { changeReverb, defaultReverb, validateReverb, type ReverbSettings, type ReverbSpeed, type ReverbState } from './shared/reverb';
import { meterChannel, statusChanged, type AudioMessage, type MeterUpdate, type Reply } from './shared/messages';
import { silentFeatures, type AudioFeatures, type CaptureSession, type CaptureStatus, type MonitorMode, type StemStatus } from './shared/types';

interface LiveCapture {
  session: CaptureSession;
  stream: MediaStream;
  context: AudioContext;
  engine?: AudioEngine;
  timer?: ReturnType<typeof setInterval>;
  effects: AudioEffectState;
  revision: number;
  monitor: MonitorMode;
  features: AudioFeatures;
  stem: StemStatus;
  stemStream?: StemStream;
  stemRequest: number;
  reverb: ReverbState;
  tuning: TuningSettings;
  chords?: { analyzer: LiveChordAnalyzer; ports: Set<chrome.runtime.Port>; disconnect: () => void };
  speedOwner?: string;
  speedTimer?: ReturnType<typeof setInterval>;
}

let live: LiveCapture | undefined;
let problem: string | undefined;
let pending: Promise<void> = Promise.resolve();
const meterUpdates = new BroadcastChannel(meterChannel);
const spectrum = new EqSpectrum(() => Boolean(live && !live.session.muted && live.context.state === 'running'));

function removeChordPort(capture: LiveCapture, port: chrome.runtime.Port): void {
  const chords = capture.chords;
  if (!chords) return;
  chords.ports.delete(port);
  if (chords.ports.size) return;
  capture.chords = undefined;
  chords.disconnect();
}

chrome.runtime.onConnect.addListener(port => {
  const capture = live;
  if (!capture?.engine || port.name !== liveChordPort + capture.session.id
    || port.sender?.url !== chrome.runtime.getURL('sidepanel.html')) return;
  if (!capture.chords) {
    const analyzer = new LiveChordAnalyzer(capture.context);
    capture.chords = { analyzer, ports: new Set(), disconnect: capture.engine.tapInput(analyzer.node) };
  }
  capture.chords.ports.add(port);
  port.onDisconnect.addListener(() => removeChordPort(capture, port));
});

function timing(capture: LiveCapture): AudioTiming {
  const { engine, context, stem, monitor, stemStream } = capture;
  const pitch = engine?.pitchPlayback ?? { phase: 'bypass', latencySeconds: 0 } as const;
  const stemSeconds = stem.phase === 'active' && monitor === 'modified' ? stemStream?.playoutDelay ?? deployment.stemDelaySeconds : 0;
  const processingSeconds = stemSeconds + pitch.latencySeconds;
  return { sampleRate: context.sampleRate, pitch, stemSeconds, processingSeconds,
    playoutSeconds: playoutDelay(context.state === 'running', processingSeconds, context.baseLatency, context.outputLatency) };
}

function read(): CaptureStatus {
  if (live) {
    const { session, effects, revision, monitor, features, context, stem, reverb, tuning } = live;
    return { phase: 'capturing', session, effects, revision, monitor, features, stem, reverb, tuning, audioTiming: timing(live),
      outputPaused: context.state !== 'running' };
  }
  return problem ? { phase: 'error', message: problem } : { phase: 'ready' };
}

async function stop(sessionId: string, error?: string): Promise<void> {
  if (live?.session.id !== sessionId) return;
  const { engine, stream, context, timer, stemStream, chords } = live;
  const capture = live;
  live = undefined;
  capture.chords = undefined;
  chords?.disconnect();
  chords?.ports.forEach(port => port.disconnect());
  spectrum.setSource(undefined);
  const restoring = releaseSpeed(capture);
  if (error) console.warn('MoodShift capture ended', error);
  problem = error ? 'Audio stopped. Play the song and click MoodShift to reconnect.' : undefined;
  clearInterval(timer);
  stemStream?.close();
  engine?.disconnect();
  stream.getTracks().forEach(track => track.stop());
  if (context.state !== 'closed') await context.close();
  await restoring;
}

async function releaseSpeed(capture: LiveCapture): Promise<void> {
  clearInterval(capture.speedTimer); capture.speedTimer = undefined;
  const owner = capture.speedOwner; capture.speedOwner = undefined;
  capture.reverb.speed = { state: 'idle' };
  if (owner) await chrome.runtime.sendMessage({ target: 'worker', type: 'SYNC_REVERB_RATE',
    sessionId: capture.session.id, owner, enabled: false }).catch(() => undefined);
}

async function syncSpeed(capture: LiveCapture, restart = false): Promise<void> {
  if (capture.effects.reverbMix === 0 || capture.reverb.preset !== 'slowed') { await releaseSpeed(capture); return; }
  if (restart) await releaseSpeed(capture);
  if (capture.speedOwner) return;
  const owner = capture.speedOwner = crypto.randomUUID();
  const renew = async () => {
    let speed: ReverbSpeed;
    try {
      speed = await chrome.runtime.sendMessage({ target: 'worker', type: 'SYNC_REVERB_RATE',
        sessionId: capture.session.id, owner, enabled: true });
      if (!speed || !['active', 'unavailable'].includes(speed.state)
        || (speed.state === 'active' && (typeof speed.rate !== 'number' || !Number.isFinite(speed.rate) || speed.rate <= 0))) throw new Error('Invalid speed acknowledgment.');
    } catch { speed = { state: 'unavailable', message: 'Reverb active. Playback slowing is unavailable.' }; }
    if (live !== capture || capture.speedOwner !== owner) return;
    capture.reverb.speed = speed;
    if (speed.state !== 'active') { clearInterval(capture.speedTimer); capture.speedTimer = undefined; }
    statusChanged();
  };
  await renew();
  if (live === capture && capture.speedOwner === owner && capture.reverb.speed.state === 'active') {
    capture.speedTimer = setInterval(() => void renew(), 2000);
  }
}

async function applyReverb(capture: LiveCapture, settings: ReverbSettings, effects: AudioEffectState, restart = false): Promise<void> {
  capture.engine!.setReverb(settings);
  capture.engine!.setEffects(effects);
  capture.effects = effects;
  capture.reverb = { ...settings, lastAmount: effects.reverbMix || settings.lastAmount, speed: capture.reverb.speed };
  capture.revision++;
  await syncSpeed(capture, restart);
}

function queue<T>(work: () => Promise<T>): Promise<T> {
  const next = pending.then(work);
  pending = next.then(() => undefined, () => undefined);
  return next;
}

function end(sessionId: string, error?: string): void {
  void queue(async () => {
    if (live?.session.id !== sessionId) return;
    await stop(sessionId, error);
    statusChanged();
    void chrome.runtime.sendMessage({ target: 'worker', type: 'AUDIO_ENDED', sessionId })
      .catch(() => undefined);
  }).catch(console.error);
}

async function start(session: CaptureSession, streamId: string, tuning: TuningSettings): Promise<void> {
  if (live?.session.id === session.id) return;
  if (live) throw new Error('Stop the current source before switching tabs.');
  problem = undefined;
  const constraints = {
    mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
  };
  let stream: MediaStream | undefined;
  let expired = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const media = navigator.mediaDevices.getUserMedia({ audio: constraints as MediaTrackConstraints, video: false });
    stream = await Promise.race([
      media.then(result => {
        if (expired) result.getTracks().forEach(track => track.stop());
        return result;
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          expired = true;
          reject(new Error('Capture timed out. Click MoodShift on the source tab to retry.'));
        }, 4000);
      }),
    ]);
    clearTimeout(timeout);
    const track = stream.getAudioTracks()[0];
    if (track?.readyState !== 'live') throw new Error('The tab did not provide a live audio track.');
    const context = new AudioContext({ latencyHint: 'interactive' });
    const capture: LiveCapture = {
      session, stream, context, effects: { ...neutralEffects }, monitor: 'modified',
      revision: 0, features: silentFeatures, stem: { phase: 'idle', mode: 'full' }, stemRequest: 0,
      reverb: { ...defaultReverb, speed: { state: 'idle' } },
      tuning,
    };
    live = capture;
    live.engine = new AudioEngine(context, stream, () => { if (live === capture) statusChanged(); });
    if (session.muted) live.engine.setMuted(true);
    if (context.state !== 'running') {
      await Promise.race([
        context.resume(),
        new Promise<void>(resolve => { timeout = setTimeout(resolve, 1500); }),
      ]);
    }
    if ((context.state as AudioContextState) !== 'running') {
      throw new Error('Chrome paused audio output. Play the source and click MoodShift on that tab to retry.');
    }
    if (track.readyState !== 'live') throw new Error('Capture ended during startup. Click MoodShift to retry.');
    capture.engine!.setTuning(tuning);
    spectrum.setSource(capture.engine!.equalizerOutput);
    track.addEventListener('ended', () => end(session.id), { once: true });
    context.addEventListener('statechange', () => {
      if (live !== capture) return;
      if (context.state === 'closed') end(session.id, 'Audio output closed. Click MoodShift to retry.');
      else if (context.state !== 'running' && capture.stemStream) {
        resetStem(capture, 'Audio output paused. Select a stem to retry after resuming.');
      } else statusChanged();
    });
    const meter = new AudioFeaturesMeter(live.engine.analyser, context.sampleRate);
    capture.timer = setInterval(() => {
      capture.features = context.state === 'running' ? meter.sample() : silentFeatures;
      const audioTiming = timing(capture);
      meterUpdates.postMessage({ sessionId: session.id, features: capture.features, audioTiming } satisfies MeterUpdate);
      if (capture.chords) {
        const { analyzer, ports } = capture.chords;
        const chord = analyzer.sample(!capture.session.muted && !capture.features.isSilent);
        const capturedAt = (performance.timeOrigin + performance.now()) / 1000 - analyzer.windowCenter;
        for (const port of ports) {
          try { port.postMessage({ chord, capturedAt, outputDelay: audioTiming.playoutSeconds } satisfies LiveChordSample); }
          catch { removeChordPort(capture, port); port.disconnect(); }
        }
      }
    }, 250);
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    const message = error instanceof Error ? error.message : 'Chrome could not capture audio.';
    await stop(session.id, message);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function resetStem(capture: LiveCapture, message?: string): void {
  capture.stemRequest++;
  capture.revision++;
  capture.engine?.setStemActive(false);
  capture.stemStream?.close(message);
  capture.stemStream = undefined;
  capture.stem = message ? { phase: 'unavailable', mode: 'full', message } : { phase: 'idle', mode: 'full' };
  statusChanged();
}

async function selectStem(message: Extract<AudioMessage, { type: 'SET_STEM' }>): Promise<Reply> {
  const capture = live;
  const engine = capture?.engine;
  if (!capture || !engine || capture.session.id !== message.sessionId) {
    return { ok: false, message: 'The selected tab changed.' };
  }
  if (message.baseRevision !== undefined && message.baseRevision !== capture.revision) {
    return { ok: false, message: 'Effects changed while Gemini was interpreting. Submit again.' };
  }
  const mode = message.mode;
  if (mode === 'full') {
    resetStem(capture);
    capture.monitor = 'modified';
    engine.setMonitor('modified');
    return { ok: true, status: read() };
  }
  if (mode !== 'vocals' && mode !== 'instrumental') return { ok: false, message: 'Unsupported stem mode.' };
  if (capture.context.state !== 'running' || capture.session.muted) {
    const detail = 'Resume or unmute the source tab before selecting a stem.';
    resetStem(capture, detail);
    return { ok: false, message: detail };
  }
  if (capture.context.sampleRate !== 44100 && capture.context.sampleRate !== 48000) {
    const detail = `Stems require a 44.1 or 48 kHz audio context. Current rate is ${capture.context.sampleRate} Hz.`;
    resetStem(capture, detail);
    return { ok: false, message: detail };
  }
  const request = ++capture.stemRequest;
  const revision = ++capture.revision;
  if (!capture.stemStream) {
    capture.stem = { phase: 'loading', mode };
    const stream = new StemStream(capture.context, engine, () => {
      if (live === capture && capture.stemStream === stream && capture.stem.phase === 'loading') {
        capture.stem = { phase: 'buffering', mode: capture.stem.mode };
        statusChanged();
      }
    }, detail => {
      if (live === capture && capture.stemStream === stream) resetStem(capture, detail);
    });
    capture.stemStream = stream;
  } else if (capture.stem.phase === 'loading' || capture.stem.phase === 'buffering') {
    capture.stem = { phase: capture.stem.phase, mode };
  }
  statusChanged();
  const stream = capture.stemStream;
  try {
    await stream.ready;
    if (live !== capture || request !== capture.stemRequest) {
      return { ok: false, message: 'Stem selection changed.' };
    }
    if (message.baseRevision !== undefined && revision !== capture.revision) {
      const detail = 'Effects changed while the stem was buffering. Submit again.';
      if (capture.stem.phase !== 'active') resetStem(capture, detail);
      return { ok: false, message: detail };
    }
    stream.select(mode);
    capture.monitor = 'modified';
    engine.setStemActive(true);
    engine.setMonitor('modified');
    await new Promise(resolve => setTimeout(resolve, 60));
    if (live !== capture || request !== capture.stemRequest) return { ok: false, message: 'Stem selection changed.' };
    if (capture.context.state !== 'running') {
      const detail = 'Audio output paused while the stem was activating.';
      resetStem(capture, detail);
      return { ok: false, message: detail };
    }
    capture.stem = { phase: 'active', mode };
    statusChanged();
    return { ok: true, status: read() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Stem output unavailable.' };
  }
}

chrome.runtime.onMessage.addListener((message: AudioMessage, _sender, sendResponse) => {
  if (message.target !== 'audio') return;
  if (message.type === 'SET_STEM') {
    void selectStem(message).then(sendResponse, () => sendResponse({ ok: false, message: 'Stem output unavailable.' }));
    return true;
  }
  void queue(async (): Promise<Reply> => {
    if (message.type === 'START') await start(message.session, message.streamId, readTuning(message.tuning));
    if (message.type === 'STOP') await stop(message.sessionId);
    if (message.type === 'APPLY_EFFECTS' || message.type === 'SET_MONITOR' || message.type === 'UPDATE_TAB'
      || message.type === 'SET_REVERB' || message.type === 'SET_TUNING') {
      const capture = live;
      if (!capture?.engine || capture.session.id !== message.sessionId) {
        return { ok: false, message: 'The selected tab changed. Try again on the current source.' };
      }
      if (message.type === 'SET_TUNING') {
        const tuning = changeTuning(capture.tuning, message.edit);
        capture.tuning = tuning;
        capture.revision++;
        capture.engine.setTuning(tuning);
      } else if (message.type === 'SET_REVERB') {
        const { preset, duration, lastAmount } = capture.reverb;
        const next = changeReverb({ preset, duration, lastAmount }, capture.effects.reverbMix, message.patch);
        await applyReverb(capture, next.settings, applyPatch(capture.effects, { reverbMix: next.mix }), message.patch.preset !== undefined || message.patch.enabled === true);
      } else if (message.type === 'APPLY_EFFECTS') {
        if (message.baseRevision !== undefined && message.baseRevision !== capture.revision) {
          return { ok: false, message: 'Effects changed while Gemini was interpreting. Submit again to use the current settings.' };
        }
        const next = applyPatch(capture.effects, message.patch);
        const { preset, duration, lastAmount } = capture.reverb;
        const settings = message.reverb ? validateReverb(message.reverb) : { preset, duration, lastAmount };
        if (message.tuning) {
          capture.tuning = validateTuning(message.tuning);
          capture.engine.setTuning(capture.tuning);
        }
        await applyReverb(capture, settings, next, message.restartReverbSpeed ?? (message.reverb !== undefined));
      } else if (message.type === 'SET_MONITOR') {
        if (message.baseRevision !== undefined && message.baseRevision !== capture.revision) {
          return { ok: false, message: 'Effects changed before switching the monitor.' };
        }
        if (message.monitor !== 'original' && message.monitor !== 'modified') throw new Error('Invalid monitor mode.');
        if (capture.monitor !== message.monitor) capture.revision++;
        capture.engine.setMonitor(message.monitor);
        capture.monitor = message.monitor;
      } else {
        if (message.title !== undefined) capture.session.title = message.title;
        if (message.platform !== undefined) capture.session.platform = message.platform;
        if (message.muted !== undefined) {
          capture.engine.setMuted(message.muted);
          capture.session.muted = message.muted;
          if (message.muted && capture.stemStream) resetStem(capture, 'Source muted. Select a stem after unmuting.');
        }
      }
    }
    return { ok: true, status: read() };
  }).then(sendResponse, error => sendResponse({ ok: false, message: String(error.message ?? error) }));
  return true;
});
