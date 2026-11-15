import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rm, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const testDir = resolve('.moodshift-test');
await mkdir(testDir, { recursive: true });
const profile = await mkdtemp(resolve(testDir, 'profile-'));
const chrome = spawn(process.env.MOODSHIFT_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--user-data-dir=' + profile,
  '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
const chromeExited = new Promise(done => {
  chrome.once('exit', done);
  chrome.once('error', error => { console.error(error.message); done(); });
});
chrome.stdio[3].on('error', () => undefined);
chrome.stderr.on('data', data => {
  if (process.env.CHROME_TEST_DEBUG) process.stderr.write(data);
});
const stemTest = Boolean(process.env.MOODSHIFT_STEM_TEST);
const stemYouTube = Boolean(process.env.MOODSHIFT_STEM_YOUTUBE);
const stemFixture = stemTest && !stemYouTube ? await readFile('.stem-gate/assets/fixture.ogg') : undefined;
let helper;
const fixture = createServer((req, res) => {
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
chrome.stdio[4].on('data', chunk => {
  data += chunk.toString();
  let end;
  while ((end = data.indexOf('\0')) !== -1) {
    const value = JSON.parse(data.slice(0, end));
    data = data.slice(end + 1);
    requests.get(value.id)?.(value);
  }
});
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
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  }, session);
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
  helper = spawn(process.env.MOODSHIFT_STEM_PYTHON ?? '.stem-gate/venv/Scripts/python.exe',
    ['-m', 'scripts.stem_helper', '--extension-id', extensionId, '--device', process.env.MOODSHIFT_STEM_DEVICE ?? '1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let helperLog = '';
  helper.stdout.on('data', data => { helperLog += data.toString(); });
  helper.stderr.on('data', data => { helperLog += data.toString(); });
  helper.on('error', error => { helperLog += error.message; });
  await until(() => helperLog, log => log.includes('helper ready'), 'Stem helper startup', 80);
}

try {
  console.log((await send('Browser.getVersion')).product);
  const { id } = await send('Extensions.loadUnpacked', { path: resolve('extension/dist') });
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
    const click = name => evaluate(view, `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(name)}).click()`);
    await click('Dreamy');
    await wait(400);
    assert.match(await evaluate(view, "document.querySelector('#feedback').textContent"), /Applied/);
    const afterDreamy = await evaluate(sw, read);
    assert.equal(afterDreamy.status.effects?.reverbMix, 0.33);
    await click('Original');
    await wait(350);
    assert.equal((await evaluate(sw, read)).status.monitor, 'original');
    await click('Modified');
    await click('Reset');
    await wait(350);
    assert.equal((await evaluate(sw, read)).status.effects.reverbMix, 0);
    await evaluate(view, "const slider = document.querySelector('#effect-bassDb'); slider.value = '3.5'; slider.dispatchEvent(new Event('input')); slider.dispatchEvent(new Event('change'))");
    await wait(350);
    assert.equal((await evaluate(sw, read)).status.effects.bassDb, 3.5);
    assert.ok(await evaluate(view, 'document.documentElement.scrollWidth <= innerWidth'));
    if (await evaluate(view, "Boolean(document.querySelector('#interpret'))")) {
      const getFeedback = () => evaluate(view, "document.querySelector('#feedback').textContent");
      const submit = () => evaluate(view, "(() => { const field = document.querySelector('#prompt'); field.value = 'A little more bass'; field.dispatchEvent(new Event('input')); document.querySelector('#interpret').requestSubmit(); })()");
      await evaluate(view, "window.unmockedFetch = window.fetch.bind(window); window.fetch = () => Promise.reject(new TypeError('Simulated proxy outage'));");
      await submit();
      await wait(400);
      assert.match(await getFeedback(), /Offline.*Gemini unavailable/);
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
      await click('Warm');
      await wait(300);
      await evaluate(view, 'window.releaseReply()');
      await wait(200);
      assert.equal((await evaluate(sw, read)).status.effects.bassDb, 2);
      const staleRevision = await evaluate(sw, "chrome.runtime.sendMessage({target:'audio',type:'APPLY_EFFECTS',patch:{bassDb:8},sessionId:" + JSON.stringify(capture.status.session.id) + ",baseRevision:" + revision + "})");
      assert.equal(staleRevision.ok, false);
      console.log('Gemini failure, unsupported response and stale edit checks passed.');
    }
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
    await wait(450);
    assert.equal((await evaluate(sw, read)).status.phase, 'ready');
    await send('Extensions.triggerAction', { id, targetId });
    await wait(700);
  }
  const current = (await evaluate(sw, read)).status;
  const panel = await find(t => t.url === origin + '/sidepanel.html', 'side panel');
  const view = await attach(panel.targetId);
  await evaluate(view, "document.querySelector('#stop').click()");
  await wait(350);
  assert.equal((await evaluate(sw, read)).status.phase, 'ready');
  assert.equal((await evaluate(sw, 'chrome.tabCapture.getCapturedTabs()')).find(tab => tab.tabId === current.session.tabId)?.status, 'stopped');
  console.log('Local tone, DSP controls, tab switching and Stop checks passed.');
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
      helper.kill();
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
    const click = name => evaluate(panelView, `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(name)}).click()`);
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
    await click('Instrumental');
    await until(stemState, stem => stem.phase === 'unavailable', 'Missing-helper fallback');
    assert.doesNotMatch(await feedback(), /Applied/);

    await startStemHelper(id);
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
    assert.equal((await stemState()).phase, 'active', 'Paused PCM remains in sequence');
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
    helper.kill();
    await until(stemState, stem => stem.phase === 'unavailable', 'Helper-disconnect fallback');
    const recovered = (await evaluate(sw, read)).status;
    assert.equal(recovered.session.id, resumedCapture.session.id);
    assert.equal(recovered.stem.mode, 'full');
    await click('Stop processing');
    await until(async () => (await evaluate(sw, read)).status, status => status.phase === 'ready', 'Stop after stem capture');
    console.log('Real helper and stem PCM, prompts, A/B, pause/resume, tab switch, reconnection, helper-disconnect fallback and Stop passed.');
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
} finally {
  helper?.kill();
  await send('Browser.close').catch(() => undefined);
  chrome.kill();
  await chromeExited;
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  if (dirname(profile) === testDir) {
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
}

