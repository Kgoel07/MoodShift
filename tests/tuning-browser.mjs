import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { build } from 'esbuild';

export async function checkPitchCore({ send, attach, evaluate, until, origin }) {
  const script = (await build({ stdin: { resolveDir: process.cwd(), contents: `
    export { loadStretch, PitchStage } from './extension/src/pitch-stage';
    export { EqualizerStage } from './extension/src/equalizer-stage';
    export { equalizerResponse, effectiveFrequency } from './extension/src/shared/eq-response';
    export { defaultEqualizer } from './extension/src/shared/equalizer';
  ` }, bundle: true, format: 'iife', globalName: 'TuningDSP', write: false, target: 'chrome116' })).outputFiles[0].text;
  const { targetId } = await send('Target.createTarget', { url: origin + '/offscreen.html' });
  const page = await attach(targetId);
  try {
    await until(() => evaluate(page, 'location.href'), url => url === origin + '/offscreen.html', 'Pitch test extension page');
    await evaluate(page, `${script}\nwindow.TuningDSP = TuningDSP;`);
    const { pitch, equalizer, bypassPeakError } = await evaluate(page, `(async () => {
      const { loadStretch, PitchStage, EqualizerStage, equalizerResponse, effectiveFrequency, defaultEqualizer } = TuningDSP;
      const processorUrl = chrome.runtime.getURL('pitch-processor.mjs');
      function dominantFrequency(samples, rate, expected) {
        // Goertzel uses the strongest tone even when the signal has sidebands.
        let bestFrequency = 0, bestEnergy = 0;
        for (let frequency = Math.round(expected) - 5; frequency <= expected + 5; frequency += 0.25) {
          const coefficient = 2 * Math.cos(2 * Math.PI * frequency / rate);
          let previous = 0, current = 0;
          for (let i = rate * 0.6; i < rate * 1.8; i++) {
            const next = samples[i] + coefficient * current - previous;
            previous = current;
            current = next;
          }
          const energy = current ** 2 + previous ** 2 - coefficient * current * previous;
          if (energy > bestEnergy) { bestFrequency = frequency; bestEnergy = energy; }
        }
        return bestFrequency;
      }
      async function render(rate, semitones) {
        const context = new OfflineAudioContext(2, rate * 3, rate);
        const { node, latency } = await loadStretch(context, processorUrl);
        let error = false;
        node.onprocessorerror = () => { error = true; };
        const buffer = context.createBuffer(2, rate * 3, rate);
        [440, 660].forEach((frequency, channel) => {
          const samples = buffer.getChannelData(channel);
          for (let i = rate / 5; i < rate * 2.2; i++) {
            const time = i / rate;
            const envelope = Math.min(1, (time - 0.2) / 0.015, (2.2 - time) / 0.015);
            samples[i] = 0.14 * envelope * Math.sin(2 * Math.PI * frequency * time);
          }
        });
        const source = context.createBufferSource(); source.buffer = buffer;
        source.connect(node).connect(context.destination);
        source.start();
        await node.schedule({ active: true, semitones, formantCompensation: true });
        const output = await context.startRendering();
        node.port.close();
        const measured = [440, 660].map((frequency, channel) => {
          const samples = output.getChannelData(channel);
          let from = -1, through = -1;
          const block = Math.round(rate * 0.005);
          for (let i = 0; i + block < samples.length; i += block) {
            let energy = 0;
            for (let j = i; j < i + block; j++) energy += samples[j] ** 2;
            if (Math.sqrt(energy / block) > 0.042) {
              if (from < 0) from = i / rate;
              through = (i + block) / rate;
            }
          }
          return { frequency: dominantFrequency(samples, rate, frequency * 2 ** (semitones / 12)), onset: from, duration: through - from,
            finite: samples.every(Number.isFinite), peak: samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0) };
        });
        return { rate, semitones, latency, measured, error };
      }

      function compareEq(rate) {
        const context = new OfflineAudioContext(2, 128, rate);
        const frequencies = Float32Array.from({ length: 200 }, (_, i) => 20 * 1000 ** (i / 199));
        const magnitude = new Float32Array(frequencies.length), phase = new Float32Array(frequencies.length);
        const eq = defaultEqualizer();
        const base = eq.bands;
        const configurations = [...base.map(band => [{ ...band, gain: 9, q: 1.8 }]),
          [...base.map(band => ({ ...band, gain: 6 })), { id: 'overlay', frequency: 180, gain: 12, q: 2.85 }]];
        return Math.max(...configurations.map(bands => {
          const predicted = equalizerResponse({ ...eq, bands }, rate);
          const measuredDb = frequencies.map(() => predicted.trimDb);
          for (const band of bands) {
            const filter = new BiquadFilterNode(context, { type: 'peaking', frequency: effectiveFrequency(band.frequency, rate),
              Q: band.q, gain: band.gain });
            filter.getFrequencyResponse(frequencies, magnitude, phase);
            measuredDb.forEach((_, i) => measuredDb[i] += 20 * Math.log10(magnitude[i]));
          }
          return Math.max(...frequencies.map((hz, i) => Math.abs(predicted.gainDb(hz) - measuredDb[i])));
        }));
      }

      async function renderEq(rate) {
        const context = new OfflineAudioContext(1, rate * 0.8, rate);
        const buffer = context.createBuffer(1, rate * 0.8, rate);
        const impulseAt = rate * 0.15;
        buffer.getChannelData(0)[impulseAt] = 0.1;
        const source = context.createBufferSource(); source.buffer = buffer;
        const eq = defaultEqualizer();
        eq.bands.forEach((band, i) => band.gain = i % 2 === 0 ? 5 : -6);
        eq.bands.push({ id: 'overlay', frequency: 70, gain: 11, q: 1.4 });
        const stage = new EqualizerStage(context, source, context.destination);
        stage.update(eq);
        source.start();
        const output = (await context.startRendering()).getChannelData(0);
        const curve = equalizerResponse(eq, rate);
        return Math.max(...eq.bands.map(({ frequency }) => {
          let real = 0, imaginary = 0;
          for (let i = impulseAt; i < output.length; i++) {
            const phase = 2 * Math.PI * frequency * (i - impulseAt) / rate;
            real += output[i] * Math.cos(phase);
            imaginary += output[i] * Math.sin(phase);
          }
          const measured = 20 * Math.log10(Math.hypot(real, imaginary) / 0.1);
          return Math.abs(measured - curve.gainDb(frequency));
        }));
      }

      const context = new OfflineAudioContext(2, 512, 48000);
      const buffer = context.createBuffer(2, 512, 48000);
      buffer.getChannelData(0)[12] = 0.21;
      buffer.getChannelData(1)[164] = -0.37;
      const source = context.createBufferSource(); source.buffer = buffer;
      const between = context.createGain();
      const pitchStage = new PitchStage(context, source, between, processorUrl, () => {});
      const eqStage = new EqualizerStage(context, between, context.destination);
      pitchStage.update({ enabled: true, semitones: 0 });
      eqStage.update(defaultEqualizer());
      source.start();
      const dry = await context.startRendering();
      const bypassPeakError = Math.max(...[0, 1].map(channel => Math.max(...dry.getChannelData(channel)
        .map((sample, i) => Math.abs(sample - buffer.getChannelData(channel)[i])))));
      const pitch = [];
      const equalizer = [];
      for (const rate of [44100, 48000]) {
        equalizer.push({ rate, maxErrorDb: compareEq(rate), renderedErrorDb: await renderEq(rate) });
        for (const semitones of [-3, 3]) pitch.push(await render(rate, semitones));
      }
      return { pitch, equalizer, bypassPeakError };
    })()`);
    console.log('Chrome stereo pitch frequencies, duration, and latency:', JSON.stringify(pitch));
    for (const { semitones, latency, measured, error } of pitch) {
      assert.equal(error, false);
      measured.forEach(({ frequency, onset, duration, finite }, channel) => {
        const expected = [440, 660][channel] * 2 ** (semitones / 12);
        const errorCents = Math.abs(1200 * Math.log2(frequency / expected));
        assert.ok(finite && errorCents < 8, JSON.stringify({ frequency, expected, errorCents }));
        assert.ok(Math.abs(duration - 2) < 0.04, `Signal duration changed: ${duration}`);
        assert.ok(Math.abs(onset - 0.2 - latency) < 0.035, `Observed vs reported pitch latency: ${onset - 0.2} vs ${latency}`);
      });
    }
    assert.equal(bypassPeakError, 0, 'Zero-pitch, zero-gain EQ should be sample-exact');
    console.log('Chrome equalizer maximum response error:', JSON.stringify(equalizer));
    equalizer.forEach(({ maxErrorDb, renderedErrorDb }) => {
      assert.ok(maxErrorDb < 0.05, `Filter response mismatch: ${maxErrorDb} dB`);
      assert.ok(renderedErrorDb < 0.05, `Rendered EQ response mismatch: ${renderedErrorDb} dB`);
    });
  } finally {
    await send('Target.closeTarget', { targetId });
  }
}

