import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rm, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { parse } from 'dotenv';
import { prepareReverb, checkReverb } from './reverb-browser.mjs';

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
const reverb = process.env.MOODSHIFT_REVERB_TEST ? await prepareReverb() : undefined;
let helper;
const fixture = createServer((req, res) => {
  if (reverb && req.url === '/reverb') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>Reverb local audio</title><audio controls loop src="/reverb-audio"></audio><script src="/reverb-dsp.js"></script>'); return;
  }
  if (reverb && req.url === '/reverb-dsp.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(reverb.dsp); return; }
  if (reverb && req.url === '/reverb-audio') {
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = Math.min(reverb.audio.length - 1, range?.[2] ? Number(range[2]) : reverb.audio.length - 1);
    const audio = reverb.audio.subarray(start, end + 1);
    res.writeHead(range ? 206 : 200, { 'Content-Type': reverb.mime, 'Content-Length': audio.length, 'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${reverb.audio.length}` } : {}) });
    res.end(audio); return;
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
  const args = process.env.MOODSHIFT_REVERB_STEMS ? ['tests/reverb_stem_fixture.py', '--port', stemPort] : stemPort
    ? ['-c', 'import sys; from scripts import stem_helper as helper; helper.PORT = int(sys.argv.pop(1)); helper.main()', stemPort]
    : ['-m', 'scripts.stem_helper'];
  helper = spawn(process.env.MOODSHIFT_STEM_PYTHON ?? '.stem-gate/venv/Scripts/python.exe',
    [...args, '--extension-id', extensionId, ...(process.env.MOODSHIFT_REVERB_STEMS ? [] : ['--device', process.env.MOODSHIFT_STEM_DEVICE ?? '1'])],
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
    assert.equal(await evaluate(view, "document.querySelector('#settings-panel').hidden"), true);
    if (cloudBuild) {
      const manifest = await evaluate(view, 'chrome.runtime.getManifest()');
      const stemOrigin = new URL(cloudConfig.STEM_WS_URL).origin;
      assert.ok(manifest.host_permissions.includes(new URL(cloudConfig.API_BASE_URL).origin + '/*'));
      assert.ok(manifest.host_permissions.includes(stemOrigin + '/*'));
      assert.equal(stemOrigin === 'ws://127.0.0.1:8788', localStemsWithCloudApi);
      assert.equal(await evaluate(view, "document.querySelector('#cloud-stem-note').hidden"), localStemsWithCloudApi);
      assert.ok(!manifest.host_permissions.includes('http://127.0.0.1/*'));
      await selectPanel('settings');
      assert.equal(await evaluate(view, "Boolean(document.querySelector('#cloud-settings'))"), false);
      // Operator provisioning replaced the visible form. Use only the test credential.
      await evaluate(view, `chrome.storage.local.set({moodshiftDemoAccessCode: ${JSON.stringify(smokeCode)}})`);
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
    assert.equal(await evaluate(view, "document.querySelector('#presets').children.length"), 4);
    await click('Dreamy');
    await wait(400);
    assert.match(await evaluate(view, "document.querySelector('#feedback').textContent"), /Applied/);
    const afterDreamy = await evaluate(sw, read);
    assert.equal(afterDreamy.status.effects?.reverbMix, 0.33);
    assert.deepEqual(await evaluate(view, "Array.from(document.querySelectorAll('#presets [aria-pressed=true]'), button => button.textContent)"), ['Dreamy']);
    await evaluate(view, `window.stemControls = document.querySelector('#stem-controls');
      document.querySelector('#home-tab').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));`);
    assert.equal(await evaluate(view, `document.activeElement.id === 'settings-tab'
      && document.querySelector('#home-panel').hidden && !document.querySelector('#settings-panel').hidden
      && document.querySelector('#settings-stems').contains(window.stemControls)`), true);
    const afterNavigation = (await evaluate(sw, read)).status;
    assert.equal(afterNavigation.session.id, afterDreamy.status.session.id);
    assert.equal(afterNavigation.revision, afterDreamy.status.revision);
    assert.deepEqual(afterNavigation.stem, afterDreamy.status.stem);
    assert.ok(afterNavigation.features.rms > 0.03);
    assert.equal(await evaluate(view, "Number(document.querySelector('#effect-reverbMix').value)"), 0.33);
    await selectPanel('home');
    await click('Warm');
    await until(async () => (await evaluate(sw, read)).status.effects.bassDb, value => value === 2, 'Home Warm preset');
    await click('Dreamy');
    await until(async () => (await evaluate(sw, read)).status.effects.bassDb, value => value === 0, 'Home preset');
    await click('Original');
    await wait(350);
    assert.equal((await evaluate(sw, read)).status.monitor, 'original');
    if (process.env.MOODSHIFT_PRESETS_TEST) {
      await selectPanel('settings');
      await evaluate(view, `document.querySelector('#saved-presets').open = true;
        const name = document.querySelector('#saved-preset-name');
        name.value = 'Restart preset'; name.dispatchEvent(new Event('input'));
        document.querySelector('#saved-preset-save').click()`);
      await until(() => evaluate(view, "document.querySelector('#saved-preset-status').textContent"),
        status => status === 'Preset saved.', 'Saving exact preset');
      await selectPanel('home');
    }
    await click('Modified');
    await selectPanel('settings');
    await evaluate(view, "document.querySelector('#effect-settings').open = true");
    await click('Reset');
    await wait(350);
    assert.equal((await evaluate(sw, read)).status.effects.reverbMix, 0);
    await selectPanel('settings');
    await evaluate(view, "const slider = document.querySelector('#effect-bassDb'); slider.value = '3.5'; slider.dispatchEvent(new Event('input')); slider.dispatchEvent(new Event('change'))");
    await wait(350);
    assert.equal((await evaluate(sw, read)).status.effects.bassDb, 3.5);
    assert.equal(await evaluate(view, "document.querySelector('#effect-bassDb').style.getPropertyValue('--fill')"), '77.5%');
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
      assert.equal((await evaluate(sw, read)).status.effects.bassDb, 3.5);

      await evaluate(view, "window.respond = result => Promise.resolve(Response.json(result)); window.fetch = () => respond({mode:'unsupported',patch:{},summary:'Playback speed is unavailable.',unsupported:['Slow playback']})");
      const revision = (await evaluate(sw, read)).status.revision;
      await submit();
      await wait(200);
      assert.match(await getFeedback(), /Unsupported/);
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
      await selectPanel('settings');
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
      await selectPanel('settings');
      await evaluate(view, `document.querySelector('#personalization').open = true;
        window.memoryCalls = [];
        window.fetch = async (url, options) => {
          const data = JSON.parse(options.body);
          window.memoryCalls.push(data);
          return Response.json({ mode: 'patch', patch: { bassDb: data.localPreferences ? -6 : -4 }, summary: 'Reduced bass.', unsupported: [] });
        }`);
      assert.equal(await evaluate(view, "document.querySelector('#memory-enabled').checked"), false);
      await memory('enabled');
      await until(status, text => text === 'Personalization enabled.', 'Local personalization enable');
      await selectPanel('home');
      await submit('Remember that I like warmer bass.');
      await until(feedback, text => text === 'Preference saved on this device.', 'Explicit local save prompt');
      await selectPanel('settings');
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
      let calls = await evaluate(view, 'window.memoryCalls');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].personalization, undefined);
      assert.deepEqual(calls[0].localPreferences, ['I like warmer bass.']);
      assert.equal((await evaluate(sw, read)).status.effects.bassDb, -6);
      await selectPanel('settings');
      await evaluate(view, "document.querySelector('#memory-local-list li button:nth-child(2)').click()");
      await until(status, text => text === 'Local preference deleted.', 'Delete local preference');
      await memory('enabled');
      await until(status, text => text.startsWith('Personalization disabled.'), 'Local personalization disable');
      await selectPanel('home');
      await submit('Remove all bass.');
      await until(feedback, text => text.startsWith('Applied ✓'), 'Ordinary Gemini ACK');
      assert.equal(await evaluate(view, "!('personalization' in window.memoryCalls.at(-1)) && !('localPreferences' in window.memoryCalls.at(-1))"), true);
      await selectPanel('settings');
      assert.equal(await evaluate(view, "document.querySelector('#memory-local-list').children.length"), 1);
      await selectPanel('home');
      console.log('Local preference CRUD, Gemini context and opt-out passed.');
    }
    if (process.env.MOODSHIFT_UI_TEST) {
      await selectPanel('settings');
      await until(() => evaluate(view, "!document.querySelector('[data-home-section=lyrics]').disabled"), Boolean, 'Home preferences loaded');
      assert.equal(await evaluate(view, "document.querySelector('#track-platform').textContent"), 'Browser audio');
      assert.equal(await evaluate(view, "!document.querySelector('#song-artwork').getAttribute('src') && Boolean(document.querySelector('#platform-icon svg'))"), true);
      assert.equal(await evaluate(view, `(() => {
        window.testLyrics = document.querySelector('#lyrics');
        document.querySelector('[data-home-section=lyrics]').click();
        document.querySelector('[data-home-section=reverb]').click();
        return document.querySelector('#settings-lyrics').contains(window.testLyrics);
      })()`), true);
      await until(() => evaluate(view, "chrome.storage.local.get('moodshiftHomeLayout').then(data => data.moodshiftHomeLayout)"),
        layout => layout?.lyrics === false && layout?.reverb === true, 'Home toggles persisted');
      await selectPanel('home');
      assert.equal(await evaluate(view, "document.querySelector('#home-lyrics').hidden && document.querySelector('#home-reverb').contains(document.querySelector('#audio-effects'))"), true);
      const version = (await evaluate(sw, read)).status.revision;
      await selectPanel('settings');
      assert.equal(await evaluate(view, "document.querySelector('#settings-lyrics').contains(window.testLyrics)"), true);
      assert.equal((await evaluate(sw, read)).status.revision, version);
      const images = await evaluate(view, `Promise.all(Object.entries(chrome.runtime.getManifest().icons).map(async ([size, src]) => {
        const img = new Image(); img.src = chrome.runtime.getURL(src); await img.decode();
        return [Number(size), img.naturalWidth, img.naturalHeight];
      }))`);
      assert.deepEqual(images, [[16, 16, 16], [32, 32, 32], [48, 48, 48], [128, 128, 128]]);
      assert.equal(await evaluate(view, "!document.querySelector('#cloud-settings, #supermemory-settings')"), true);
      if (process.env.MOODSHIFT_UI_SCREENSHOTS) {
        const { targetId: preview } = await send('Target.createTarget', { url: origin + '/sidepanel.html' });
        const narrow = await attach(preview);
        await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: false }, narrow);
        await until(() => evaluate(narrow, "document.querySelector('#presets')?.children.length"), count => count === 4, 'Preview loaded');
        for (const page of ['home', 'settings', 'controls']) {
          await evaluate(narrow, `document.querySelector('#${page === 'home' ? 'home' : 'settings'}-tab').click();
            if ('${page}' === 'controls') {
              document.querySelector('#customize-home').open = false;
              document.querySelector('#audio-effects').open = true;
              document.querySelector('#effect-settings').open = true;
            }`);
          await wait(200);
          const sizing = await evaluate(narrow, `({ viewport: innerWidth, document: document.documentElement.scrollWidth,
            overflow: Array.from(document.querySelectorAll('main *')).filter(el => el.getBoundingClientRect().right > innerWidth).map(el => el.id || el.tagName) })`);
          assert.ok(sizing.viewport === 320 && sizing.document <= 320, `${page} viewport: ${JSON.stringify(sizing)}`);
          const screenshot = await send('Page.captureScreenshot', { format: 'png' }, narrow);
          await writeFile(resolve(testDir, `ui-${page}.png`), Buffer.from(screenshot.data, 'base64'));
        }
        await send('Emulation.setDeviceMetricsOverride', { width: 250, height: 620, deviceScaleFactor: 1, mobile: false }, narrow);
        assert.ok(await evaluate(narrow, 'document.documentElement.scrollWidth <= 250'));
        await send('Target.closeTarget', { targetId: preview });
        const { targetId: managementTab } = await send('Target.createTarget', { url: 'chrome://extensions/' });
        const management = await attach(managementTab);
        await until(() => evaluate(management, `(() => {
          const list = document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-item-list');
          const entry = Array.from(list?.shadowRoot?.querySelectorAll('extensions-item') ?? []).find(item => item.data?.id === ${JSON.stringify(id)});
          const icon = entry?.shadowRoot?.querySelector('img');
          return Boolean(icon?.complete && icon.naturalWidth > 0);
        })()`), Boolean, 'MoodShift icon rendered in Chrome extension management');
        await send('Target.closeTarget', { targetId: managementTab });
      }
    }
    const beforeClose = (await evaluate(sw, read)).status;
    await selectPanel('settings');
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
    await until(() => evaluate(reopened, "document.querySelector('#settings-tab')?.getAttribute('aria-selected')"),
      selected => selected === 'true', 'Settings selection persisted after reopening');
    if (process.env.MOODSHIFT_UI_TEST) {
      await until(() => evaluate(reopened, "!document.querySelector('[data-home-section=lyrics]').disabled"), Boolean, 'Restored Home preferences loaded');
      assert.equal(await evaluate(reopened, "!document.querySelector('[data-home-section=lyrics]').checked && document.querySelector('[data-home-section=reverb]').checked"), true);
      await evaluate(reopened, "document.querySelector('[data-home-section=lyrics]').click(); document.querySelector('[data-home-section=reverb]').click()");
      await until(() => evaluate(reopened, "chrome.storage.local.get('moodshiftHomeLayout').then(data => data.moodshiftHomeLayout)"),
        layout => layout?.lyrics === true && layout?.reverb === false, 'Home defaults restored');
      console.log('Home customization, reopening, Settings access, original icon sizes, narrow layout and platform fallback passed.');
    }
    await evaluate(reopened, "document.querySelector('#home-tab').click()");
    console.log('Capture continued while the side panel was closed and Settings selection survived reopening.');
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
  if (reverb) {
    assert.ok(!process.env.MOODSHIFT_REVERB_STEMS || stemPort, 'Reverb stem fixture requires an isolated MOODSHIFT_STEM_TEST_PORT');
    await checkReverb({ send, evaluate, find, attach, until, url, origin, id, sw, read, startStemHelper, stopStemHelper });
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
    const openChords = () => evaluate(chordsPanel, "document.querySelector('#chords').open = true");
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
    await seek(13.5);
    await until(readChords, value => value.current === 'Eb' && value.next === 'Eb/Ab' && value.keyboard && value.guitar, 'Diagrams and next chord');
    await seek(17);
    await until(readChords, value => value.current === 'Eb/Ab', 'Forward chord seek');
    await seek(16, 2);
    await setOffset(1);
    await until(readChords, value => value.current === 'Eb', 'Rate-adjusted chord offset');
    await setOffset(0);
    await seek(13.5);
    await until(readChords, value => value.current === 'Eb', 'Backward chord seek');
    assert.ok(await evaluate(chordsPanel, "chrome.storage.local.get('songleChordCacheV1').then(values => values.songleChordCacheV1?.PqJNc9KVIZE?.result?.events.length > 20)"));
    await evaluate(chordsPanel, "document.querySelector('#stop').click()");
    await until(readChords, value => value.status.startsWith('Select a YouTube'), 'Chord status cleared after Stop');
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
    await evaluate(lyricsPanel, "document.querySelector('#home-tab').click()");
    assert.equal(await evaluate(lyricsPanel, "document.querySelector('#home-lyrics').contains(document.querySelector('#lyrics-viewport'))"), true);
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
    const powers = await until(() => evaluate(audio, `window.stemMeters?.map(analyser => {
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    })`), rms => rms?.[0] > 0.0001 && rms?.[2] > 0.0001, 'Both actual stems produced PCM');
    assert.notEqual(powers[0], powers[2]);
    await submit('vocals only');
    await until(stemState, stem => stem.phase === 'active' && stem.mode === 'vocals', 'Vocals did not activate');
    const beforeTabs = (await evaluate(sw, read)).status;
    await evaluate(panelView, "document.querySelector('#settings-tab').click(); document.querySelector('#stem-controls').open = true");
    assert.equal(await evaluate(panelView, "document.querySelector('#stem-controls').contains(document.querySelector('[data-stem=vocals][aria-pressed=true]'))"), true);
    await evaluate(panelView, "document.querySelector('#home-tab').click()");
    const afterTabs = (await evaluate(sw, read)).status;
    assert.equal(afterTabs.session.id, beforeTabs.session.id);
    assert.equal(afterTabs.revision, beforeTabs.revision);
    assert.deepEqual(afterTabs.stem, beforeTabs.stem);
    console.log('Active Vocals stem and capture survived Home and Settings navigation.');
    await click('Original');
    assert.match(await until(() => evaluate(panelView, "document.querySelector('#stem-status').textContent"),
      value => value.includes('Live mix'), 'Original bypass label'), /delayed stem/);
    await click('Modified');
    await submit('just play the beat');
    assert.match(await until(feedback, value => value.includes('Unsupported'), 'Beat-only response'), /Unsupported/);
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
    await evaluate(lastPanel, "document.querySelector('#settings-tab').click()");
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
    assert.equal(await evaluate(restartedPanel, "document.querySelector('#settings-tab').getAttribute('aria-selected')"), 'true');
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
    await evaluate(restartedPanel, `document.querySelector('#saved-presets').open = true;
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

