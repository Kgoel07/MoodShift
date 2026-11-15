import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rm, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { parse } from 'dotenv';

const testDir = resolve('.moodshift-test');
await mkdir(testDir, { recursive: true });
const profile = await mkdtemp(resolve(testDir, 'profile-'));
const stemTest = Boolean(process.env.MOODSHIFT_STEM_TEST);
const stemYouTube = Boolean(process.env.MOODSHIFT_STEM_YOUTUBE);
const stemPort = process.env.MOODSHIFT_STEM_TEST_PORT;
const localStemsWithCloudApi = process.env.MOODSHIFT_CLOUD_BUILD_TEST === 'loopback';
const cloudBuild = process.env.MOODSHIFT_CLOUD_BUILD_TEST === '1' || localStemsWithCloudApi;
const smokeCode = 'cloud-smoke-placeholder-' + 'x'.repeat(32);
const cloudConfig = cloudBuild ? parse(await readFile(localStemsWithCloudApi ? 'extension/.env.local' : 'extension/.env.example')) : {};
let extensionPath = resolve(localStemsWithCloudApi ? 'extension/dist-cloud' : 'extension/dist');
if (stemPort || (cloudBuild && !localStemsWithCloudApi)) {
  if (stemPort) {
    assert.match(stemPort, /^[1-9][0-9]{3,4}$/);
    assert.ok(!cloudBuild && Number(stemPort) <= 65535 && !['8787', '8788'].includes(stemPort));
  }
  const isolatedPath = resolve(profile, 'isolated-extension');
  const env = { ...process.env, STEM_WS_URL: stemPort ? 'ws://127.0.0.1:' + stemPort : 'wss://stems.example.com/stem',
    API_BASE_URL: cloudBuild ? 'https://api.example.com' : 'http://127.0.0.1:8787' };
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/build-extension.mjs',
    '--mode', cloudBuild ? 'production' : 'development', '--outdir', isolatedPath,
    ...(cloudBuild ? ['--env-file', 'extension/.env.example'] : [])], { stdio: 'inherit', env });
  extensionPath = isolatedPath;
}
const stemFixture = stemTest && !stemYouTube ? await readFile('.stem-gate/assets/fixture.ogg') : undefined;
const playerTest = process.env.MOODSHIFT_PLAYER_TEST === '1';
function captionFixtureAudio() {
  const rate = 8000;
  const samples = rate * 16;
  const wave = Buffer.alloc(44 + 2 * samples);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(rate, 24);
  wave.writeUInt32LE(rate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(samples * 2, 40);
  const frequencies = chords => chords.map(note => 440 * 2 ** ((note - 69) / 12));
  const cMajor = frequencies([48, 52, 55]);
  const aMinor = frequencies([57, 60, 64]);
  for (let i = 0; i < samples; i++) {
    const chord = i < 6 * rate ? cMajor : aMinor;
    const value = chord.reduce((sum, hz) => sum + Math.sin(i * hz * 2 * Math.PI / rate), 0);
    wave.writeInt16LE(Math.round(value * 2500), 44 + 2 * i);
  }
  return wave;
}
const playerAudio = playerTest ? captionFixtureAudio() : undefined;
let helper;
const fixture = createServer((req, res) => {
  if (req.url === '/player.wav' && playerAudio) {
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = Math.min(playerAudio.length - 1, range?.[2] ? Number(range[2]) : playerAudio.length - 1);
    const audio = playerAudio.subarray(start, end + 1);
    res.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length, 'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${playerAudio.length}` } : {}) });
    res.end(audio);
    return;
  }
  if (req.url === '/player' && playerAudio) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<title>MoodShift media fixture</title><audio controls loop src="/player.wav"></audio><script>
      const player = document.querySelector('audio');
      const track = player.addTextTrack('captions', 'Test captions', 'en');
      track.addCue(new VTTCue(0, 4, 'First fixture caption'));
      track.addCue(new VTTCue(6, 9, 'Second fixture caption'));
      track.mode = 'disabled';
      window.setTestSong = title => { navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'Fixture Artist' }); };
    </script>`);
    return;
  }
  if (req.url === '/stems.ogg' && stemFixture) {
    res.writeHead(200, { 'Content-Type': 'audio/ogg' });
    res.end(stemFixture);
    return;
  }
  if (req.url === '/stems') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>Licensed vocal and guitar fixture</title><audio controls src="/stems.ogg"></audio>');
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<title>Test tone</title><button onclick="window.tone = new AudioContext(); const osc = tone.createOscillator(); const gain = tone.createGain(); gain.gain.value = .1; osc.connect(gain).connect(tone.destination); osc.start(); tone.resume()">Play tone</button>');
});
await new Promise((resolve, reject) => fixture.listen(0, '127.0.0.1', resolve).once('error', reject));
const url = 'http://127.0.0.1:' + fixture.address().port;
let lastId = 0;
let data = '';
const requests = new Map();
function launchChrome() {
  const processHandle = spawn(process.env.MOODSHIFT_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--user-data-dir=' + profile,
    '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise(done => {
    processHandle.once('exit', done);
    processHandle.once('error', error => { console.error(error.message); done(); });
  });
  processHandle.stdio[3].on('error', () => undefined);
  processHandle.stderr.on('data', chunk => {
    if (process.env.CHROME_TEST_DEBUG) process.stderr.write(chunk);
  });
  data = '';
  processHandle.stdio[4].on('data', chunk => {
    data += chunk.toString();
    let end;
    while ((end = data.indexOf('\0')) !== -1) {
      const value = JSON.parse(data.slice(0, end));
      data = data.slice(end + 1);
      requests.get(value.id)?.(value);
    }
  });
  return [processHandle, exited];
}
let [chrome, chromeExited] = launchChrome();
async function closeChrome() {
  await send('Browser.close').catch(() => undefined);
  if (!await Promise.race([chromeExited.then(() => true), wait(3000, false)])) chrome.kill();
  await chromeExited;
}
function send(method, params = {}, sessionId) {
  const id = ++lastId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requests.delete(id);
      reject(new Error('CDP timeout: ' + method));
    }, 8000);
    requests.set(id, msg => {
      clearTimeout(timer);
      requests.delete(id);
      if (msg.error) reject(new Error(method + ': ' + msg.error.message));
      else resolve(msg.result);
    });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}
async function find(predicate, label) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const { targetInfos } = await send('Target.getTargets');
    const target = targetInfos.find(predicate);
    if (target) return target;
    await wait(200);
  }
  throw new Error('Missing target: ' + label);
}
async function attach(targetId) {
  return (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
}
async function evaluate(session, expression) {
  const params = { expression, awaitPromise: true, returnByValue: true, userGesture: true };
  let evaluation;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      evaluation = await send('Runtime.evaluate', params, session);
      break;
    } catch (error) {
      if (!error.message.includes('Cannot find default execution context') || attempt === 19) throw error;
      await wait(150);
    }
  }
  const { result, exceptionDetails } = evaluation;
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function until(read, accept, label, attempts = 24) {
  let result;
  for (let attempt = 0; attempt < attempts; attempt++) {
    result = await read();
    if (accept(result)) return result;
    await wait(250);
  }
  throw new Error(label + ': ' + JSON.stringify(result));
}

async function startStemHelper(extensionId) {
  const args = stemPort
    ? ['-c', 'import sys; from scripts import stem_helper as helper; helper.PORT = int(sys.argv.pop(1)); helper.main()', stemPort]
    : ['-m', 'scripts.stem_helper'];
  helper = spawn(process.env.MOODSHIFT_STEM_PYTHON ?? '.stem-gate/venv/Scripts/python.exe',
    [...args, '--extension-id', extensionId, '--device', process.env.MOODSHIFT_STEM_DEVICE ?? '1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let helperLog = '';
  helper.stdout.on('data', data => { helperLog += data.toString(); });
  helper.stderr.on('data', data => { helperLog += data.toString(); });
  helper.on('error', error => { helperLog += error.message; });
  await until(() => {
    if (helper.exitCode !== null) throw new Error('Stem helper exited during startup: ' + helperLog);
    return helperLog;
  }, log => log.includes('helper ready'), 'Stem helper startup', 180);
}

async function stopStemHelper() {
  if (!helper?.pid || helper.exitCode !== null || helper.signalCode !== null) return;
  const exited = new Promise(resolve => helper.once('exit', resolve));
  if (process.platform === 'win32') {
    const task = spawn('taskkill.exe', ['/PID', String(helper.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await new Promise(resolve => {
      task.once('exit', resolve);
      task.once('error', resolve);
    });
  } else helper.kill();
  if (!await Promise.race([exited.then(() => true), wait(3000, false)])) helper.kill();
  helper = undefined;
}

try {
  console.log((await send('Browser.getVersion')).product);
  const { id } = await send('Extensions.loadUnpacked', { path: extensionPath });
  const origin = 'chrome-extension://' + id;
  const worker = await find(t => t.type === 'service_worker' && t.url.startsWith(origin), 'worker');
  let sw = await attach(worker.targetId);
  const { targetId } = await send('Target.createTarget', { url, forTab: true });
  const page = await find(t => t.type === 'page' && t.url === url + '/', 'source page');
  const source = await attach(page.targetId);
  await until(() => evaluate(source, "Boolean(document.querySelector('button'))"), Boolean, 'Tone player');
  await evaluate(source, "document.querySelector('button').click(); tone.resume()");
  await send('Extensions.triggerAction', { id, targetId });
  const read = "chrome.runtime.sendMessage({target:'audio', type:'READ'})";
  const capture = await until(
    () => evaluate(sw, read).catch(() => undefined),
    reply => reply?.status?.features?.rms > 0.03,
    'Local tone did not reach the analyser',
  );
  assert.equal(capture.status.phase, 'capturing');
  assert.equal(capture.status.session.title, 'Test tone');
  if (capture.status.features) {
    assert.ok(capture.status.features.rms > 0.03, 'local tone reached the real analyser');
    const panel = await find(t => t.url === origin + '/sidepanel.html', 'side panel');
    const view = await attach(panel.targetId);
    const selectPanel = name => evaluate(view, `document.querySelector('#${name}-tab').click()`);
    assert.equal(await evaluate(view, "document.querySelector('#advanced-panel').hidden"), true);
    if (cloudBuild) {
      const manifest = await evaluate(view, 'chrome.runtime.getManifest()');
      const stemOrigin = new URL(cloudConfig.STEM_WS_URL).origin;
      assert.ok(manifest.host_permissions.includes(new URL(cloudConfig.API_BASE_URL).origin + '/*'));
      assert.ok(manifest.host_permissions.includes(stemOrigin + '/*'));
      assert.equal(stemOrigin === 'ws://127.0.0.1:8788', localStemsWithCloudApi);
      assert.equal(await evaluate(view, "document.querySelector('#cloud-stem-note').hidden"), localStemsWithCloudApi);
      assert.ok(!manifest.host_permissions.includes('http://127.0.0.1/*'));
      await selectPanel('advanced');
      assert.equal(await evaluate(view, "document.querySelector('#cloud-settings, #supermemory-settings') === null"), true);
      await evaluate(view, `chrome.storage.local.set({ moodshiftDemoAccessCode: ${JSON.stringify(smokeCode)} })`);
      const offscreen = await find(t => t.url === origin + '/offscreen.html', 'offscreen document');
      const audio = await attach(offscreen.targetId);
      assert.equal(await evaluate(audio, 'typeof chrome.storage'), 'undefined');
      const requestCode = "chrome.runtime.sendMessage({target:'worker',type:'GET_STEM_CODE'})";
      assert.equal((await evaluate(view, requestCode)).ok, false);
      const stemCode = await evaluate(audio, requestCode);
      assert.equal(stemCode.ok, !localStemsWithCloudApi);
      if (!localStemsWithCloudApi) assert.equal(stemCode.code, smokeCode);
      console.log(localStemsWithCloudApi ? `Loopback stem build loaded as extension ${id}.` : 'Offscreen cloud authentication passed through the service worker.');
      await selectPanel('home');
    }
    const click = name => evaluate(view, `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(name)}).click()`);
    await click('Dreamy');
    await wait(400);
    assert.match(await evaluate(view, "document.querySelector('#feedback').textContent"), /Applied/);
    const afterDreamy = await evaluate(sw, read);
    assert.equal(afterDreamy.status.effects?.reverbMix, 0.33);
    await evaluate(view, `window.presetLibrary = document.querySelector('#preset-library');
      document.querySelector('#home-tab').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      document.querySelector('#advanced-presets').open = true;`);
    assert.equal(await evaluate(view, `document.activeElement.id === 'advanced-tab'
      && document.querySelector('#home-panel').hidden && !document.querySelector('#advanced-panel').hidden
      && document.querySelector('#advanced-presets').contains(window.presetLibrary)`), true);
    const afterNavigation = (await evaluate(sw, read)).status;
    assert.equal(afterNavigation.session.id, afterDreamy.status.session.id);
    assert.equal(afterNavigation.revision, afterDreamy.status.revision);
    assert.deepEqual(afterNavigation.stem, afterDreamy.status.stem);
    assert.ok(afterNavigation.features.rms > 0.03);
    assert.equal(await evaluate(view, "Number(document.querySelector('#effect-reverbMix').value)"), 0.33);
    await click('Warm');
    await until(async () => (await evaluate(sw, read)).status.effects.bassDb, value => value === 2, 'Advanced preset');
    await selectPanel('home');
    await click('Dreamy');
    await until(async () => (await evaluate(sw, read)).status.effects.bassDb, value => value === 0, 'Home preset');
    await click('Original');
    await wait(350);
    assert.equal((await evaluate(sw, read)).status.monitor, 'original');
    if (process.env.MOODSHIFT_PRESETS_TEST) {
      await evaluate(view, `document.querySelector('#saved-presets').open = true;
        const name = document.querySelector('#saved-preset-name');
        name.value = 'Restart preset'; name.dispatchEvent(new Event('input'));
        document.querySelector('#saved-preset-save').click()`);
      await until(() => evaluate(view, "document.querySelector('#saved-preset-status').textContent"),
        status => status === 'Preset saved.', 'Saving exact preset');
    }
    await click('Modified');
    await click('Reset');
    await wait(350);
    assert.equal((await evaluate(sw, read)).status.effects.reverbMix, 0);
    await selectPanel('advanced');
    await evaluate(view, "const slider = document.querySelector('#effect-bassDb'); slider.value = '3.5'; slider.dispatchEvent(new Event('input')); slider.dispatchEvent(new Event('change'))");
    await wait(350);
    assert.equal((await evaluate(sw, read)).status.effects.bassDb, 3.5);
    assert.ok(await evaluate(view, 'document.documentElement.scrollWidth <= innerWidth'));
    await selectPanel('home');
    if (await evaluate(view, "Boolean(document.querySelector('#interpret'))")) {
      const getFeedback = () => evaluate(view, "document.querySelector('#feedback').textContent");
      const submit = () => evaluate(view, "(() => { const field = document.querySelector('#prompt'); field.value = 'A little more bass'; field.dispatchEvent(new Event('input')); document.querySelector('#interpret').requestSubmit(); })()");
      if (cloudBuild) {
        await evaluate(view, `window.fetch = (url, init) => {
          window.cloudRequest = { url: String(url), authorization: init.headers.Authorization, redirect: init.redirect };
          return Promise.resolve(Response.json({ mode:'unsupported', patch:{}, summary:'Unsupported', unsupported:['test'] }));
        }`);
        await submit();
        await until(getFeedback, text => text.includes('Unsupported'), 'Production API request completed');
        assert.deepEqual(await evaluate(view, 'window.cloudRequest'),
          { url: new URL('/api/interpret', cloudConfig.API_BASE_URL).href, authorization: 'Bearer ' + smokeCode, redirect: 'error' });
        console.log('Production extension loaded with exact host permissions and sent demo authentication only to its configured HTTPS API.');
      }
      await evaluate(view, "window.unmockedFetch = window.fetch.bind(window); window.fetch = () => Promise.reject(new TypeError('Simulated proxy outage'));");
      await submit();
      await wait(400);
      assert.match(await getFeedback(), /Gemini unavailable/);
      assert.doesNotMatch(await getFeedback(), /proxy|npm run|cloud API/i);
      assert.equal((await evaluate(sw, read)).status.effects.bassDb, 3.5);

      await evaluate(view, "window.respond = result => Promise.resolve(Response.json(result)); window.fetch = () => respond({mode:'unsupported',patch:{},summary:'Playback speed is unavailable.',unsupported:['Slow playback']})");
      const revision = (await evaluate(sw, read)).status.revision;
      await submit();
      await wait(200);
      assert.match(await getFeedback(), /Unavailable/);
      assert.doesNotMatch(await getFeedback(), /Applied/);
      assert.equal((await evaluate(sw, read)).status.revision, revision);

      await evaluate(view, "window.fetch = () => respond({mode:'patch',patch:{bassDb:5},summary:'More bass.',unsupported:[]})");
      await submit();
      await wait(300);
      assert.match(await getFeedback(), /^Applied ✓/);
      assert.equal((await evaluate(sw, read)).status.effects.bassDb, 5);

      await evaluate(view, "window.fetch = () => new Promise(resolve => { window.releaseReply = () => resolve(Response.json({mode:'patch',patch:{bassDb:8},summary:'More bass.',unsupported:[]})); })");
      await submit();
      assert.match(await getFeedback(), /Interpreting/);
      const beforeSwitch = (await evaluate(sw, read)).status;
      await selectPanel('advanced');
      assert.match(await getFeedback(), /Interpreting/);
      assert.equal((await evaluate(sw, read)).status.revision, beforeSwitch.revision);
      await click('Warm');
      await wait(300);
      await evaluate(view, 'window.releaseReply()');
      await wait(200);
      assert.equal((await evaluate(sw, read)).status.effects.bassDb, 2);
      const staleRevision = await evaluate(sw, "chrome.runtime.sendMessage({target:'audio',type:'APPLY_EFFECTS',patch:{bassDb:8},sessionId:" + JSON.stringify(capture.status.session.id) + ",baseRevision:" + revision + "})");
      assert.equal(staleRevision.ok, false);
      await selectPanel('home');
      console.log('Gemini failure, unsupported response and stale edit checks passed.');
    }
    if (process.env.MOODSHIFT_MEMORY_TEST) {
      const status = () => evaluate(view, "document.querySelector('#memory-status').textContent");
      const feedback = () => evaluate(view, "document.querySelector('#feedback').textContent");
      const submit = prompt => evaluate(view, `(() => {
        const field = document.querySelector('#prompt');
        field.value = ${JSON.stringify(prompt)};
        field.dispatchEvent(new Event('input'));
        document.querySelector('#interpret').requestSubmit();
      })()`);
      const memory = id => evaluate(view, `document.querySelector('#memory-${id}').click()`);
      await selectPanel('advanced');
      await evaluate(view, `document.querySelector('#personalization').open = true;
        window.memoryCalls = [];
        window.fetch = async (url, options) => {
          if (!url.endsWith('/api/interpret')) throw new Error('Unexpected remote preference request');
          const data = JSON.parse(options.body);
          window.memoryCalls.push(data);
          return Response.json({ mode: 'patch', patch: { bassDb: data.localPreferences ? -6 : -5 }, summary: 'Reduced bass.', unsupported: [] });
        }`);
      assert.equal(await evaluate(view, "document.querySelector('#memory-enabled').checked"), false);
      await memory('enabled');
      await until(status, text => text === 'Personalization enabled.', 'Local personalization enable');
      await selectPanel('home');
      await submit('Remember that I like warmer bass.');
      await until(feedback, text => text === 'Preference saved on this device.', 'Explicit local save prompt');
      await selectPanel('advanced');
      const fill = (suffix, text) => evaluate(view, `(() => {
        const field = document.querySelector('#memory-${suffix}preference');
        field.value = ${JSON.stringify(text)}; field.dispatchEvent(new Event('input'));
        document.querySelector('#memory-${suffix}form').requestSubmit();
      })()`);
      await fill('', 'I like moderate reverb.');
      await until(status, text => text === 'Preference saved on this device.', 'Explicit local form save');
      await evaluate(view, "document.querySelector('#memory-local-list li button').click()");
      await fill('', 'I prefer light reverb.');
      await until(status, text => text === 'Local preference updated.', 'Edit local preference');
      await selectPanel('home');
      await submit('Remove all bass.');
      await until(feedback, text => text.startsWith('Applied ✓'), 'Personalized Gemini ACK');
      const calls = await evaluate(view, 'window.memoryCalls');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].personalization, undefined);
      assert.deepEqual(calls[0].localPreferences, ['I like warmer bass.']);
      assert.equal((await evaluate(sw, read)).status.effects.bassDb, -6);
      await selectPanel('advanced');
      await evaluate(view, "document.querySelector('#memory-local-list li button:nth-child(2)').click()");
      await until(status, text => text === 'Local preference deleted.', 'Delete local preference');
      await memory('enabled');
      await until(status, text => text.startsWith('Personalization disabled.'), 'Local personalization disable');
      await selectPanel('home');
      await submit('Remove all bass.');
      await until(feedback, text => text.startsWith('Applied ✓'), 'Ordinary Gemini ACK');
      assert.equal(await evaluate(view, "!('personalization' in window.memoryCalls.at(-1)) && !('localPreferences' in window.memoryCalls.at(-1))"), true);
      await selectPanel('advanced');
      assert.equal(await evaluate(view, "document.querySelector('#memory-local-list').children.length"), 1);
      await selectPanel('home');
      console.log('Local preference CRUD, Gemini context and opt-out passed.');
    }
    const beforeClose = (await evaluate(sw, read)).status;
    await selectPanel('advanced');
    const windowId = await evaluate(sw, `chrome.tabs.get(${beforeClose.session.tabId}).then(tab => tab.windowId)`);
    await evaluate(sw, `chrome.sidePanel.close({windowId:${windowId}})`);
    await until(async () => (await send('Target.getTargets')).targetInfos.some(t => t.targetId === panel.targetId),
      open => !open, 'Side panel closed');
    const withoutPanel = (await evaluate(sw, read)).status;
    assert.equal(withoutPanel.session.id, beforeClose.session.id);
    assert.equal(withoutPanel.revision, beforeClose.revision);
    assert.ok(withoutPanel.features.rms > 0.03);
    await send('Extensions.triggerAction', { id, targetId });
    const reopened = await attach((await find(t => t.url === origin + '/sidepanel.html', 'reopened side panel')).targetId);
    await until(() => evaluate(reopened, "document.querySelector('#advanced-tab')?.getAttribute('aria-selected')"),
      selected => selected === 'true', 'Advanced selection persisted after reopening');
    await evaluate(reopened, "document.querySelector('#home-tab').click()");
    console.log('Capture continued while the side panel was closed and Advanced selection survived reopening.');
  }
  await send('Extensions.triggerAction', { id, targetId });
  await wait(400);
  assert.equal((await evaluate(sw, read)).status.session.id, capture.status.session.id);
  if (capture.status.features) {
    const second = url + '/?second';
    const secondTab = await send('Target.createTarget', { url: second, forTab: true });
    const secondPage = await find(t => t.url === second, 'second tone tab');
    const secondSession = await attach(secondPage.targetId);
    await until(() => evaluate(secondSession, "Boolean(document.querySelector('button'))"), Boolean, 'Second tone player');
    await evaluate(secondSession, "document.querySelector('button').click(); tone.resume()");
    assert.equal((await evaluate(sw, read)).status.session.id, capture.status.session.id);
    await send('Extensions.triggerAction', { id, targetId: secondTab.targetId });
    const switched = await until(
      async () => (await evaluate(sw, read)).status,
      status => status.session?.id !== capture.status.session.id && status.features?.rms > 0.03,
      'Second tone did not reach the analyser',
    );
    assert.notEqual(switched.session.id, capture.status.session.id);
    assert.ok(switched.features.rms > 0.03);
    assert.equal(switched.effects.bassDb, 0);
    const stale = await evaluate(sw, "chrome.runtime.sendMessage({target:'audio',type:'APPLY_EFFECTS',patch:{bassDb:8},sessionId:" + JSON.stringify(capture.status.session.id) + "})");
    assert.equal(stale.ok, false);
    await send('Target.closeTarget', { targetId: secondPage.targetId });
    await until(async () => (await evaluate(sw, read)).status.phase, phase => phase === 'ready', 'Closed source released capture');
    await send('Extensions.triggerAction', { id, targetId });
  }
  const current = await until(async () => (await evaluate(sw, read)).status,
    state => state.phase === 'capturing' && state.session.title === 'Test tone', 'Reopened tone capture');
  const panel = await find(t => t.url === origin + '/sidepanel.html', 'side panel');
  const view = await attach(panel.targetId);
  await until(() => evaluate(view, "!document.querySelector('#stop').disabled"), Boolean, 'Stop is available');
  await evaluate(view, "document.querySelector('#stop').click()");
  await until(async () => (await evaluate(sw, read)).status.phase, phase => phase === 'ready', 'Stop acknowledged');
  await until(async () => (await evaluate(sw, 'chrome.tabCapture.getCapturedTabs()'))
    .find(tab => tab.tabId === current.session.tabId)?.status, state => state === 'stopped', 'Tab capture released');
  console.log('Local tone, DSP controls, tab switching and Stop checks passed.');
  if (playerTest) {
    const playerUrl = url + '/player';
    const { targetId: tab } = await send('Target.createTarget', { url: playerUrl, forTab: true });
    const page = await attach((await find(t => t.url === playerUrl, 'HTML5 player')).targetId);
    await until(() => evaluate(page, "document.querySelector('audio')?.readyState"), n => n >= 2, 'HTML5 audio loaded');
    assert.equal(await evaluate(page, "document.querySelector('audio').duration"), 16);
    await evaluate(page, "document.querySelector('audio').play()");
    await send('Extensions.triggerAction', { id, targetId: tab });
    const capture = await until(async () => (await evaluate(sw, read).catch(() => undefined))?.status,
      state => state?.phase === 'capturing' && state.session.title === 'MoodShift media fixture'
        && state.features.rms > 0.03, 'HTML5 fixture captured');
    const getView = async () => attach((await find(t => t.url === origin + '/sidepanel.html', 'HTML5 side panel')).targetId);
    let view = await getView();
    const query = selector => evaluate(view, `document.querySelector(${JSON.stringify(selector)})?.textContent`);
    await evaluate(page, "document.querySelector('audio').pause(); document.querySelector('audio').currentTime = 1");
    await until(async () => ({ caption: await query('#lyrics-viewport'), status: await query('#lyrics-status'),
      source: await evaluate(page, `({ bridge: window.moodshiftMediaSessionBridge, position: document.querySelector('audio').currentTime,
        duration: String(document.querySelector('audio').duration),
        mode: document.querySelector('audio').textTracks[0].mode, cues: document.querySelector('audio').textTracks[0].cues?.length })`) }),
    result => result.caption === 'First fixture caption', 'Caption fallback without lyrics');
    assert.match(await query('#lyrics-status'), /Page captions/);
    assert.equal(await evaluate(page, "document.querySelector('audio').textTracks[0].mode"), 'hidden');
    const panelCopy = await evaluate(view, 'document.querySelector("main").textContent');
    assert.doesNotMatch(panelCopy, /other ways to identify|1\.2\s*s\s*timing|playback buffer|transcription engine/i);
    assert.equal(await evaluate(view, 'document.querySelector("#lyrics-sync, #lyrics-source, #stem-buffer") === null'), true);
    await evaluate(page, "document.querySelector('audio').currentTime = 5");
    await until(() => query('#lyrics-viewport'), text => text === 'Second fixture caption', 'Caption changes after paused seek');
    await evaluate(page, "document.querySelector('audio').currentTime = 10");
    await until(() => query('#lyrics-viewport'), text => text === '', 'Caption clears at cue end');
    assert.equal(await evaluate(page, 'window.moodshiftMediaSessionBridge'), true);
    await evaluate(page, "setTestSong('Fixture Track A (Official Audio)')");
    await until(() => query('#current-song'), text => text === 'Fixture Track A · Fixture Artist', 'Main-world Media Session');
    await evaluate(page, "setTestSong('Fixture Track B (Live)')");
    await until(() => query('#current-song'), text => text === 'Fixture Track B (Live) · Fixture Artist', 'Automatic track change');
    assert.equal((await evaluate(sw, read)).status.session.id, capture.session.id);
    const windowId = await evaluate(sw, `chrome.tabs.get(${capture.session.tabId}).then(tab => tab.windowId)`);
    await evaluate(view, `const control = document.querySelector('#lyrics-offset');
      control.value = '0.5'; control.dispatchEvent(new Event('change'))`);
    await until(() => evaluate(view, "chrome.storage.local.get('lyricsManualCorrectionV2').then(x => x.lyricsManualCorrectionV2)"),
      value => value === 0.5, 'Manual correction stored');
    await evaluate(sw, `chrome.sidePanel.close({windowId:${windowId}})`);
    await until(async () => (await send('Target.getTargets')).targetInfos.some(t => t.url === origin + '/sidepanel.html'),
      present => !present, 'Player panel closed');
    await send('Extensions.triggerAction', { id, targetId: tab });
    view = await getView();
    await until(() => evaluate(view, "document.querySelector('#lyrics-offset')?.value"), value => value === '0.5', 'Correction restored');
    assert.equal((await evaluate(sw, read)).status.session.id, capture.session.id);
    await evaluate(view, "document.querySelector('#advanced-tab').click(); document.querySelector('#chords').open = true");
    await evaluate(page, "document.querySelector('audio').currentTime = 1; document.querySelector('audio').play()");
    await until(() => query('#chord-current'), chord => chord === 'C', 'Live C major on the non-YouTube tab');
    assert.match(await query('#chords-status'), /Live chord estimates/);
    assert.equal(await query('#chord-next'), '—');
    await evaluate(view, "document.querySelector('#chord-progression button[aria-current=true]').click()");
    await evaluate(page, "document.querySelector('audio').currentTime = 8");
    await until(() => query('#chord-current'), chord => chord === 'Am', 'Live A minor after seek');
    assert.equal(await query('#chord-diagrams h3'), 'C');
    await evaluate(view, "document.querySelector('#chord-progression button[aria-pressed=true]').click()");
    assert.equal(await query('#chord-diagrams h3'), 'Am');
    assert.equal(await evaluate(view, "!!document.querySelector('#chord-diagrams .chord-piano')"), true);
    assert.match(await query('#chord-progression'), /C.*Am/);
    await evaluate(page, "document.querySelector('audio').pause()");
    await until(() => query('#chord-current'), chord => chord === '—', 'Live chord clears on silence');
    if (stemTest && localStemsWithCloudApi) {
      await evaluate(page, "document.querySelector('audio').currentTime = 1; document.querySelector('audio').play()");
      await until(() => query('#chord-current'), chord => chord === 'C', 'Live chord resumed before stem selection');
      await evaluate(view, "document.querySelector('#advanced-stems').open = true; document.querySelector('[data-stem=instrumental]').click()");
      await until(async () => (await evaluate(sw, read)).status.stem,
        stem => stem?.phase === 'active' && stem.mode === 'instrumental', 'Instrumental active with live chords', 52);
      await evaluate(page, "document.querySelector('audio').currentTime = 8");
      await wait(400);
      assert.equal(await query('#chord-current'), 'C', 'Live chord follows the older buffered audio after seek');
      await until(() => query('#chord-current'), chord => chord === 'Am', 'Live chord advances when the stem reaches the new audio', 40);
      await evaluate(view, "document.querySelector('[data-stem=full]').click()");
      await until(async () => (await evaluate(sw, read)).status.stem?.mode, mode => mode === 'full', 'Returned to full mix');
      console.log('Live chords followed the measured Instrumental buffer across a seek.');
    }
    await evaluate(view, "document.querySelector('#home-tab').click()");
    assert.equal((await evaluate(sw, read)).status.session.id, capture.session.id);
    await evaluate(view, "document.querySelector('#stop').click()");
    await until(async () => (await evaluate(sw, read)).status?.phase, phase => phase === 'ready', 'Player capture stopped');
    console.log('HTML5 playback, Media Session, timed captions, saved correction and live C/Am estimates passed.');
  }
  if (process.env.MOODSHIFT_CHORDS_TEST) {
    const songUrl = 'https://www.youtube.com/watch?v=PqJNc9KVIZE';
    const { targetId: songTab } = await send('Target.createTarget', { url: songUrl, forTab: true });
    const track = await find(t => t.url === songUrl, 'Songle example YouTube tab');
    const song = await attach(track.targetId);
    const readMedia = () => evaluate(song, `(() => {
      const player = document.querySelector('#movie_player');
      return { duration: player?.querySelector('video')?.duration, ad: player?.classList.contains('ad-showing') };
    })()`);
    await until(readMedia, state => state.duration > 260 && state.duration < 285 && !state.ad, 'Songle example YouTube source', 80);
    await evaluate(song, "document.querySelector('#movie_player video').play().catch(() => undefined)");
    await send('Extensions.triggerAction', { id, targetId: songTab });
    const chordsPanel = await attach((await find(t => t.url === origin + '/sidepanel.html', 'chords side panel')).targetId);
    const openChords = () => evaluate(chordsPanel, "document.querySelector('#advanced-tab').click(); document.querySelector('#chords').open = true");
    const readChords = () => evaluate(chordsPanel, `({
      status: document.querySelector('#chords-status').textContent,
      current: document.querySelector('#chord-current').textContent,
      next: document.querySelector('#chord-next').textContent,
      keyboard: Boolean(document.querySelector('.chord-piano')),
      guitar: Boolean(document.querySelector('.chord-guitar')),
    })`);
    await openChords();
    await until(readChords, value => value.status === 'Songle · Estimated chords', 'Live Songle timeline', 40);
    async function seek(position, rate = 1) {
      await evaluate(song, `(() => {
        const video = document.querySelector('#movie_player video');
        video.pause(); video.playbackRate = ${rate}; video.currentTime = ${position};
      })()`);
    }
    const setOffset = offset => evaluate(chordsPanel, `(() => {
      const input = document.querySelector('#lyrics-offset'); input.value = ${JSON.stringify(String(offset))};
      input.dispatchEvent(new Event('change'));
    })()`);
    await setOffset(1.2);
    await seek(13.5);
    await until(readChords, value => value.current === 'Eb' && value.next === 'Eb/Ab' && value.keyboard && value.guitar, 'Diagrams and next chord');
    await seek(17);
    await until(readChords, value => value.current === 'Eb/Ab', 'Forward chord seek');
    await seek(16, 2);
    await setOffset(2.2);
    await until(readChords, value => value.current === 'Eb', 'Rate-adjusted chord offset');
    await setOffset(1.2);
    await seek(13.5);
    await until(readChords, value => value.current === 'Eb', 'Backward chord seek');
    assert.ok(await evaluate(chordsPanel, "chrome.storage.local.get('songleChordCacheV1').then(values => values.songleChordCacheV1?.PqJNc9KVIZE?.result?.events.length > 20)"));
    await evaluate(chordsPanel, "document.querySelector('#stop').click()");
    await until(readChords, value => value.status.startsWith('Select a playing tab'), 'Chord status cleared after Stop');
    console.log('Live Songle timeline, diagrams, pause/seek, playback rate, shared offset, cache and Stop passed on its documented YouTube example.');
  }
  if (process.env.MOODSHIFT_LYRICS_TEST) {
    const songUrl = 'https://www.youtube.com/watch?v=AEBld6I_AKs';
    const { targetId: songTab } = await send('Target.createTarget', { url: songUrl, forTab: true });
    const track = await find(t => t.url === songUrl, 'lyrics YouTube tab');
    const song = await attach(track.targetId);
    const readMedia = () => evaluate(song, `(() => {
      const player = document.querySelector('#movie_player');
      const video = player?.querySelector('video');
      return { duration: video?.duration, ad: player?.classList.contains('ad-showing') };
    })()`);
    const media = await until(readMedia, result => result.duration > 180 && result.duration < 210 && !result.ad,
      'Expected YouTube recording to load', 60);
    await evaluate(song, "document.querySelector('#movie_player video').play().catch(() => undefined)");
    await send('Extensions.triggerAction', { id, targetId: songTab });
    const capture = await until(async () => (await evaluate(sw, read)).status,
      state => state.phase === 'capturing' && state.session.title.includes('Code Monkey'), 'Lyrics capture');
    const lyricsView = async () => attach((await find(t => t.url === origin + '/sidepanel.html', 'lyrics side panel')).targetId);
    let lyricsPanel = await lyricsView();
    const readLyrics = () => evaluate(lyricsPanel, `({
      title: document.querySelector('#lyrics-title')?.value ?? '',
      artist: document.querySelector('#lyrics-artist')?.value ?? '',
      status: document.querySelector('#lyrics-status')?.textContent ?? '',
      count: document.querySelector('#lyrics-viewport')?.childElementCount ?? 0,
    })`);
    const synced = state => state.title === 'Code Monkey' && state.artist === 'Jonathan Coulton'
      && state.status === 'Synchronized lyrics' && state.count > 2;
    await until(readLyrics, synced, 'LRCLIB synchronized result for YouTube duration ' + media.duration, 56);
    const highlighted = () => evaluate(lyricsPanel,
      "Array.from(document.querySelector('#lyrics-viewport').children).findIndex(line => line.hasAttribute('aria-current'))");
    async function seek(position) {
      await evaluate(song, `(() => { const video = document.querySelector('#movie_player video'); video.pause(); video.currentTime = ${position}; })()`);
    }
    await seek(22);
    const firstLine = await until(highlighted, line => line > 4, 'Active lyric at 22 seconds');
    await wait(1000);
    assert.equal(await highlighted(), firstLine);
    await seek(50);
    const secondLine = await until(highlighted, line => line > firstLine, 'Active lyric after forward seek');
    await evaluate(lyricsPanel, "const control = document.querySelector('#lyrics-offset'); control.value = '10'; control.dispatchEvent(new Event('input')); control.dispatchEvent(new Event('change'))");
    await until(highlighted, line => line >= 0 && line < secondLine, 'Offset moves highlight earlier in the song');
    await evaluate(song, "document.querySelector('#movie_player video').playbackRate = 0.5");
    await evaluate(lyricsPanel, "control.value = '0'; control.dispatchEvent(new Event('change'))");
    await until(highlighted, line => line === secondLine, 'Playback-rate and offset changes');

    const windowId = await evaluate(sw, 'chrome.tabs.get(' + capture.session.tabId + ').then(tab => tab.windowId)');
    await evaluate(sw, 'chrome.sidePanel.close({windowId:' + windowId + '})');
    await until(async () => (await send('Target.getTargets')).targetInfos.some(t => t.url === origin + '/sidepanel.html'),
      present => !present, 'Lyrics panel closed');
    await send('Extensions.triggerAction', { id, targetId: songTab });
    lyricsPanel = await lyricsView();
    await until(readLyrics, synced, 'Lyrics restored after panel reopen');
    assert.equal((await evaluate(sw, read)).status.session.id, capture.session.id);
    assert.equal(await highlighted(), secondLine);
    console.log('Live LRCLIB synchronized lyrics, title/artist, pause, seek, playback rate, offset and panel reopen passed.');

    await evaluate(lyricsPanel, "Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Dreamy').click()");
    await until(async () => (await evaluate(sw, read)).status.effects?.reverbMix,
      reverb => reverb === 0.33, 'Audio preset remains available');

    if (process.env.MOODSHIFT_LYRICS_STEMS) {
      await startStemHelper(id);
      await evaluate(song, "document.querySelector('#movie_player video').play().catch(() => undefined)");
      await evaluate(lyricsPanel, "document.querySelector('[data-stem=instrumental]').click()");
      await until(async () => (await evaluate(sw, read)).status.stem?.phase, phase => phase === 'active',
        'Instrumental stem with lyrics', 36);
      assert.ok(await highlighted() >= 0);
      await evaluate(lyricsPanel, "document.querySelector('[data-stem=full]').click()");
      await until(async () => (await evaluate(sw, read)).status.stem?.mode, mode => mode === 'full',
        'Returned to full mix');
      await stopStemHelper();
      console.log('Lyrics and active instrumental stem ran on the same YouTube capture.');
    }

    const beforeNavigation = await evaluate(song, 'performance.timeOrigin');
    const related = JSON.stringify('#related a[href^="/watch?v="]:not([href*="AEBld6I_AKs"])');
    await until(() => evaluate(song, `Boolean(document.querySelector(${related}))`),
      Boolean, 'YouTube watch recommendation');
    await evaluate(song, `document.querySelector(${related}).click()`);
    await until(() => evaluate(song, 'location.href'), url => !url.includes('AEBld6I_AKs'), 'YouTube video changed');
    assert.equal(await evaluate(song, 'performance.timeOrigin'), beforeNavigation);
    await until(async () => ({
      ...(await readLyrics()),
      page: await evaluate(song, `({
        url: location.href, title: document.querySelector('ytd-watch-metadata h1')?.textContent?.trim(),
        videoId: document.querySelector('ytd-watch-flexy')?.getAttribute('video-id'),
        duration: document.querySelector('#movie_player video')?.duration,
        ad: document.querySelector('#movie_player')?.classList.contains('ad-showing'),
      })`),
    }), state => state.title !== 'Code Monkey' && state.title.length > 0,
    'New in-tab song did not replace lyrics metadata', 64);
    assert.equal((await evaluate(sw, read)).status.session.id, capture.session.id);
    console.log('YouTube in-tab navigation replaced the song without restarting capture.');

    await evaluate(lyricsPanel, "document.querySelector('#stop').click()");
    await until(async () => (await evaluate(sw, read)).status.phase, phase => phase === 'ready', 'Lyrics capture stopped');
    await until(readLyrics, state => state.count === 0, 'Lyrics cleared after Stop');
  }
  if (stemTest) {
    const stemUrl = stemYouTube ? 'https://www.youtube.com/watch?v=OEAowPzDnaw' : url + '/stems';
    const stemTitle = stemYouTube ? 'Making Me Nervous' : 'vocal and guitar';
    const { targetId: fixtureTab } = await send('Target.createTarget', { url: stemUrl, forTab: true });
    const fixturePage = await find(t => t.url === stemUrl, 'licensed stem source tab');
    const player = await attach(fixturePage.targetId);
    const media = stemYouTube ? 'video' : 'audio';
    await until(() => evaluate(player, `Boolean(document.querySelector('${media}'))`), Boolean, 'Media element', 48);
    await evaluate(player, `(() => {
      const source = document.querySelector('${media}');
      source.muted = false;
      source.play().catch(() => undefined);
    })()`);
    await send('Extensions.triggerAction', { id, targetId: fixtureTab });
    const capture = await until(
      async () => (await evaluate(sw, read)).status,
      state => state.phase === 'capturing' && state.session.title.includes(stemTitle),
      'Fixture capture unavailable',
    );
    const panel = await find(t => t.url === origin + '/sidepanel.html', 'stem panel');
    const panelView = await attach(panel.targetId);
    const click = async name => {
      const button = `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(name)})`;
      await until(() => evaluate(panelView, `(${button})?.disabled === false`), Boolean, name + ' is available');
      await evaluate(panelView, `(${button}).click()`);
    };
    const feedback = () => evaluate(panelView, "document.querySelector('#feedback').textContent");
    const stemState = async () => (await evaluate(sw, read)).status.stem;
    const submit = async prompt => {
      await evaluate(panelView, `(() => {
        const field = document.querySelector('#prompt');
        field.value = ${JSON.stringify(prompt)};
        field.dispatchEvent(new Event('input'));
      })()`);
      await until(() => evaluate(panelView, "!document.querySelector('#apply').disabled"), Boolean, 'Prompt can submit');
      await evaluate(panelView, "document.querySelector('#interpret').requestSubmit()");
    };
    if (!localStemsWithCloudApi) {
      await click('Instrumental');
      await until(stemState, stem => stem.phase === 'unavailable', 'Missing-helper fallback');
      assert.doesNotMatch(await feedback(), /Applied/);
      await startStemHelper(id);
    }
    const offscreen = await find(t => t.url === origin + '/offscreen.html', 'stem audio document');
    const audio = await attach(offscreen.targetId);
    await evaluate(audio, `(() => {
      const originalConnect = AudioWorkletNode.prototype.connect;
      AudioWorkletNode.prototype.connect = function (...args) {
        const result = originalConnect.apply(this, args);
        if (args[0] instanceof ChannelSplitterNode) {
          window.stemMeters = Array.from({ length: 4 }, (_, index) => {
            const analyser = this.context.createAnalyser();
            args[0].connect(analyser, index, 0);
            return analyser;
          });
        }
        return result;
      };
    })()`);
    await submit('just play instrumental');
    await until(stemState, stem => stem.phase === 'active' && stem.mode === 'instrumental', 'Instrumental did not activate');
    const stemTiming = (await evaluate(sw, read)).status.audioTiming;
    assert.ok(stemTiming.stemSeconds >= 2.79 && stemTiming.seconds >= stemTiming.stemSeconds);
    const powers = await until(() => evaluate(audio, `window.stemMeters?.map(analyser => {
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    })`), rms => rms?.[0] > 0.0001 && rms?.[2] > 0.0001, 'Both actual stems produced PCM');
    assert.notEqual(powers[0], powers[2]);
    await submit('vocals only');
    await until(stemState, stem => stem.phase === 'active' && stem.mode === 'vocals', 'Vocals did not activate');
    const beforeTabs = (await evaluate(sw, read)).status;
    await evaluate(panelView, "document.querySelector('#advanced-tab').click(); document.querySelector('#advanced-stems').open = true");
    assert.equal(await evaluate(panelView, "document.querySelector('#advanced-stems').contains(document.querySelector('[data-stem=vocals][aria-pressed=true]'))"), true);
    await evaluate(panelView, "document.querySelector('#home-tab').click()");
    const afterTabs = (await evaluate(sw, read)).status;
    assert.equal(afterTabs.session.id, beforeTabs.session.id);
    assert.equal(afterTabs.revision, beforeTabs.revision);
    assert.deepEqual(afterTabs.stem, beforeTabs.stem);
    console.log('Active Vocals stem and capture survived Home and Advanced navigation.');
    await click('Original');
    await until(() => evaluate(panelView, "document.querySelector('#stem-status').textContent"),
      value => value === 'Playing the original mix.', 'Original bypass label');
    await until(async () => (await evaluate(sw, read)).status.audioTiming?.stemSeconds,
      seconds => seconds === 0, 'Original removes only the stem delay');
    await click('Modified');
    await until(async () => (await evaluate(sw, read)).status.audioTiming?.stemSeconds,
      seconds => seconds === stemTiming.stemSeconds, 'Modified restores measured stem delay');
    await submit('just play the beat');
    await until(feedback, value => value === 'MoodShift can isolate vocals or play the instrumental mix.', 'Beat-only response');
    assert.equal((await stemState()).mode, 'vocals');
    const realGemini = Boolean(process.env.MOODSHIFT_STEM_GEMINI);
    if (realGemini) {
      await evaluate(panelView, 'if (window.unmockedFetch) window.fetch = window.unmockedFetch');
    } else {
      await evaluate(panelView, `window.fetch = () => Promise.resolve(Response.json({
        mode: 'patch', patch: { reverbMix: 0.28 }, stemMode: 'instrumental',
        summary: 'Instrumental with more reverb.', unsupported: [],
      }))`);
    }
    await submit('remove vocals and add more reverb');
    await until(stemState, stem => stem.phase === 'active' && stem.mode === 'instrumental', 'Combined request', 72);
    const combined = (await evaluate(sw, read)).status;
    if (realGemini) assert.ok(combined.effects.reverbMix > capture.effects.reverbMix);
    else assert.equal(combined.effects.reverbMix, 0.28);
    assert.equal(combined.effects.bassDb, capture.effects.bassDb);
    if (realGemini) console.log('Live Gemini prompt applied the instrumental stem and reverb in Chrome.');
    if (stemYouTube) console.log('Real YouTube tab produced both stem signals:', powers);
    if (process.env.MOODSHIFT_PRESETS_TEST) {
      const presetStatus = () => evaluate(panelView, "document.querySelector('#saved-preset-status').textContent");
      await evaluate(panelView, `(() => {
        document.querySelector('#saved-presets').open = true;
        const name = document.querySelector('#saved-preset-name');
        name.value = 'Instrumental preset'; name.dispatchEvent(new Event('input'));
        document.querySelector('#saved-preset-save').click();
      })()`);
      await until(presetStatus, status => status === 'Preset saved.', 'Save active Instrumental');
      await click('Full mix');
      await until(stemState, stem => stem.mode === 'full', 'Full mix before restore');
      await click('Reset');
      await until(() => evaluate(panelView, "!document.querySelector('#saved-preset-apply').disabled"),
        Boolean, 'Saved preset ready after reset');
      await evaluate(panelView, "document.querySelector('#saved-preset-apply').click()");
      await until(presetStatus, status => status === 'Applied ✓ · Instrumental preset', 'Restore requested Instrumental');
      const restored = (await evaluate(sw, read)).status;
      assert.deepEqual(restored.effects, combined.effects);
      assert.equal(restored.stem.mode, 'instrumental');
      assert.equal(restored.monitor, combined.monitor);
      console.log('Saved preset restored exact live DSP settings and active Instrumental.');
    }
    if (process.env.MOODSHIFT_STEM_SUSTAIN) {
      const position = () => evaluate(player, `document.querySelector('${media}').currentTime`);
      const start = await position();
      for (let second = 0; second < 120; second++) {
        await wait(1000);
        assert.equal((await stemState()).phase, 'active', 'Stem stream survived second ' + second);
      }
      const advanced = await position() - start;
      assert.ok(advanced > 115, `Two-minute run advanced the media playhead by ${advanced.toFixed(1)} s`);
      console.log('Real stem stream remained active through two minutes of advancing playback:', advanced.toFixed(1), 's.');
    }
    await evaluate(player, `document.querySelector('${media}').pause()`);
    await wait(3250);
    const pausedStem = await stemState();
    assert.equal(pausedStem.phase, 'active', `Paused PCM remains in sequence: ${JSON.stringify(pausedStem)}`);
    await evaluate(player, `document.querySelector('${media}').play()`);
    await send('Target.activateTarget', { targetId: page.targetId });
    await send('Extensions.triggerAction', { id, targetId });
    await until(async () => (await evaluate(sw, read)).status,
      state => state.phase === 'capturing' && state.session.tabId !== capture.session.tabId && state.stem.phase === 'idle',
      'Changing source releases stems');
    await send('Target.activateTarget', { targetId: fixturePage.targetId });
    await send('Extensions.triggerAction', { id, targetId: fixtureTab });
    const resumedCapture = await until(async () => (await evaluate(sw, read)).status,
      state => state.phase === 'capturing' && state.session.tabId === capture.session.tabId, 'Recapture stem source');
    await click('Vocals');
    await until(stemState, stem => stem.phase === 'active' && stem.mode === 'vocals', 'Reconnected helper after tab switch');
    if (!localStemsWithCloudApi) {
      await stopStemHelper();
      await until(stemState, stem => stem.phase === 'unavailable', 'Helper-disconnect fallback');
      const recovered = (await evaluate(sw, read)).status;
      assert.equal(recovered.session.id, resumedCapture.session.id);
      assert.equal(recovered.stem.mode, 'full');
      console.log('Helper-disconnect fallback passed.');
    }
    await click('Stop processing');
    await until(async () => (await evaluate(sw, read)).status, status => status.phase === 'ready', 'Stop after stem capture');
    console.log('Real helper and stem PCM, prompts, A/B, pause/resume, tab switch, reconnection and Stop passed.');
  }
  if (process.env.MOODSHIFT_YOUTUBE_TEST) {
    const youtube = 'https://www.youtube.com/watch?v=rZWLwz9_7o0';
    const youtubeTab = await send('Target.createTarget', { url: youtube, forTab: true });
    const youtubePage = await find(t => t.url === youtube || t.url.startsWith('chrome-error:'), 'YouTube page');
    const video = await attach(youtubePage.targetId);
    await wait(3000);
    const result = await evaluate(video, "(async () => { const video = document.querySelector('video'); if (!video) return { title: document.title, page: location.href, detail: document.body?.innerText.slice(0,200) }; video.muted = false; video.play().catch(() => undefined); return { video: true, title: document.title }; })()");
    console.log('YouTube page:', result);
    assert.equal(result.video, true);
    await wait(3000);
    await send('Extensions.triggerAction', { id, targetId: youtubeTab.targetId });
    const youtubeStatus = await until(
      async () => (await evaluate(sw, read)).status,
      status => status.phase === 'capturing' && status.features.rms > 0.001,
      'YouTube audio did not reach the analyser',
    );
    const playhead = () => evaluate(video, "document.querySelector('video').currentTime");
    const before = await playhead();
    const panel = await find(t => t.url === origin + '/sidepanel.html', 'YouTube side panel');
    const controls = await attach(panel.targetId);
    await evaluate(controls, "[...document.querySelectorAll('button')].find(b => b.textContent === 'Dreamy').click()");
    await wait(500);
    assert.equal((await evaluate(sw, read)).status.effects.reverbMix, 0.33);
    const windowId = await evaluate(sw, 'chrome.tabs.get(' + youtubeStatus.session.tabId + ').then(tab => tab.windowId)');
    await evaluate(sw, 'chrome.sidePanel.close({windowId:' + windowId + '})');
    await until(
      async () => (await send('Target.getTargets')).targetInfos.some(t => t.targetId === panel.targetId),
      present => !present,
      'YouTube panel did not close',
    );
    const { targetId: backgroundPage } = await send('Target.createTarget', { url: 'about:blank' });
    await wait(600);
    const backgroundCapture = (await evaluate(sw, read)).status;
    assert.equal(backgroundCapture.session.id, youtubeStatus.session.id);
    assert.ok(backgroundCapture.features.rms > 0.001);
    assert.equal(backgroundCapture.effects.reverbMix, 0.33);
    await until(playhead, position => position > before + 0.75, 'Background YouTube playback did not advance');
    if (process.env.MOODSHIFT_WORKER_TEST) {
      await send('Target.detachFromTarget', { sessionId: sw });
      await wait(32_000);
      await until(
        async () => (await send('Target.getTargets')).targetInfos.some(t => t.targetId === worker.targetId),
        present => !present,
        'Original service worker did not go idle',
      );
      const offscreen = await find(t => t.url === origin + '/offscreen.html', 'persistent offscreen document');
      const audio = await attach(offscreen.targetId);
      const restored = await evaluate(audio, "chrome.runtime.sendMessage({target:'worker',type:'GET_STATUS'})");
      assert.equal(restored.status.session.id, youtubeStatus.session.id);
      assert.equal(restored.status.effects.reverbMix, 0.33);
      const restartedWorker = await find(t => t.type === 'service_worker' && t.url.startsWith(origin), 'restarted worker');
      assert.notEqual(restartedWorker.targetId, worker.targetId);
      sw = await attach(restartedWorker.targetId);
      console.log('Service worker suspended and reconciled the same live session on wake.');
    }
    await send('Target.activateTarget', { targetId: youtubePage.targetId });
    await send('Extensions.triggerAction', { id, targetId: youtubeTab.targetId });
    await wait(400);
    const reopened = await find(t => t.url === origin + '/sidepanel.html', 'reopened YouTube panel');
    const reopenedControls = await attach(reopened.targetId);
    const reopenedStatus = (await evaluate(sw, read)).status;
    assert.equal(reopenedStatus.phase, 'capturing', JSON.stringify(reopenedStatus));
    assert.equal(reopenedStatus.session.id, youtubeStatus.session.id);
    assert.equal(await evaluate(reopenedControls, "document.querySelector('#effect-reverbMix').value"), '0.33');
    await evaluate(reopenedControls, "document.querySelector('#stop').click()");
    await wait(350);
    assert.equal((await evaluate(sw, read)).status.phase, 'ready');
    await until(playhead, position => position > before + 1.5, 'YouTube playback after Stop did not advance');
    await send('Target.closeTarget', { targetId: backgroundPage });
    console.log('YouTube signal, Dreamy ACK, uninterrupted playhead, background capture, panel reopen and Stop passed.');
  }
  if (process.env.MOODSHIFT_PRESETS_TEST) {
    const lastPanel = await attach((await find(t => t.url === origin + '/sidepanel.html', 'side panel before restart')).targetId);
    await evaluate(lastPanel, "document.querySelector('#advanced-tab').click()");
    await closeChrome();
    [chrome, chromeExited] = launchChrome();
    const reloaded = await send('Extensions.loadUnpacked', { path: extensionPath });
    assert.equal(reloaded.id, id);
    const restarted = await send('Target.createTarget', { url: url + '/?restarted', forTab: true });
    const restartedPage = await find(t => t.type === 'page' && t.url === url + '/?restarted', 'restarted tone page');
    const restartedSource = await attach(restartedPage.targetId);
    await until(() => evaluate(restartedSource, "Boolean(document.querySelector('button'))"), Boolean, 'Restarted tone player');
    await evaluate(restartedSource, "document.querySelector('button').click(); tone.resume()");
    await send('Extensions.triggerAction', { id, targetId: restarted.targetId });
    const restartedPanel = await attach((await find(t => t.url === origin + '/sidepanel.html', 'restarted side panel')).targetId);
    const readStatus = () => evaluate(restartedPanel, "chrome.runtime.sendMessage({target:'worker',type:'GET_STATUS'})");
    await until(readStatus, reply => reply.status.phase === 'capturing', 'Restarted capture');
    assert.equal(await evaluate(restartedPanel, "document.querySelector('#advanced-tab').getAttribute('aria-selected')"), 'true');
    if (process.env.MOODSHIFT_MEMORY_TEST) {
      const list = () => evaluate(restartedPanel, "Array.from(document.querySelectorAll('#memory-local-list li span'), row => row.textContent)");
      assert.deepEqual(await until(list, rows => rows.length === 1, 'Preferences persisted after Chrome restart'), ['I like warmer bass.']);
      assert.equal(await evaluate(restartedPanel, "document.querySelector('#memory-enabled').checked"), false);
      console.log('Local preference, opt-out and selected tab persisted across Chrome restart.');
    }
    assert.equal((await readStatus()).status.effects.reverbMix, 0);
    await until(() => evaluate(restartedPanel,
      "[...document.querySelector('#saved-preset-list').options].find(option => option.text === 'Restart preset')?.value"),
      Boolean, 'Preset persisted across Chrome restart');
    await evaluate(restartedPanel, `document.querySelector('#advanced-presets').open = true;
      document.querySelector('#saved-presets').open = true;
      window.fetch = () => { throw new Error('Preset restore must work offline'); };
      const select = document.querySelector('#saved-preset-list');
      select.value = [...select.options].find(option => option.text === 'Restart preset').value;
      select.dispatchEvent(new Event('change'));
      document.querySelector('#saved-preset-apply').click()`);
    await until(() => evaluate(restartedPanel, "document.querySelector('#saved-preset-status').textContent"),
      status => status === 'Applied ✓ · Restart preset', 'Offline preset ACK');
    const saved = (await readStatus()).status;
    assert.equal(saved.effects.reverbMix, 0.33);
    assert.equal(saved.effects.trebleDb, -2);
    assert.equal(saved.monitor, 'original');
    assert.equal(saved.stem.mode, 'full');
    console.log('Saved preset persisted across Chrome restart and restored exact DSP settings and monitor offline.');
  }
} finally {
  await stopStemHelper();
  await send('Browser.close').catch(() => undefined);
  chrome.kill();
  await chromeExited;
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  if (dirname(profile) === testDir) {
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
}