export function tuningTone() {
  const rate = 48000;
  const wav = Buffer.alloc(44 + rate * 12 * 4);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < (wav.length - 44) / 4; i++) {
    wav.writeInt16LE(Math.round(4300 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 4);
    wav.writeInt16LE(Math.round(4300 * Math.sin(2 * Math.PI * 660 * i / rate)), 46 + i * 4);
  }
  return wav;
}

export async function checkTuning({ send, attach, evaluate, until, find, url, origin, id, sw, read,
  startStemHelper, stopStemHelper }) {
  const audio = await attach((await find(t => t.url === origin + '/offscreen.html', 'Tuning offscreen')).targetId);
  await evaluate(audio, `{
    const NativeContext = AudioContext, NativeWorklet = AudioWorkletNode;
    window.audioProbe = { contexts: [], pitchNodes: 0, spectrumReads: 0, spectrumPeak: 0 };
    window.AudioContext = class extends NativeContext {
      constructor(...args) { super(...args); audioProbe.contexts.push(this); }
      createDynamicsCompressor() { const node = super.createDynamicsCompressor(); audioProbe.limiter = node; return node; }
    };
    window.AudioWorkletNode = class extends NativeWorklet {
      constructor(context, name, options) {
        super(context, name, options);
        if (options?.channelCountMode === 'explicit' && options?.outputChannelCount?.[0] === 2) audioProbe.pitchNodes++;
      }
    };
    const spectrumRead = AnalyserNode.prototype.getByteFrequencyData;
    AnalyserNode.prototype.getByteFrequencyData = function (levels) {
      spectrumRead.call(this, levels);
      if (this.fftSize === 4096) {
        audioProbe.spectrumReads++;
        audioProbe.spectrumPeak = Math.max(...levels);
      }
    };
  }`);
  const { targetId: tab } = await send('Target.createTarget', { url: url + '/tuning', forTab: true });
  const page = await attach((await find(t => t.type === 'page' && t.url === url + '/tuning', 'Stereo fixture page')).targetId);
  await until(() => evaluate(page, "Boolean(document.querySelector('audio'))"), Boolean, 'Stereo fixture');
  await evaluate(page, "document.querySelector('audio').play()");
  await send('Extensions.triggerAction', { id, targetId: tab });
  const state = async () => (await evaluate(sw, read)).status;
  const initial = await until(state, s => s.phase === 'capturing' && s.session.title === 'Stereo tuning fixture'
    && s.features.rms > 0.001, 'Stereo source capture');
  await evaluate(audio, `{
    const context = audioProbe.contexts.at(-1), stereo = context.createChannelSplitter(2);
    audioProbe.limiter.connect(stereo);
    const meters = [0, 1].map(channel => {
      const analyser = context.createAnalyser(); analyser.fftSize = 8192; analyser.smoothingTimeConstant = 0;
      stereo.connect(analyser, channel); return analyser;
    });
    const wave = new Float32Array(8192), bins = new Float32Array(4096);
    audioProbe.measure = () => meters.map(analyser => {
      analyser.getFloatTimeDomainData(wave);
      analyser.getFloatFrequencyData(bins);
      const peak = bins.reduce((max, level, i) => level > bins[max] ? i : max, 0);
      return { rms: Math.sqrt(wave.reduce((sum, s) => sum + s ** 2, 0) / wave.length),
        hz: peak * context.sampleRate / analyser.fftSize, finite: wave.every(Number.isFinite),
        peak: wave.reduce((max, s) => Math.max(max, Math.abs(s)), 0),
        jump: wave.reduce((max, s, i) => i ? Math.max(max, Math.abs(s - wave[i - 1])) : max, 0) };
    });
  }`);
  const measure = () => evaluate(audio, 'audioProbe.measure()');
  const toneMatches = (signal, semitones) => signal.every(({ rms, hz, finite }, channel) =>
    finite && rms > 0.002 && Math.abs(hz - [440, 660][channel] * 2 ** (semitones / 12)) < 8.5);
  const audible = (signal) => signal.every(({ rms, peak, finite }) => finite && rms > 0.002 && peak < 1);
  async function checkPitchTransition(action) {
    await action();
    for (let i = 0; i < 7; i++) {
      const signal = await measure();
      assert.ok(audible(signal) && signal.every(ch => ch.jump < 0.06), `Pitch transition sample ${i}: ${JSON.stringify(signal)}`);
      await wait(35);
    }
  }
  await until(measure, signal => toneMatches(signal, 0), 'Stereo dry output');
  let panel = await find(t => t.url === origin + '/sidepanel.html', 'Tuning side panel');
  let view = await attach(panel.targetId);
  const click = (target, selector) => evaluate(target, `document.querySelector(${JSON.stringify(selector)}).click()`);
  const change = (target, selector, value) => evaluate(target, `{
    const input = document.querySelector(${JSON.stringify(selector)});
    input.value = ${JSON.stringify(String(value))}; input.dispatchEvent(new Event('change', { bubbles: true }));
  }`);
  await until(() => evaluate(view, "document.querySelector('[data-home-section=pitch]')?.disabled === false"), Boolean, 'Tuning controls available');
  await click(view, '#settings-tab');
  await until(() => evaluate(view, "!document.querySelector('#pitch-control fieldset').disabled"), Boolean, 'Tuning status loaded');
  await click(view, '[data-home-section=pitch]');
  await click(view, '#home-tab');
  assert.equal(await evaluate(view, "document.querySelector('#home-pitch #pitch-value') !== null"), true);
  assert.deepEqual(await evaluate(view, "[...document.querySelectorAll('.preset-emoji')].map(icon => icon.textContent)"), ['🌙', '☀️', '🌊', '🔊']);
  await evaluate(view, `document.querySelector('#pitch-control').open = true;
    document.querySelector('#equalizer').open = true; window.tuningRequests = 0;
    window.fetch = () => { tuningRequests++; return Promise.reject(new Error('Controls should be local')); };`);

  const setPitch = async semitones => {
    await change(view, '#pitch-value', semitones);
    const current = await until(state, s => s.tuning.pitch.semitones === semitones
      && s.audioTiming.pitch.phase === 'active', 'Pitch ACK');
    assert.equal(current.audioTiming.pitch.latencySeconds, 0.1);
    return until(measure, signal => toneMatches(signal, semitones), 'Live shifted stereo frequencies');
  };
  const up = await setPitch(3);
  const down = await setPitch(-3);
  assert.equal(await evaluate(page, "document.querySelector('audio').playbackRate"), 1);
  await wait(220); // Fill the analyser window with the settled shift before measuring bypass.
  await checkPitchTransition(() => click(view, '#pitch-enabled'));
  await until(state, s => !s.tuning.pitch.enabled && s.tuning.pitch.semitones === -3 && s.audioTiming.processingSeconds === 0, 'Pitch bypass preserves value');
  await until(measure, signal => toneMatches(signal, 0), 'Disable returns dry audio');
  await checkPitchTransition(() => click(view, '#pitch-enabled'));
  await until(measure, signal => toneMatches(signal, -3), 'Re-enabled pitch returns the same shift');
  await checkPitchTransition(() => click(view, '#pitch-reset'));
  await until(state, s => s.tuning.pitch.semitones === 0 && s.audioTiming.processingSeconds === 0, 'Reset clears pitch latency');
  await until(measure, signal => toneMatches(signal, 0) && signal.every(ch => ch.jump < 0.04), 'Smooth return to dry stereo');
  console.log('Live captured stereo pitch frequencies:', JSON.stringify({ up: up.map(ch => ch.hz), down: down.map(ch => ch.hz) }));
  await setPitch(3);
  await change(view, '#eq-preset', 'vocal');
  const beforeEditor = await until(state, s => s.tuning.eq.preset === 'vocal', 'Compact EQ preset applied');
  assert.equal(beforeEditor.session.id, initial.session.id);
  assert.equal(beforeEditor.effects.reverbMix, 0);
  await until(measure, signal => toneMatches(signal, 3), 'Pitch + EQ output');

  const openEditor = async () => {
    await click(view, '#open-domain');
    const target = await find(t => t.url === origin + '/domain.html', 'Domain Expansion');
    const editor = await attach(target.targetId);
    await until(() => evaluate(editor, "document.querySelector('#domain-toolbar')?.disabled === false"), Boolean, 'Editor ready');
    return [target, editor];
  };
  let [editorTab, editor] = await openEditor();
  assert.deepEqual((await state()).session, beforeEditor.session);
  assert.equal((await state()).revision, beforeEditor.revision);
  assert.equal(await evaluate(editor, "document.querySelectorAll('[data-eq-point]').length"), 6);
  assert.equal(await evaluate(editor, "document.querySelector('#domain-preset').value"), 'vocal');
  await until(() => evaluate(audio, 'audioProbe.spectrumPeak'), peak => peak > 0, 'Spectrum reads captured audio');
  const countSpectrum = () => evaluate(audio, 'audioProbe.spectrumReads');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, editor);
  await wait(150);
  const reads = await countSpectrum();
  await wait(250);
  assert.equal(await countSpectrum(), reads, 'Reduced motion pauses the live spectrum');
  await send('Emulation.setEmulatedMedia', { features: [] }, editor);
  await until(countSpectrum, count => count > reads, 'Spectrum resumes when motion preference is restored');
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y,
    button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, editor);
  const [x, y] = await evaluate(editor, `(() => {
    const rect = document.querySelector('#domain-canvas').getBoundingClientRect();
    return [rect.x + rect.width * 0.48, rect.y + rect.height * 0.25];
  })()`);
  await mouse('mousePressed', x, y);
  await mouse('mouseReleased', x, y);
  const point = (await until(state, s => s.tuning.eq.bands.length === 7, 'Click graph adds a point')).tuning.eq.bands.at(-1);
  const [px, py] = await until(() => evaluate(editor, `(() => {
    const button = document.querySelector('[data-eq-point="${point.id}"]');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    return document.elementFromPoint(x, y) === button ? [x, y] : null;
  })()`), Boolean, 'Point ready for dragging');
  await mouse('mousePressed', px, py);
  await wait(35);
  await mouse('mouseMoved', px + 38, py + 35);
  await wait(50);
  await mouse('mouseReleased', px + 38, py + 35);
  await until(state, s => s.tuning.eq.bands.at(-1).frequency > point.frequency
    && s.tuning.eq.bands.at(-1).gain < point.gain, 'Drag changes frequency and gain');
  for (const [field, value] of [['frequency', 725], ['gain', -3.4], ['q', 2.73]]) await change(editor, '#point-' + field, value);
  await until(state, s => JSON.stringify(s.tuning.eq.bands.at(-1)) === JSON.stringify({ ...point, frequency: 725, gain: -3.4, q: 2.73 }), 'Precise point edit');
  await change(editor, '#domain-band', 'low-mid');
  await change(editor, '#point-frequency', 510);
  await change(editor, '#point-gain', -6.1);
  await until(() => evaluate(view, `document.querySelector('#eq-band-low-mid').value === '-6.1'
    && document.querySelector('#eq-band-low-mid').getAttribute('aria-label').endsWith('510 Hz')`), Boolean, 'Compact slider follows Domain editor');
  await change(view, '#eq-band-low-mid', -2.2);
  await until(() => evaluate(editor, "document.querySelector('#point-gain').value"), gain => gain === '-2.2', 'Domain point follows compact slider');

  await evaluate(editor, `document.querySelector('.domain-presets').open = true;
    document.querySelector('#preset-name').value = 'Test EQ'; document.querySelector('#eq-preset-form').requestSubmit()`);
  await until(() => evaluate(editor, "document.querySelector('#domain-status').textContent"), status => status === 'Saved Test EQ.', 'Save custom curve');
  const saved = await evaluate(editor, "chrome.storage.local.get('moodshiftEqPresets').then(row => row.moodshiftEqPresets[0])");
  await change(editor, '#domain-band', point.id);
  await click(editor, '#point-delete');
  await until(state, s => s.tuning.eq.bands.length === 6, 'Remove a custom point');
  await change(view, '#eq-preset', 'bright');
  await until(state, s => s.tuning.eq.preset === 'bright', 'Another built-in');
  await change(view, '#eq-preset', saved.id);
  const recalled = await until(state, s => s.tuning.eq.preset === saved.id, 'Recall saved EQ from compact view');
  assert.deepEqual(recalled.tuning.eq.bands, saved.bands);
  await until(() => evaluate(editor, "document.querySelector('#domain-preset').value"), id => id === saved.id, 'Preset synchronized');
  assert.equal(await evaluate(view, 'tuningRequests'), 0);
  if (process.env.MOODSHIFT_TUNING_SCREENSHOTS) {
    const screenshot = async (session, filename, width, height) => {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, session);
      await wait(200);
      assert.equal(await evaluate(session, 'document.documentElement.scrollWidth <= innerWidth'), true);
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, session);
      await writeFile('.moodshift-test/' + filename, Buffer.from(data, 'base64'));
    };
    await screenshot(editor, 'domain.png', 940, 820);
    await evaluate(view, "document.querySelector('#equalizer').scrollIntoView()");
    await screenshot(view, 'compact-eq.png', 320, 780);
  }
  await send('Target.closeTarget', { targetId: editorTab.targetId });
  await wait(150);
  const closedReads = await countSpectrum();
  await wait(180);
  assert.equal(await countSpectrum(), closedReads, 'Spectrum sampling stops with editor closed');
  [editorTab, editor] = await openEditor();
  assert.equal(await evaluate(editor, "document.querySelectorAll('[data-eq-point]').length"), 7);
  assert.equal((await state()).session.id, initial.session.id);
  await send('Target.closeTarget', { targetId: editorTab.targetId });
  console.log('Domain Expansion point editing, live spectrum, compact synchronization and saved EQ passed.');

  const after = (predicate, label) => until(state, predicate, label);
  const command = (type, fields) => evaluate(view,
    'chrome.runtime.sendMessage(' + JSON.stringify({ target: 'worker', type, sessionId: initial.session.id, ...fields }) + ')');
  await click(view, '#settings-tab');
  await click(view, '[data-home-section=equalizer]');
  await click(view, '[data-home-section=pitch]');
  await click(view, '#home-tab');
  assert.equal(await evaluate(view, "document.querySelector('#home-pitch').hidden && document.querySelector('#home-equalizer').hidden"), true);
  await until(measure, signal => toneMatches(signal, 3), 'Hidden controls keep processing');
  await click(view, '#settings-tab');
  assert.equal(await evaluate(view, "document.querySelector('#settings-pitch #pitch-value').value"), '3');
  assert.equal(await evaluate(view, "document.querySelector('#settings-equalizer #eq-preset').value"), saved.id);

  await click(view, '#eq-enabled');
  await after(s => !s.tuning.eq.enabled, 'EQ bypass');
  await change(view, '#reverb-preset', 'dreamy');
  await after(s => s.effects.reverbMix === 0.28 && s.audioTiming.pitch.phase === 'active', 'Pitch + reverb');
  await until(measure, audible, 'Pitch + reverb output');
  await click(view, '#eq-enabled');
  await after(s => s.effects.reverbMix === 0.28 && s.tuning.eq.enabled, 'Pitch + EQ + reverb');
  await until(measure, audible, 'All effects output');
  await click(view, '#pitch-enabled');
  await after(s => s.audioTiming.processingSeconds === 0 && s.effects.reverbMix === 0.28 && s.tuning.eq.enabled, 'EQ + reverb');
  await until(measure, audible, 'EQ + reverb output');

  if (process.env.MOODSHIFT_REVERB_STEMS) {
    await startStemHelper(id);
    await click(view, '#reverb-enabled');
    await click(view, '#pitch-enabled');
    assert.equal((await command('SET_STEM', { mode: 'vocals' })).ok, true);
    const vocals = await until(state, s => s.stem.phase === 'active' && s.stem.mode === 'vocals'
      && s.audioTiming.pitch.phase === 'active', 'Vocals + pitch + EQ', 60);
    assert.equal(vocals.audioTiming.stemSeconds, 2.8);
    assert.ok(Math.abs(vocals.audioTiming.processingSeconds - 2.9) < 1e-9);
    assert.ok(vocals.tuning.eq.enabled && vocals.effects.reverbMix === 0);
    await until(measure, signal => toneMatches(signal, 3), 'Shifted vocal stem output');
    await click(view, '#pitch-enabled');
    await change(view, '#reverb-preset', 'hall');
    assert.equal((await command('SET_STEM', { mode: 'instrumental' })).ok, true);
    const instrumental = await until(state, s => s.stem.phase === 'active' && s.stem.mode === 'instrumental'
      && s.effects.reverbMix === 0.24, 'Instrumental + EQ + reverb', 60);
    assert.equal(instrumental.audioTiming.processingSeconds, 2.8);
    assert.ok(instrumental.tuning.eq.enabled);
    await until(measure, audible, 'Instrumental + EQ + reverb output');
    assert.equal((await command('SET_STEM', { mode: 'full' })).ok, true);
    await stopStemHelper();
    console.log('Vocal and instrumental worklet routes and their 2.8 s buffer passed with the test PCM worker.');
  }
  await click(view, '#reverb-enabled');
  await click(view, '#eq-enabled');
  assert.equal((await command('SET_MONITOR', { monitor: 'original' })).ok, true);
  await after(s => s.monitor === 'original' && s.audioTiming.processingSeconds === 0 && s.effects.reverbMix === 0
    && !s.tuning.eq.enabled, 'Original with effects disabled');
  await until(measure, signal => toneMatches(signal, 0), 'Original stereo output');
  await click(view, '#eq-enabled');
  await click(view, '#pitch-enabled');
  await after(s => s.tuning.pitch.enabled && s.tuning.eq.enabled && s.audioTiming.processingSeconds === 0.1, 'Processing restored');
  await evaluate(page, "document.querySelector('audio').pause()");
  await until(state, s => s.features.isSilent, 'Audio paused');
  await until(measure, signal => signal.every(ch => ch.rms < 0.0001), 'Output silent after pause');
  await evaluate(page, "document.querySelector('audio').play()");
  await until(measure, signal => toneMatches(signal, 3), 'Shifted stereo track after resume');
  const windowId = await evaluate(sw, `chrome.tabs.get(${initial.session.tabId}).then(tab => tab.windowId)`);
  await evaluate(sw, `chrome.sidePanel.close({windowId:${windowId}})`);
  await until(async () => (await send('Target.getTargets')).targetInfos.some(t => t.targetId === panel.targetId),
    present => !present, 'Tuning side panel closed');

  const soak = Number(process.env.MOODSHIFT_TUNING_SOAK ?? 0);
  const start = Date.now();
  const memory = async () => {
    await send('HeapProfiler.collectGarbage', {}, audio);
    return (await send('Runtime.getHeapUsage', {}, audio)).usedSize;
  };
  const startHeap = soak ? await memory() : 0;
  do {
    await until(measure, signal => toneMatches(signal, 3), 'Stand-alone capture retained the pitch shift');
    assert.equal((await state()).session.id, initial.session.id);
    if (Date.now() - start >= soak * 1000) break;
    await wait(Math.min(5000, soak * 1000 - (Date.now() - start)));
  } while (true);
  assert.deepEqual(await evaluate(audio, '[audioProbe.contexts.length, audioProbe.pitchNodes]'), [1, 1]);
  if (soak) console.log(`Closed-panel ${soak} s stereo soak passed. Offscreen JavaScript heap after GC ${startHeap} → ${await memory()} bytes.`);
  await send('Extensions.triggerAction', { id, targetId: tab });
  panel = await find(t => t.url === origin + '/sidepanel.html', 'Reopened tuning side panel');
  view = await attach(panel.targetId);
  await until(() => evaluate(view, "document.querySelector('#pitch-value')?.value"), value => value === '3', 'Pitch persisted on reopen');
  const nextUrl = url + '/?after-tuning';
  const { targetId: nextTab } = await send('Target.createTarget', { url: nextUrl, forTab: true });
  const nextPage = await find(t => t.type === 'page' && t.url === nextUrl, 'New source tab');
  const nextSource = await attach(nextPage.targetId);
  await until(() => evaluate(nextSource, "Boolean(document.querySelector('button'))"), Boolean, 'Second tone ready');
  await evaluate(nextSource, "document.querySelector('button').click(); tone.resume()");
  await send('Target.activateTarget', { targetId: nextPage.targetId });
  assert.equal((await state()).session.id, initial.session.id);
  await send('Extensions.triggerAction', { id, targetId: nextTab });
  const next = await until(state, s => s.phase === 'capturing' && s.session.id !== initial.session.id
    && s.audioTiming.pitch.phase === 'active', 'New captured tab restores tuning');
  assert.equal(next.session.title, 'Test tone');
  assert.deepEqual(next.tuning.eq.bands, saved.bands);
  assert.equal(await evaluate(audio, 'audioProbe.contexts[0].state'), 'closed');
  await click(view, '#stop');
  await after(s => s.phase === 'ready', 'Tuning capture stopped');
  await send('Target.closeTarget', { targetId: tab });
  await send('Target.closeTarget', { targetId: nextPage.targetId });
  console.log('Effect combinations, unchanged media rate, pause/resume, Home/Settings, panel reopening and tab switching passed.');
  return evaluate(view, "chrome.storage.local.get(['moodshiftTuning', 'moodshiftEqPresets', 'moodshiftHomeLayout'])");
}
