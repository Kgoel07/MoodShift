import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { setTimeout as wait } from 'node:timers/promises';

export async function prepareReverb() {
  const dsp = (await build({ entryPoints: ['extension/src/reverb.ts'], bundle: true, format: 'iife',
    globalName: 'ReverbDSP', write: false, target: 'chrome116' })).outputFiles[0].text;
  if (process.env.MOODSHIFT_REVERB_AUDIO) return { dsp, audio: await readFile(process.env.MOODSHIFT_REVERB_AUDIO), mime: 'audio/mpeg' };
  const rate = 16000, length = rate * 40, audio = Buffer.alloc(44 + length * 2);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(rate, 24); audio.writeUInt32LE(rate * 2, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) {
    const t = i / rate, pulse = (t % 1) < 0.35 ? Math.sin(Math.PI * (t % 1) / 0.35) : 0;
    const chord = Math.floor(t / 4) % 2 ? [220, 261.63, 329.63] : [261.63, 329.63, 392];
    const sample = chord.reduce((v, hz) => v + Math.sin(t * Math.PI * hz * 2), 0) * pulse * 0.09;
    audio.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  return { dsp, audio, mime: 'audio/wav' };
}

export async function checkReverb({ send, evaluate, find, attach, until, url, origin, id, sw, read, startStemHelper, stopStemHelper }) {
  const { targetId: tab } = await send('Target.createTarget', { url: url + '/reverb', forTab: true });
  const page = await attach((await find(t => t.url === url + '/reverb', 'reverb local player')).targetId);
  await until(() => evaluate(page, "document.querySelector('audio')?.readyState"), value => value >= 2, 'Local audio loaded');
  const offline = await evaluate(page, `(async () => {
    async function render(preset, duration, amount) {
      const context = new OfflineAudioContext(2, 48000 * 5, 48000);
      const input = context.createGain(), out = context.createGain(); out.connect(context.destination);
      const effect = new ReverbDSP.LocalReverb(context, input, out);
      const source = context.createBufferSource(), impulse = context.createBuffer(2, 48000, 48000);
      for (let channel = 0; channel < 2; channel++) impulse.getChannelData(channel)[24000] = 0.2;
      source.buffer = impulse; source.connect(input); source.start();
      effect.update({preset, duration, lastAmount: amount || 0.28}, amount);
      await new Promise(resolve => setTimeout(resolve, 100));
      const output = (await context.startRendering()).getChannelData(0);
      let tail = 0, late = 0, peak = 0, error = 0;
      for (let i = 0; i < output.length; i++) {
        peak = Math.max(peak, Math.abs(output[i]));
        if (i > 24500) tail += output[i] ** 2;
        if (i > 96000) late += output[i] ** 2;
        error = Math.max(error, Math.abs(output[i] - (i === 24000 ? 0.2 : 0)));
      }
      effect.disconnect(); return { tail, late, peak, error, onset: output[24000] };
    }
    return {dry:await render('dreamy',2.4,0), dreamy:await render('dreamy',2.4,0.28),
      hall:await render('hall',2.8,0.24), slowed:await render('slowed',3.4,0.34),
      short:await render('dreamy',0.4,0.28), long:await render('dreamy',4,0.28)};
  })()`);
  assert.ok(offline.dry.error < 1e-6, 'Disabled reverb must preserve the waveform and direct-path timing');
  for (const name of ['dreamy', 'hall', 'slowed']) {
    assert.ok(offline[name].tail > 0.001 && offline[name].peak < 0.5, name + ' must produce a bounded tail');
  }
  assert.ok(offline.short.late < 1e-10 && offline.long.late > 1e-8, 'Duration must change the measured tail');
  assert.notEqual(offline.hall.tail, offline.dreamy.tail);
  console.log('Chrome OfflineAudioContext reverb measurements:', offline);
  const audio = await attach((await find(t => t.url === origin + '/offscreen.html', 'reverb offscreen')).targetId);
  await evaluate(audio, `window.reverbContexts = []; window.reverbNodes = [];
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(...args) { super(...args); window.reverbContexts.push(this); }
      createConvolver() { const node = super.createConvolver(); window.reverbNodes.push(node);
        const disconnect = node.disconnect.bind(node); node.disconnect = (...args) => { node.testDisconnected = true; return disconnect(...args); }; return node; }
      createMediaStreamSource(stream) { const node = super.createMediaStreamSource(stream); window.reverbInput = node; return node; }
      createDynamicsCompressor() { const node = super.createDynamicsCompressor(); window.reverbLimiter = node; return node; }
    };`);
  await evaluate(page, "document.querySelector('audio').play()");
  await send('Extensions.triggerAction', { id, targetId: tab });
  const state = async () => (await evaluate(sw, read)).status;
  const initial = await until(state, value => value.phase === 'capturing' && value.session.title === 'Reverb local audio' && value.features.rms > 0.001, 'Local file capture');
  await evaluate(audio, `window.reverbInputMeter = window.reverbContexts[0].createAnalyser();
    window.reverbOutputMeter = window.reverbContexts[0].createAnalyser();
    window.reverbInput.connect(window.reverbInputMeter); window.reverbLimiter.connect(window.reverbOutputMeter);
    window.readReverbSignal = () => {
      const rms = analyser => { const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length); };
      return { input: rms(window.reverbInputMeter), output: rms(window.reverbOutputMeter) };
    };`);
  let view = await attach((await find(t => t.url === origin + '/sidepanel.html', 'reverb panel')).targetId);
  const setupPanel = async () => {
    await until(() => evaluate(view, "Boolean(document.querySelector('#settings-tab') && document.querySelector('#reverb-enabled') && !document.querySelector('#reverb-enabled').disabled)"), Boolean, 'Reverb panel ready');
    await evaluate(view, `document.querySelector('#settings-tab').click(); document.querySelector('#audio-effects').open = true; window.reverbRequests = 0;
      window.fetch = () => { window.reverbRequests++; return Promise.reject(new Error('Reverb must be local')); };`);
  };
  await setupPanel();
  const choose = preset => evaluate(view, `(() => { const select = document.querySelector('#reverb-preset'); select.value = '${preset}'; select.dispatchEvent(new Event('change')); })()`);
  assert.equal(await evaluate(audio, 'window.reverbNodes.length'), 0, 'Disabled reverb must not create a convolver');
  for (const [preset, amount, duration] of [['dreamy', 0.28, 2.4], ['hall', 0.24, 2.8], ['slowed', 0.34, 3.4]]) {
    await choose(preset);
    await until(state, value => value.reverb?.preset === preset && value.effects.reverbMix === amount && value.reverb.duration === duration, 'Reverb preset ' + preset);
    await wait(450);
    const current = await state(); assert.equal(current.session.id, initial.session.id); assert.equal(current.stem.mode, 'full');
    await until(() => evaluate(audio, 'readReverbSignal().output'), value => value > 0.00001, 'Processed audio reaches the actual output');
  }
  assert.equal((await state()).reverb.speed.state, 'unavailable');
  assert.match(await evaluate(view, "document.querySelector('#reverb-status').textContent"), /YouTube only/);
  await evaluate(view, `const amount = document.querySelector('#effect-reverbMix'); amount.value = '0.19'; amount.dispatchEvent(new Event('input'));
    const duration = document.querySelector('#reverb-duration'); duration.value = '1.1'; duration.dispatchEvent(new Event('input')); duration.dispatchEvent(new Event('change'));`);
  await until(state, value => value.effects.reverbMix === 0.19 && value.reverb.duration === 1.1, 'Customized reverb');
  await evaluate(view, `document.querySelector('#saved-presets').open = true;
    const name = document.querySelector('#saved-preset-name'); name.value = 'Reverb room'; name.dispatchEvent(new Event('input'));`);
  await until(() => evaluate(view, "document.querySelector('#saved-preset-save').disabled"), value => !value, 'Reverb preset can be saved');
  await evaluate(view, "document.querySelector('#saved-preset-save').click()");
  await until(() => evaluate(view, "document.querySelector('#saved-preset-status').textContent"), value => value === 'Preset saved.', 'Custom reverb saved');
  await choose('hall'); await until(state, value => value.reverb.duration === 2.8 && value.effects.reverbMix === 0.24, 'Temporary hall');
  await until(() => evaluate(view, "document.querySelector('#saved-preset-apply').disabled"), value => !value, 'Reverb preset can be restored');
  await evaluate(view, "document.querySelector('#saved-preset-apply').click()");
  await until(state, value => value.reverb.duration === 1.1 && value.effects.reverbMix === 0.19 && value.reverb.preset === 'slowed', 'Saved custom reverb restored');
  await evaluate(view, "document.querySelector('[data-mode=original]').click()");
  await until(state, value => value.monitor === 'original', 'Original plus reverb');
  assert.equal((await state()).effects.reverbMix, 0.19);
  if (process.env.MOODSHIFT_REVERB_STEMS) {
    await startStemHelper(id);
    for (const mode of ['instrumental', 'vocals', 'full']) {
      await evaluate(view, `document.querySelector('[data-stem=${mode}]').click()`);
      await until(state, value => value.stem.mode === mode && (mode === 'full' || value.stem.phase === 'active'), 'Reverb with stem ' + mode, 48);
      assert.equal((await state()).effects.reverbMix, 0.19); assert.equal((await state()).reverb.duration, 1.1);
      await wait(400);
      await until(() => evaluate(audio, 'readReverbSignal().output'), value => value > 0.00001, 'Audible PCM route ' + mode);
    }
    await stopStemHelper();
    console.log('Reverb with real stem worker/worklet routing passed using half-gain PCM protocol fixture; no AI separation was tested.');
  }
  await evaluate(page, "document.querySelector('audio').currentTime = 2.1");
  await wait(300);
  await evaluate(page, "document.querySelector('audio').pause()");
  await wait(140);
  const pausedSignal = await until(() => evaluate(audio, 'readReverbSignal()'), value => value.input < 0.000001, 'Paused samples reach the captured graph');
  assert.ok(pausedSignal.output > 0.000001,
    'The actual captured-audio pipeline must produce a reverb tail after its source becomes silent: ' + JSON.stringify(pausedSignal));
  console.log('Captured-audio output tail after pause:', pausedSignal);
  await until(state, value => value.features.isSilent, 'Paused local source');
  await evaluate(page, "document.querySelector('audio').play()");
  await until(state, value => value.features.rms > 0.001, 'Resumed local source');
  assert.equal((await state()).reverb.duration, 1.1);
  assert.equal(await evaluate(view, 'window.reverbRequests'), 0);
  const windowId = await evaluate(sw, `chrome.tabs.get(${initial.session.tabId}).then(tab => tab.windowId)`);
  await evaluate(sw, `chrome.sidePanel.close({windowId:${windowId}})`);
  await until(async () => (await send('Target.getTargets')).targetInfos.some(t => t.url === origin + '/sidepanel.html'), present => !present, 'Panel closed');
  await send('Extensions.triggerAction', { id, targetId: tab });
  view = await attach((await find(t => t.url === origin + '/sidepanel.html', 'reopened reverb panel')).targetId);
  await setupPanel();
  await until(() => evaluate(view, "Number(document.querySelector('#reverb-duration').value)"), value => value === 1.1, 'Reverb restored on reopen');
  assert.equal((await state()).session.id, initial.session.id);
  assert.equal(await evaluate(audio, 'window.reverbContexts.length'), 1);
  await evaluate(view, "document.querySelector('#reverb-enabled').click()");
  await until(state, value => value.effects.reverbMix === 0, 'Reverb disabled');
  await wait(450);
  assert.equal(await evaluate(audio, 'window.reverbNodes.every(node => node.testDisconnected)'), true);
  await evaluate(view, "document.querySelector('#stop').click()");
  await until(state, value => value.phase === 'ready', 'Reverb stopped');
  assert.equal(await evaluate(audio, 'window.reverbContexts[0].state'), 'closed');
  console.log('Local audio capture, all reverb presets/controls, Original, pause/resume, panel reopen, disable and Stop passed without Gemini requests.');

  if (process.env.MOODSHIFT_REVERB_YOUTUBE) {
    const youtube = process.env.MOODSHIFT_REVERB_YOUTUBE;
    const { targetId: youtubeTab } = await send('Target.createTarget', { url: youtube, forTab: true });
    const video = await attach((await find(t => t.url === youtube, 'YouTube reverb player')).targetId);
    await until(() => evaluate(video, "document.querySelector('#movie_player video')?.readyState"), value => value >= 2, 'YouTube audio ready', 160);
    await evaluate(video, "const media = document.querySelector('#movie_player video'); media.playbackRate = 1.25; void media.play()");
    await send('Extensions.triggerAction', { id, targetId: youtubeTab });
    const captured = await until(state, value => value.phase === 'capturing' && value.features.rms > 0.001, 'YouTube reverb capture', 80);
    view = await attach((await find(t => t.url === origin + '/sidepanel.html', 'YouTube reverb panel')).targetId);
    await setupPanel(); await choose('slowed');
    if (process.env.MOODSHIFT_UI_TEST) {
      const videoId = new URL(youtube).searchParams.get('v');
      await until(() => evaluate(view, `({ title: document.querySelector('#status').textContent,
        artist: document.querySelector('#track-artist').textContent,
        platform: document.querySelector('#track-platform').textContent,
        image: document.querySelector('#song-artwork').getAttribute('src'),
        loaded: !document.querySelector('#song-artwork').hidden })`),
      track => track.platform === 'YouTube' && track.artist && track.image?.includes(`/${videoId}/`) && track.loaded, 'Current song artwork and artist', 40);
      await evaluate(view, "document.querySelector('#home-tab').click()");
      assert.equal(await evaluate(view, "document.querySelector('#home-lyrics').contains(document.querySelector('#lyrics'))"), true);
      await evaluate(view, "document.querySelector('#settings-tab').click()");
      console.log('Live YouTube metadata, thumbnail loading and Home lyrics placement passed.');
    }
    await until(state, value => value.reverb?.speed.state === 'active', 'Slowed YouTube acknowledgment', 48);
    assert.equal(await evaluate(video, "document.querySelector('#movie_player video').playbackRate"), 1.0625);
    await wait(2400);
    assert.equal(await evaluate(video, "document.querySelector('#movie_player video').playbackRate"), 1.0625);
    const youtubeWindow = await evaluate(sw, `chrome.tabs.get(${captured.session.tabId}).then(tab => tab.windowId)`);
    await evaluate(sw, `chrome.sidePanel.close({windowId:${youtubeWindow}})`);
    await until(async () => (await send('Target.getTargets')).targetInfos.some(t => t.url === origin + '/sidepanel.html'), present => !present, 'Slowed panel closed');
    await wait(2400);
    assert.equal(await evaluate(video, "document.querySelector('#movie_player video').playbackRate"), 1.0625);
    await send('Extensions.triggerAction', { id, targetId: youtubeTab });
    view = await attach((await find(t => t.url === origin + '/sidepanel.html', 'reopened slowed panel')).targetId);
    await setupPanel();
    await choose('hall'); await until(state, value => value.reverb?.speed.state === 'idle', 'Preset restores speed');
    assert.equal(await evaluate(video, "document.querySelector('#movie_player video').playbackRate"), 1.25);
    await choose('slowed'); await until(state, value => value.reverb?.speed.state === 'active', 'Reapply slowed');
    await evaluate(view, "document.querySelector('#reverb-enabled').click()");
    await until(state, value => value.effects.reverbMix === 0, 'Disabled slowed');
    assert.equal(await evaluate(video, "document.querySelector('#movie_player video').playbackRate"), 1.25);
    await choose('slowed'); await until(state, value => value.reverb?.speed.state === 'active', 'Reapply before Stop');
    await evaluate(view, "document.querySelector('#stop').click()"); await until(state, value => value.phase === 'ready', 'YouTube Stop');
    assert.equal(await evaluate(video, "document.querySelector('#movie_player video').playbackRate"), 1.25);
    await send('Extensions.triggerAction', { id, targetId: youtubeTab });
    await until(state, value => value.phase === 'capturing', 'Recaptured YouTube');
    await setupPanel(); await choose('slowed');
    await until(state, value => value.reverb?.speed.state === 'active', 'Slowed before source switch');
    await send('Target.activateTarget', { targetId: tab });
    await send('Extensions.triggerAction', { id, targetId: tab });
    const switched = await until(state, value => value.phase === 'capturing' && value.session.tabId === initial.session.tabId, 'Switched from slowed source');
    assert.equal(await evaluate(video, "document.querySelector('#movie_player video').playbackRate"), 1.25);
    assert.equal(switched.effects.reverbMix, 0);
    await until(() => evaluate(view, "document.querySelector('#status').textContent.includes('Reverb local audio') && !document.querySelector('#stop').disabled"), Boolean, 'Switched panel state');
    assert.equal(await evaluate(view, "document.querySelector('#song-artwork').hidden && !document.querySelector('#song-artwork').hasAttribute('src')"), true);
    await evaluate(view, "document.querySelector('#stop').click()");
    await until(state, value => value.phase === 'ready', 'Switched source stopped');
    assert.ok(captured.features.rms > 0);
    console.log('Real YouTube rate reduction, lease renewal, panel closure, and preset change/disable/Stop/source-switch restoration passed.');
  }
}
