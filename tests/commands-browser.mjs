import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';

export function commandFixture() {
  const rate = 16000, count = 12 * rate;
  const wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const t = 2 * Math.PI * i / rate;
    wav.writeInt16LE(Math.round(1500 * (Math.sin(t * 261.63) + Math.sin(t * 329.63) + Math.sin(t * 392))), 44 + 2 * i);
  }
  return (req, res) => {
    if (req.url === '/commands') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<title>Cross-platform player fixture</title><audio controls loop src="/commands.wav">
        <track kind="captions" src="/commands.vtt" srclang="en" label="English"></audio>
        <script>navigator.mediaSession.metadata = new MediaMetadata({ title: 'MoodShift generated triad fixture', artist: 'Fixture Artist', album: 'Local Test' });</script>`);
    } else if (req.url === '/commands.wav') {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
      res.end(wav);
    } else if (req.url === '/commands.vtt') {
      res.setHeader('Content-Type', 'text/vtt; charset=UTF-8');
      res.end('WEBVTT\n\n00:00:00.000 --> 00:00:12.000\nCaption from the playing tab.\n');
    } else return false;
    return true;
  };
}

export async function checkCommands({ send, evaluate, find, attach, until, url, origin, id, sw, read, startStemHelper, stopStemHelper }) {
  const { targetId: tab } = await send('Target.createTarget', { url: url + '/commands', forTab: true });
  const page = await attach((await find(t => t.type === 'page' && t.url === url + '/commands', 'Local player')).targetId);
  await until(() => evaluate(page, "Boolean(document.querySelector('audio'))"), Boolean, 'Local player loaded');
  await evaluate(page, "document.querySelector('audio').play()");
  await send('Extensions.triggerAction', { id, targetId: tab });
  const capture = async () => (await evaluate(sw, read)).status;
  const initial = await until(capture, s => s.phase === 'capturing' && s.session.title === 'Cross-platform player fixture'
    && s.features.rms > 0.001, 'Cross-platform player captured');
  const panel = await attach((await find(t => t.url === origin + '/sidepanel.html', 'Command side panel')).targetId);
  const click = (view, selector) => evaluate(view, `document.querySelector(${JSON.stringify(selector)}).click()`);
  await until(() => evaluate(panel, "document.querySelector('#track-artist')?.textContent"), s => s === 'Fixture Artist', 'Media Session artist in Now Playing');
  assert.equal(await evaluate(panel, "document.querySelector('#status').textContent"), 'MoodShift generated triad fixture');
  await until(() => evaluate(panel, "document.querySelector('#lyrics-viewport').textContent"), text => text.includes('Caption from the playing tab.'),
    'Page caption fallback on a non-YouTube player', 60);
  await click(panel, '#settings-tab');
  await evaluate(panel, "document.querySelector('#chords').open = true");
  await until(() => evaluate(panel, "document.querySelector('#chord-current').textContent"), value => value === 'C', 'C major from actual captured non-YouTube audio');
  assert.match(await evaluate(panel, "document.querySelector('#chords-status').textContent"), /Live chord estimates/);
  console.log('Cross-platform Chrome capture, Media Session metadata, page captions and local C-major detection passed.');

  const change = (view, selector, value) => evaluate(view, `{
    const field = document.querySelector(${JSON.stringify(selector)});
    field.value = ${JSON.stringify(String(value))}; field.dispatchEvent(new Event('change', { bubbles: true }));
  }`);
  const submit = async (text, actions, unsupported = []) => {
    await click(panel, '#home-tab');
    await evaluate(panel, `window.commandFetch ??= window.unmockedFetch ?? window.fetch.bind(window);
      window.fetch = async (url, init) => {
      window.commandRequest = { path: new URL(url).pathname, data: JSON.parse(init.body) };
      const response = await ${actions ? `Response.json(${JSON.stringify({ actions, summary: 'Audio command.', unsupported })})` : 'commandFetch(url, init)'};
      commandRequest.http = response.status;
      return response;
    };`);
    await change(panel, '#prompt', text);
    await evaluate(panel, "document.querySelector('#prompt').dispatchEvent(new Event('input')); document.querySelector('#interpret').requestSubmit()");
    return until(() => evaluate(panel, "document.querySelector('#feedback').textContent"),
      value => value && !['Interpreting…', 'Applying…'].includes(value), 'Text command finished', 75);
  };
  const set = (control, value) => ({ control, operation: 'set', value });
  await change(panel, '#pitch-value', 1);
  await until(capture, s => s.tuning.pitch.semitones === 1 && s.audioTiming.pitch.phase === 'active', 'Manual pitch');
  assert.match(await submit('Lower pitch by 2 and add hall reverb', [
    { control: 'pitch.semitones', operation: 'adjust', value: -2 }, set('reverb.preset', 'hall'), set('reverb.duration', 1.6),
  ]), /^Applied ✓/);
  const request = await evaluate(panel, 'commandRequest');
  assert.equal(request.path, '/api/interpret/v2');
  assert.deepEqual(request.data.controls.tuning.pitch, { enabled: true, semitones: 1 });
  let state = await capture();
  assert.equal(state.tuning.pitch.semitones, -1);
  assert.equal(state.effects.reverbMix, 0.24);
  assert.equal(state.reverb.duration, 1.6);
  assert.equal(await evaluate(page, "document.querySelector('audio').playbackRate"), 1);
  if (process.env.MOODSHIFT_LIVE_COMMAND_TEST) {
    const feedback = await submit('Lower pitch by 2 semitones. Keep all other settings.');
    const http = await evaluate(panel, 'commandRequest.http');
    assert.match(feedback, /^Applied ✓/, `Live Gemini transport HTTP ${http ?? 'no response'} · ${feedback}`);
    state = await capture();
    assert.equal(state.tuning.pitch.semitones, -3);
    assert.equal(state.audioTiming.pitch.phase, 'active');
    assert.equal(state.reverb.duration, 1.6);
    assert.equal(await evaluate(page, "document.querySelector('audio').playbackRate"), 1);
    console.log('Chrome applied a real Gemini response to the active pitch worklet at playback rate 1.0.');
  }

  const shortcuts = await evaluate(sw, 'chrome.commands.getAll()');
  const shortcut = shortcuts.find(command => command.name === 'voice-command');
  assert.ok(shortcut?.shortcut, 'Chrome assigned the voice shortcut');
  assert.equal(await evaluate(sw, 'chrome.commands.onCommand.hasListeners()'), true);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 10, key: 'Y', code: 'KeyY', windowsVirtualKeyCode: 89 }, page);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 10, key: 'Y', code: 'KeyY', windowsVirtualKeyCode: 89 }, page);
  await wait(350);
  const shortcutOpened = (await send('Target.getTargets')).targetInfos.some(t => t.url === origin + '/voice.html');
  if (!shortcutOpened) await click(panel, '#voice-command');
  const voiceTarget = await find(t => t.type === 'page' && t.url === origin + '/voice.html', 'Voice command window');
  const voice = await attach(voiceTarget.targetId);
  await until(() => evaluate(voice, "document.querySelector('#voice-listen')?.disabled === false"), Boolean, 'Voice controls ready');
  console.log(`Chrome registered ${shortcut.shortcut}. ${shortcutOpened ? 'The shortcut opened the tab through CDP.' : 'The side-panel microphone button opened the voice tab.'}`);
  const voiceStatus = () => evaluate(voice, "document.querySelector('#voice-status').textContent");
  const permission = { permission: { name: 'microphone' }, origin };
  const listen = () => click(voice, '#voice-listen');
  await send('Browser.setPermission', { ...permission, setting: 'denied' });
  await listen();
  await until(voiceStatus, text => /Microphone access was blocked/.test(text), 'Native microphone denial');
  await send('Browser.setPermission', { ...permission, setting: 'granted' });
  assert.equal(await evaluate(voice, 'typeof MediaRecorder'), 'function');
  const spokenBasePitch = (await capture()).tuning.pitch.semitones;
  await evaluate(voice, `{
    window.voiceProbe = { streams: [], requests: [] };
    const captureMic = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (!constraints.audio || constraints.video || constraints.audio.mandatory) throw Error('Voice must use mic-only capture');
      const stream = await captureMic(constraints);
      voiceProbe.streams.push(stream);
      return stream;
    };
    window.fetch = async (url, init) => {
      voiceProbe.requests.push({ path: new URL(url).pathname, data: JSON.parse(init.body) });
      if (voiceProbe.pending) return new Promise((resolve, reject) => { voiceProbe.resolve = resolve;
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); });
      return Response.json({ ...voiceProbe.result, transcript: 'Recorded test command.' });
    };
  }`);
  const probe = () => evaluate(voice, "({ starts: voiceProbe.streams.length, active: voiceProbe.streams.some(stream => stream.getTracks().some(track => track.readyState === 'live')), requests: voiceProbe.requests.length })");
  assert.deepEqual(await probe(), { starts: 0, active: false, requests: 0 });
  const start = async () => {
    await listen();
    await until(voiceStatus, text => /Listening/.test(text), 'Microphone recording started');
  };
  await start();
  await click(voice, '#voice-cancel');
  assert.match(await voiceStatus(), /cancelled/);
  await start();
  await evaluate(voice, "window.dispatchEvent(new Event('blur'))");
  assert.match(await voiceStatus(), /cancelled/);
  assert.deepEqual(await probe(), { starts: 2, active: false, requests: 0 });
  const say = async () => {
    await start();
    await wait(380);
    await listen();
  };
  const actions = [set('preset', 'Warm'), set('eq.preset', 'bass'), { ...set('eq.frequency', 4), frequency: 200 },
    { ...set('eq.bandwidth', 2.4), frequency: 200 }, set('pitch.semitones', 3), set('reverb.enabled', false),
    set('home.pitch', true), set('lyrics.follow', false), set('chords.open', false)];
  await evaluate(voice, `voiceProbe.result = ${JSON.stringify({ actions, summary: 'Warm, EQ and pitch applied.', unsupported: [] })}`);
  await say();
  assert.match(await until(voiceStatus, text => /^Applied ✓/.test(text), 'Spoken command applied'), /^Applied/);
  assert.equal((await probe()).active, false);
  assert.equal((await probe()).requests, 1);
  assert.equal(await evaluate(voice, 'voiceProbe.requests[0].path'), '/api/interpret/voice');
  assert.equal(await evaluate(voice, 'voiceProbe.requests[0].data.audio.mimeType'), 'audio/webm');
  const recorded = Buffer.from(await evaluate(voice, 'voiceProbe.requests[0].data.audio.data'), 'base64');
  assert.equal(recorded.readUInt32BE(0), 0x1a45dfa3);
  assert.equal(await evaluate(voice, 'voiceProbe.requests[0].data.controls.tuning.pitch.semitones'), spokenBasePitch);
  state = await capture();
  assert.equal(state.session.id, initial.session.id);
  assert.equal(state.tuning.pitch.semitones, 3);
  assert.equal(state.effects.bassDb, 2);
  assert.equal(state.effects.reverbMix, 0);
  assert.ok(state.tuning.eq.bands.some(band => band.frequency === 200 && band.gain === 4 && band.q === 2.4));
  await until(() => evaluate(panel, `document.querySelector('#home-pitch').contains(document.querySelector('#pitch-control'))
    && !document.querySelector('#lyrics-follow').checked && !document.querySelector('#chords').open`), Boolean, 'Voice updates shared Display controls');
  const revision = state.revision;
  await evaluate(voice, "voiceProbe.result = { actions: [], summary: 'That adjustment is unavailable.', unsupported: ['Isolate drums'] }");
  await say();
  assert.doesNotMatch(await until(voiceStatus, text => text.includes('Unsupported'), 'Unsupported voice response'), /Applied/);
  assert.equal((await capture()).revision, revision);
  await evaluate(voice, 'voiceProbe.pending = true');
  await say();
  await until(probe, p => p.requests === 3, 'Spoken request is awaiting Gemini');
  await click(voice, '#voice-cancel');
  await evaluate(voice, "voiceProbe.resolve(Response.json({ actions:[{ control:'pitch.semitones', operation:'set', value:-5 }], summary:'Lower pitch.', unsupported:[] }))");
  await wait(180);
  assert.equal((await capture()).revision, revision);
  await listen();
  await click(voice, '#voice-close');
  await until(async () => (await send('Target.getTargets')).targetInfos.some(t => t.targetId === voiceTarget.targetId), present => !present, 'Voice window closed while listening');
  assert.equal((await capture()).session.id, initial.session.id);
  assert.equal((await capture()).audioTiming.pitch.phase, 'active');
  console.log('Browser microphone denial and real MediaRecorder capture with a fake device passed, along with cleanup and voice-to-DSP updates using mocked Gemini.');

  if (process.env.MOODSHIFT_REVERB_STEMS) {
    await startStemHelper(id);
    assert.match(await submit('Remove vocals and add reverb', [set('mix', 'instrumental'), set('reverb.preset', 'dreamy')]), /^Applied ✓/);
    state = await capture();
    assert.equal(state.stem.phase, 'active');
    assert.equal(state.stem.mode, 'instrumental');
    assert.equal(state.effects.reverbMix, 0.28);
    assert.equal(state.audioTiming.stemSeconds, 2.8);
    await stopStemHelper();
    console.log('Text commands selected an actual Instrumental worklet route with the local PCM worker and changed reverb.');
  }
  assert.match(await submit('Reset the whole audio mix', [{ control: 'audio.reset', operation: 'reset' }]), /^Applied ✓/);
  state = await capture();
  assert.equal(state.session.id, initial.session.id);
  assert.equal(state.audioTiming.processingSeconds, 0);
  assert.equal(state.stem.mode, 'full');
  assert.equal(state.tuning.eq.bands.length, 6);
  assert.equal(state.tuning.pitch.semitones, 0);
  assert.equal(await evaluate(page, "document.querySelector('audio').playbackRate"), 1);
  await click(panel, '#stop');
  await until(capture, s => s.phase === 'ready', 'Command fixture capture stopped');
  await send('Target.closeTarget', { targetId: tab });
}
