"use strict";
(() => {
  // <define:__MOODSHIFT_DEPLOYMENT__>
  var define_MOODSHIFT_DEPLOYMENT_default = { mode: "development", apiBaseUrl: "http://127.0.0.1:8787", stemWsUrl: "ws://127.0.0.1:8788", stemDelaySeconds: 2.8 };

  // extension/src/shared/effects.ts
  var effectSpecs = {
    bassDb: { label: "Bass shelf", min: -12, max: 8, neutral: 0, step: 0.1, unit: "dB" },
    trebleDb: { label: "Treble shelf", min: -12, max: 8, neutral: 0, step: 0.1, unit: "dB" },
    highpassHz: { label: "High-pass", min: 20, max: 1500, neutral: 20, step: 1, unit: "Hz" },
    lowpassHz: { label: "Low-pass", min: 600, max: 2e4, neutral: 2e4, step: 1, unit: "Hz" },
    reverbMix: { label: "Reverb", min: 0, max: 0.55, neutral: 0, step: 0.01, unit: "%" },
    delayMs: { label: "Echo time", min: 0, max: 500, neutral: 0, step: 1, unit: "ms" },
    delayMix: { label: "Echo mix", min: 0, max: 0.35, neutral: 0, step: 0.01, unit: "%" },
    delayFeedback: { label: "Echo feedback", min: 0, max: 0.4, neutral: 0, step: 0.01, unit: "%" },
    distortion: { label: "Distortion", min: 0, max: 0.5, neutral: 0, step: 0.01, unit: "%" },
    outputGainDb: { label: "Output gain", min: -12, max: 3, neutral: 0, step: 0.1, unit: "dB" }
  };
  var effectKeys = Object.keys(effectSpecs);
  var neutralEffects = Object.freeze(
    Object.fromEntries(effectKeys.map((key) => [key, effectSpecs[key].neutral]))
  );
  function clampPatch(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Expected an object of effect values.");
    }
    const patch = {};
    for (const [key, value] of Object.entries(input)) {
      if (!Object.hasOwn(effectSpecs, key)) throw new Error("Unknown effect parameter.");
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Effect values must be finite numbers.");
      const effect = key;
      const { min, max } = effectSpecs[effect];
      patch[effect] = Math.max(min, Math.min(max, value));
    }
    return patch;
  }
  function applyPatch(current, patch) {
    return { ...current, ...clampPatch(patch) };
  }
  function clampEffects(input) {
    const patch = clampPatch(input);
    if (Object.keys(patch).length !== effectKeys.length) throw new Error("Expected all effect parameters.");
    return applyPatch(neutralEffects, patch);
  }
  var presets = {
    Dreamy: Object.freeze({ ...neutralEffects, reverbMix: 0.33, trebleDb: -2 }),
    Warm: Object.freeze({ ...neutralEffects, bassDb: 2, trebleDb: -3 }),
    Underwater: Object.freeze({ ...neutralEffects, lowpassHz: 1e3 }),
    "Bass Boost": Object.freeze({ ...neutralEffects, bassDb: 5 }),
    "Clear Voice": Object.freeze({ ...neutralEffects, highpassHz: 100, bassDb: -2, trebleDb: 2 })
  };

  // extension/src/lyrics-session.ts
  var LyricsSession = class {
    constructor() {
      this.revision = 0;
      this.playback = null;
    }
    setSource(source) {
      this.source = source;
      this.playback = null;
      this.revision++;
    }
    receive(source, snapshot2) {
      if (source !== this.source) return "ignored";
      const previous = this.playback;
      const changed = previous?.videoId !== snapshot2?.videoId || previous?.song.title !== snapshot2?.song.title || previous?.song.artist !== snapshot2?.song.artist || previous?.ad !== snapshot2?.ad || Math.round((previous?.song.duration ?? 0) * 10) !== Math.round((snapshot2?.song.duration ?? 0) * 10);
      this.playback = snapshot2;
      if (changed) this.revision++;
      return changed ? "changed" : "playback";
    }
    invalidateLookup() {
      return ++this.revision;
    }
    acceptsLookup(revision) {
      return this.playback !== null && this.revision === revision;
    }
  };

  // extension/src/shared/lyrics.ts
  var youtubePlaybackPort = "moodshift-youtube-playback";
  function trackKey(value) {
    return value.normalize("NFKD").toLowerCase().replace(new RegExp("\\p{M}", "gu"), "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }
  function synchronizedPosition(playback, offset) {
    return playback.position - offset * playback.rate;
  }
  function activeLyric(lines, playback, offset) {
    const position = synchronizedPosition(playback, offset);
    let start = 0;
    let end = lines.length;
    while (start < end) {
      const mid = start + end >>> 1;
      if (lines[mid].time <= position) start = mid + 1;
      else end = mid;
    }
    return start - 1;
  }
  function validSong(query) {
    return !!trackKey(query.title) && !!trackKey(query.artist) && query.title.length <= 200 && query.artist.length <= 200 && Number.isFinite(query.duration) && query.duration >= 1 && query.duration <= 3600;
  }

  // extension/src/lyrics-panel.ts
  var offsetKey = "lyricsOffset";
  var correctionKey = "lyricsCorrections";
  var formatOffset = (value) => Math.max(-10, Math.min(10, Number.isFinite(value) ? value : 0));
  function mountLyrics(root, onPlayback) {
    const form2 = root.querySelector("#lyrics-search");
    const title = root.querySelector("#lyrics-title");
    const artist = root.querySelector("#lyrics-artist");
    const search = root.querySelector("#lyrics-submit");
    const status2 = root.querySelector("#lyrics-status");
    const viewport = root.querySelector("#lyrics-viewport");
    const follow = root.querySelector("#lyrics-follow");
    const offset = root.querySelector("#lyrics-offset");
    const session = new LyricsSession();
    let source;
    let connection;
    let searchTimer;
    let cooldownTimer;
    let edited = false;
    let editing = false;
    let allowSearchAt = 0;
    let lines = [];
    let lineElements = [];
    let active = -1;
    function refreshControls() {
      form2.hidden = session.playback === null;
      search.disabled = !session.playback?.song.duration || Date.now() < allowSearchAt;
    }
    function clearLyrics() {
      active = -1;
      lines = [];
      lineElements = [];
      viewport.replaceChildren();
      viewport.hidden = true;
      follow.disabled = true;
    }
    function centerActive() {
      if (!follow.checked || !viewport.clientHeight) return;
      const line = lineElements[active];
      if (line?.hidden) return;
      viewport.scrollTop = line ? line.offsetTop - (viewport.clientHeight - line.clientHeight) / 2 : 0;
    }
    new ResizeObserver(centerActive).observe(viewport);
    function highlight() {
      const playback = session.playback;
      onPlayback(playback, formatOffset(offset.valueAsNumber));
      if (!playback || !lines.length) return;
      const index = activeLyric(lines, playback, formatOffset(offset.valueAsNumber));
      if (index === active) return;
      lineElements[active]?.removeAttribute("aria-current");
      active = index;
      if (lines[index]?.text) lineElements[index].setAttribute("aria-current", "true");
      centerActive();
    }
    function show(result) {
      clearLyrics();
      switch (result.kind) {
        case "synced":
          status2.textContent = "Synchronized lyrics";
          lines = result.lines;
          lineElements = lines.map(({ text }) => {
            const line = document.createElement("p");
            line.textContent = text;
            line.hidden = !text;
            return line;
          });
          viewport.replaceChildren(...lineElements);
          viewport.hidden = false;
          follow.disabled = false;
          highlight();
          break;
        case "plain": {
          status2.textContent = "Plain lyrics \xB7 Timing unavailable";
          const plain = document.createElement("p");
          plain.textContent = result.text;
          viewport.replaceChildren(plain);
          viewport.hidden = false;
          break;
        }
        case "instrumental":
          status2.textContent = "LRCLIB lists this recording as instrumental.";
          break;
        case "invalid":
          status2.textContent = "Check the song title and artist. A finite video duration is needed.";
          break;
        case "missing":
          status2.textContent = "No matching lyrics. Check the song title and artist and try again.";
          break;
        case "ambiguous":
          status2.textContent = "Multiple recordings matched. Check the title and artist.";
          break;
        case "error":
          status2.textContent = "Could not reach LRCLIB or read its reply. Try again shortly.";
          break;
        case "limited": {
          allowSearchAt = result.retryAt;
          const seconds = Math.max(1, Math.ceil((allowSearchAt - Date.now()) / 1e3));
          const notice = "LRCLIB asks us to wait. Try again in " + seconds + " s.";
          status2.textContent = notice;
          clearTimeout(cooldownTimer);
          cooldownTimer = setTimeout(() => {
            if (status2.textContent === notice && Date.now() >= allowSearchAt) status2.textContent = "You can retry the lyric search.";
            refreshControls();
          }, Math.min(2147483647, seconds * 1e3));
          break;
        }
      }
      refreshControls();
    }
    async function find(revision, retry) {
      if (!session.acceptsLookup(revision)) return;
      const query = { title: title.value.trim(), artist: artist.value.trim(), duration: session.playback.song.duration };
      if (!validSong(query)) {
        show({ kind: "invalid" });
        return;
      }
      clearLyrics();
      status2.textContent = "Finding lyrics\u2026";
      try {
        const result = await chrome.runtime.sendMessage({
          target: "lyrics",
          query,
          retry
        });
        if (session.acceptsLookup(revision)) show(result);
      } catch {
        if (session.acceptsLookup(revision)) show({ kind: "error" });
      }
    }
    function receive(id, update) {
      const previousVideo = session.playback?.videoId;
      const outcome = session.receive(id, update);
      if (outcome === "ignored") return;
      if (outcome === "changed") onPlayback(update, formatOffset(offset.valueAsNumber));
      if (outcome === "playback" && update) {
        highlight();
        return;
      }
      clearTimeout(searchTimer);
      clearLyrics();
      refreshControls();
      if (!update) {
        title.value = "";
        artist.value = "";
        status2.textContent = "Waiting for a YouTube video on the selected tab\u2026";
        return;
      }
      if (previousVideo !== update.videoId) {
        edited = false;
        editing = false;
      }
      if (editing) return;
      if (!edited) {
        title.value = update.song.title.slice(0, 200);
        artist.value = update.song.artist.slice(0, 200);
      }
      if (!update.song.duration) {
        status2.textContent = update.ad ? "Lyrics will resume after the ad." : "Waiting for the video to start\u2026";
        return;
      }
      status2.textContent = "Finding lyrics\u2026";
      const revision = session.invalidateLookup();
      searchTimer = setTimeout(async () => {
        try {
          const stored = await chrome.storage.session.get(correctionKey);
          const corrections = stored[correctionKey];
          const correction = corrections?.[update.videoId];
          if (!session.acceptsLookup(revision)) return;
          if (correction && !edited) {
            title.value = correction.title;
            artist.value = correction.artist;
            edited = true;
          }
        } catch {
        }
        void find(revision, false);
      }, 700);
    }
    function connect() {
      if (!source || connection) return;
      const { id, tabId } = source;
      const port = chrome.tabs.connect(tabId, { name: youtubePlaybackPort, frameId: 0 });
      connection = port;
      port.onMessage.addListener((update) => {
        if (connection === port) receive(id, update);
      });
      port.onDisconnect.addListener(() => {
        const failed = chrome.runtime.lastError;
        if (connection !== port) return;
        connection = void 0;
        receive(id, null);
        if (failed) status2.textContent = "Select a YouTube watch tab. Reload the page if the extension was just installed.";
      });
    }
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      if (tabId === source?.tabId && change.status === "complete") connect();
    });
    for (const input of [title, artist]) {
      input.addEventListener("input", () => {
        edited = true;
        editing = true;
        clearTimeout(searchTimer);
        session.invalidateLookup();
        clearLyrics();
        status2.textContent = "Search to apply your song details.";
      });
    }
    form2.addEventListener("submit", (event) => {
      event.preventDefault();
      const playback = session.playback;
      if (!playback || search.disabled) return;
      clearTimeout(searchTimer);
      const revision = session.invalidateLookup();
      editing = false;
      const correction = { title: title.value.trim(), artist: artist.value.trim() };
      if (validSong({ ...correction, duration: playback.song.duration })) {
        edited = true;
        void chrome.storage.session.get(correctionKey).then((values) => {
          const entries = Object.entries(values[correctionKey] ?? {}).filter(([id]) => id !== playback.videoId);
          return chrome.storage.session.set({
            [correctionKey]: Object.fromEntries([...entries.slice(-11), [playback.videoId, correction]])
          });
        }).catch(() => void 0);
      }
      void find(revision, true);
    });
    let offsetChanged = false;
    void chrome.storage.local.get(offsetKey).then((values) => {
      if (offsetChanged) return;
      offset.value = String(formatOffset(Number(values[offsetKey] ?? 0)));
      highlight();
    }).catch(() => void 0);
    offset.addEventListener("input", () => {
      offsetChanged = true;
      highlight();
    });
    offset.addEventListener("change", () => {
      const value = formatOffset(offset.valueAsNumber);
      offset.value = String(value);
      void chrome.storage.local.set({ [offsetKey]: value }).catch(() => void 0);
      highlight();
    });
    follow.addEventListener("change", centerActive);
    for (const event of ["wheel", "touchstart"]) {
      viewport.addEventListener(event, () => {
        follow.checked = false;
      }, { passive: true });
    }
    viewport.addEventListener("keydown", (event) => {
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(event.key)) follow.checked = false;
    });
    return {
      setSource(next) {
        if (next?.id === source?.id) return;
        const old = connection;
        connection = void 0;
        old?.disconnect();
        source = next;
        session.setSource(next?.id);
        onPlayback(null, formatOffset(offset.valueAsNumber));
        clearTimeout(searchTimer);
        clearLyrics();
        title.value = "";
        artist.value = "";
        refreshControls();
        status2.textContent = next ? "Waiting for a YouTube video on the selected tab\u2026" : "Select a playing YouTube tab with the MoodShift icon.";
        connect();
      }
    };
  }

  // extension/src/shared/chords.ts
  var validChordVideo = (id) => typeof id === "string" && /^[\w-]{11}$/.test(id);
  function chordPosition(events, playback, offset) {
    if (playback.ad) return { current: -1, next: -1 };
    const time = synchronizedPosition(playback, offset);
    let start = 0;
    let end = events.length;
    while (start < end) {
      const mid = start + end >>> 1;
      if (events[mid].startTime <= time) start = mid + 1;
      else end = mid;
    }
    return {
      current: start > 0 && time < events[start - 1].endTime ? start - 1 : -1,
      next: start < events.length ? start : -1
    };
  }
  var notes = ["C", "C\u266F", "D", "D\u266F", "E", "F", "F\u266F", "G", "G\u266F", "A", "A\u266F", "B"];
  var naturalNotes = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  var intervals = {
    "": [0, 4, 7],
    maj: [0, 4, 7],
    m: [0, 3, 7],
    "7": [0, 4, 7, 10],
    maj7: [0, 4, 7, 11],
    M7: [0, 4, 7, 11],
    m7: [0, 3, 7, 10],
    mM7: [0, 3, 7, 11],
    sus2: [0, 2, 7],
    sus4: [0, 5, 7]
  };
  function pitch(name) {
    return (naturalNotes[name[0]] + (name[1] === "#" ? 1 : name[1] === "b" ? -1 : 0) + 12) % 12;
  }
  function pianoNotes(chord) {
    const match = /^([A-G][#b]?)([\w]*)(?:\/([A-G][#b]?))?$/.exec(chord.replaceAll("\u266F", "#").replaceAll("\u266D", "b"));
    if (!match || !Object.hasOwn(intervals, match[2])) return;
    const root = pitch(match[1]);
    const pitches = intervals[match[2]].map((interval) => (root + interval) % 12);
    const bass = match[3] && pitch(match[3]);
    if (typeof bass === "number") return [bass, ...pitches.filter((note) => note !== bass)].map((note) => notes[note]);
    return pitches.map((note) => notes[note]);
  }
  var fingerings = {
    C: [-1, 3, 2, 0, 1, 0],
    D: [-1, -1, 0, 2, 3, 2],
    E: [0, 2, 2, 1, 0, 0],
    F: [1, 3, 3, 2, 1, 1],
    G: [3, 2, 0, 0, 0, 3],
    A: [-1, 0, 2, 2, 2, 0],
    B: [-1, 2, 4, 4, 4, 2],
    Am: [-1, 0, 2, 2, 1, 0],
    Em: [0, 2, 2, 0, 0, 0],
    Dm: [-1, -1, 0, 2, 3, 1],
    Bm: [-1, 2, 4, 4, 3, 2],
    "F#m": [2, 4, 4, 2, 2, 2],
    Bb: [-1, 1, 3, 3, 3, 1],
    Eb: [-1, -1, 1, 3, 4, 3],
    Gm: [3, 5, 5, 3, 3, 3],
    G7: [3, 2, 0, 0, 0, 1],
    E7: [0, 2, 0, 1, 0, 0],
    A7: [-1, 0, 2, 0, 2, 0],
    Am7: [-1, 0, 2, 0, 1, 0],
    Cmaj7: [-1, 3, 2, 0, 0, 0],
    Dsus4: [-1, -1, 0, 2, 3, 3]
  };
  var guitarAliases = { "A#": "Bb", "D#": "Eb", Gbm: "F#m", CM7: "Cmaj7" };
  function guitarFrets(chord) {
    const name = chord.replaceAll("\u266F", "#").replaceAll("\u266D", "b");
    const key = Object.hasOwn(guitarAliases, name) ? guitarAliases[name] : name;
    return Object.hasOwn(fingerings, key) ? fingerings[key] : void 0;
  }

  // extension/src/chords-provider.ts
  var cacheAge = 7 * 24 * 60 * 60 * 1e3;
  var cacheWrite = Promise.resolve();
  var ChordSession = class {
    constructor(provider, render2) {
      this.provider = provider;
      this.render = render2;
      this.revision = 0;
      this.requested = -1;
    }
    setPlayback(playback) {
      const valid = playback && validChordVideo(playback.videoId);
      const id = valid ? playback.videoId : void 0;
      if (id !== this.videoId) {
        this.videoId = id;
        this.revision++;
        this.result = void 0;
      }
      if (id && playback && Number.isFinite(playback.song.duration) && playback.song.duration > 0 && !playback.ad && !this.result && this.requested !== this.revision) {
        void this.lookup(id);
      }
    }
    async lookup(id) {
      const revision = this.revision;
      this.requested = revision;
      const result = await this.provider(id).catch(() => ({ kind: "unavailable" }));
      if (revision === this.revision) {
        this.result = result;
        this.render();
      }
    }
    retry() {
      if (this.videoId && this.result?.kind !== "found" && this.result) {
        this.result = void 0;
        void this.lookup(this.videoId);
        this.render();
      }
    }
  };

  // extension/src/chords-panel.ts
  var pianoKeys = ["C", "C\u266F", "D", "D\u266F", "E", "F", "F\u266F", "G", "G\u266F", "A", "A\u266F", "B"];
  var element = (tag, content) => {
    const node = document.createElement(tag);
    node.textContent = content;
    return node;
  };
  function piano(chord) {
    const notes2 = pianoNotes(chord);
    if (!notes2) return element("p", "Diagram unavailable");
    const keyboard = element("div", "");
    keyboard.className = "chord-piano";
    keyboard.setAttribute("aria-hidden", "true");
    for (const note of pianoKeys) {
      const key = element("span", "");
      if (note.includes("\u266F")) key.className = "black-key";
      if (notes2.includes(note)) key.dataset.played = "true";
      keyboard.append(key);
    }
    const diagram = element("div", "");
    diagram.append(keyboard, element("p", notes2.join(" \xB7 ")));
    return diagram;
  }
  function guitar(chord) {
    const frets = guitarFrets(chord);
    if (!frets) return element("p", "Diagram unavailable");
    const base = Math.max(1, Math.max(...frets) - 3);
    const grid = element("div", "");
    grid.className = "chord-guitar";
    grid.setAttribute("role", "img");
    grid.setAttribute("aria-label", `Low E to high E: ${frets.map((fret) => fret < 0 ? "muted" : fret || "open").join(", ")}`);
    for (const fret of frets) grid.append(element("span", fret < 0 ? "\xD7" : fret === 0 ? "\u25CB" : "\u2009"));
    for (let row = base; row < base + 4; row++) {
      for (const fret of frets) {
        grid.append(element("span", fret === row ? "\u25CF" : ""));
      }
    }
    const diagram = element("div", "");
    diagram.append(grid, element("p", `Fret ${base} \xB7 E A D G B E`));
    return diagram;
  }
  function mountChords(root) {
    const details2 = root;
    const status2 = root.querySelector("#chords-status");
    const content = root.querySelector("#chords-content");
    const progression = root.querySelector("#chord-progression");
    const current = root.querySelector("#chord-current");
    const next = root.querySelector("#chord-next");
    const diagrams = root.querySelector("#chord-diagrams");
    const retry = root.querySelector("#chords-retry");
    let playback = null;
    let offset = 0;
    let events;
    let buttons = [];
    let selected;
    let highlighted = -1;
    let drawn = "";
    const session = new ChordSession((id) => chrome.runtime.sendMessage({ target: "chords", videoId: id }), render2);
    function showDiagram(chord) {
      if ((chord ?? "") === drawn) return;
      drawn = chord ?? "";
      diagrams.replaceChildren();
      if (chord) diagrams.append(element("h3", chord), element("h4", "Guitar"), guitar(chord), element("h4", "Piano"), piano(chord));
    }
    function render2() {
      const result = session.result;
      const visible = playback && !playback.ad && Number.isFinite(playback.song.duration) && playback.song.duration > 0;
      retry.hidden = !visible || result?.kind !== "unavailable" && result?.kind !== "invalid";
      const message = !playback ? "Select a YouTube watch tab with the MoodShift icon." : playback.ad ? "Chords will resume after the ad." : !visible ? "A finite YouTube video is needed." : !result ? "Finding chords\u2026" : result.kind === "found" ? "Songle \xB7 Estimated chords" : result.kind === "missing" ? "Songle has no chord data for this video." : result.kind === "empty" ? "Songle returned an empty chord progression." : result.kind === "invalid" ? "Could not read the Songle response." : "Songle is unavailable.";
      if (status2.textContent !== message) status2.textContent = message;
      const found = result?.kind === "found" ? result.events : void 0;
      content.hidden = !visible || !found;
      if (found !== events) {
        events = found;
        selected = void 0;
        highlighted = -1;
        buttons = (events ?? []).map(({ chord, startTime }, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = chord;
          button.setAttribute("aria-label", `${chord} at ${startTime.toFixed(2)} seconds`);
          button.addEventListener("click", () => {
            selected = selected === index ? void 0 : index;
            render2();
          });
          return button;
        });
        progression.replaceChildren(...buttons);
      }
      if (!found || !visible || !playback) {
        showDiagram();
        return;
      }
      const position = chordPosition(found, playback, offset);
      if (highlighted !== position.current) {
        buttons[highlighted]?.removeAttribute("aria-current");
        highlighted = position.current;
        const active = buttons[highlighted];
        if (active) {
          active.setAttribute("aria-current", "true");
          centerActive();
        }
      }
      current.textContent = found[position.current]?.chord ?? "\u2014";
      next.textContent = found[position.next]?.chord ?? "\u2014";
      const previous = progression.querySelector('[aria-pressed="true"]');
      previous?.setAttribute("aria-pressed", "false");
      if (selected !== void 0) buttons[selected].setAttribute("aria-pressed", "true");
      showDiagram(found[selected ?? position.current]?.chord);
    }
    function centerActive() {
      const active = buttons[highlighted];
      if (active && selected === void 0 && progression.clientWidth) {
        progression.scrollLeft = active.offsetLeft - (progression.clientWidth - active.clientWidth) / 2;
      }
    }
    new ResizeObserver(centerActive).observe(progression);
    function sync() {
      session.setPlayback(details2.open ? playback : null);
      if (details2.open) render2();
    }
    details2.addEventListener("toggle", sync);
    retry.addEventListener("click", () => session.retry());
    return {
      setPlayback(update, timingOffset) {
        playback = update;
        offset = timingOffset;
        sync();
      }
    };
  }

  // extension/src/shared/messages.ts
  var meterChannel = "moodshift-meter";
  function toWorker(command2) {
    return chrome.runtime.sendMessage({ ...command2, target: "worker" });
  }

  // extension/src/saved-presets.ts
  var savedPresetsKey = "moodshiftSavedPresets";
  function details(name, description) {
    const trimmed = name.trim();
    const note = description?.trim();
    if (!trimmed || trimmed.length > 64 || (note?.length ?? 0) > 200) {
      throw new Error("Enter a name up to 64 characters and an optional description up to 200.");
    }
    return { name: trimmed, description: note || void 0 };
  }
  function validDate(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  }
  function validatePreset(value) {
    const preset = value;
    if (preset?.schemaVersion !== 1 || typeof preset.id !== "string" || !/^[0-9a-f-]{36}$/i.test(preset.id) || !validDate(preset.createdAt) || !validDate(preset.updatedAt) || preset.updatedAt < preset.createdAt || typeof preset.name !== "string" || preset.description !== void 0 && typeof preset.description !== "string" || preset.stemMode !== "full" && preset.stemMode !== "instrumental" && preset.stemMode !== "vocals" || preset.monitor !== "original" && preset.monitor !== "modified") {
      throw new Error("This preset uses an invalid or unsupported format.");
    }
    return {
      schemaVersion: 1,
      id: preset.id,
      createdAt: preset.createdAt,
      updatedAt: preset.updatedAt,
      ...details(preset.name, preset.description),
      audioSettings: clampEffects(preset.audioSettings),
      stemMode: preset.stemMode,
      monitor: preset.monitor
    };
  }
  function storedPreset(value) {
    try {
      return validatePreset(value);
    } catch {
      return void 0;
    }
  }
  function snapshot(capture) {
    if (capture.stem.phase === "loading" || capture.stem.phase === "buffering") {
      throw new Error("Wait for stem selection to finish before saving.");
    }
    return { audioSettings: capture.effects, stemMode: capture.stem.mode, monitor: capture.monitor };
  }
  async function read() {
    const data = (await chrome.storage.local.get(savedPresetsKey))[savedPresetsKey];
    if (data === void 0) return [];
    if (!Array.isArray(data)) throw new Error("Saved presets could not be read.");
    return data;
  }
  async function listPresets() {
    const rows = await read();
    const presets2 = rows.map(storedPreset).filter((preset) => preset !== void 0);
    return { presets: presets2, skipped: rows.length - presets2.length };
  }
  async function editPreset(edit) {
    return navigator.locks.request(savedPresetsKey, async () => {
      const rows = await read();
      const existing = rows.map(storedPreset);
      const index = edit.type === "save" ? rows.length : existing.findIndex((preset2) => preset2?.id === edit.id);
      if (index < 0) throw new Error("This preset is no longer available.");
      if (edit.type === "delete") {
        rows.splice(index, 1);
        await chrome.storage.local.set({ [savedPresetsKey]: rows });
        return;
      }
      const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      const saved = existing[index];
      const preset = validatePreset(edit.type === "save" ? {
        ...snapshot(edit.capture),
        ...details(edit.name, edit.description),
        id: crypto.randomUUID(),
        createdAt: updatedAt,
        updatedAt,
        schemaVersion: 1
      } : {
        ...saved,
        updatedAt: saved && saved.updatedAt > updatedAt ? saved.updatedAt : updatedAt,
        ...edit.type === "rename" ? details(edit.name, edit.description) : snapshot(edit.capture)
      });
      if (existing.some((row) => row && row.id !== preset.id && row.name.toLowerCase() === preset.name.toLowerCase())) {
        throw new Error("A preset already uses this name. Choose another name or update that preset.");
      }
      rows[index] = preset;
      await chrome.storage.local.set({ [savedPresetsKey]: rows });
      return preset.id;
    });
  }
  async function applySavedPreset(input, capture, current, send = toWorker) {
    const preset = validatePreset(input);
    const sessionId = capture.session.id;
    const assertCurrent = () => {
      if (!current()) throw new Error("Preset application was superseded.");
    };
    const requireCapture = (reply) => {
      assertCurrent();
      if (!reply.ok) throw new Error(reply.message);
      if (reply.status.phase !== "capturing" || reply.status.session.id !== sessionId) {
        throw new Error("The selected tab changed during preset application.");
      }
      return reply.status;
    };
    let status2 = requireCapture(await send({
      type: "APPLY_EFFECTS",
      sessionId,
      patch: preset.audioSettings,
      baseRevision: capture.revision
    }));
    const matches = () => effectKeys.every((key) => status2.effects[key] === preset.audioSettings[key]);
    if (!matches()) throw new Error("Audio settings changed during preset application.");
    let limitation;
    if (status2.stem.mode !== preset.stemMode || preset.stemMode !== "full" && status2.stem.phase !== "active") {
      const reply = await send({ type: "SET_STEM", sessionId, mode: preset.stemMode, baseRevision: status2.revision });
      assertCurrent();
      if (reply.ok) status2 = requireCapture(reply);
      else {
        limitation = reply.message;
        status2 = requireCapture(await send({ type: "GET_STATUS" }));
        if (!matches()) throw new Error("Audio settings changed during preset application.");
      }
    }
    if (status2.monitor !== preset.monitor) {
      status2 = requireCapture(await send({ type: "SET_MONITOR", sessionId, monitor: preset.monitor, baseRevision: status2.revision }));
    }
    if (!matches() || status2.monitor !== preset.monitor) throw new Error("Audio settings changed during preset application.");
    if (status2.stem.mode !== preset.stemMode || preset.stemMode !== "full" && status2.stem.phase !== "active") {
      limitation ??= "The requested stem is unavailable.";
    }
    return { status: status2, limitation };
  }

  // extension/src/saved-presets-panel.ts
  function mountSavedPresets(root, readCapture2, restore) {
    const query = (selector) => root.querySelector(selector);
    const select = query("#saved-preset-list");
    const name = query("#saved-preset-name");
    const description = query("#saved-preset-description");
    const save = query("#saved-preset-save");
    const apply = query("#saved-preset-apply");
    const rename = query("#saved-preset-rename");
    const update = query("#saved-preset-update");
    const remove = query("#saved-preset-delete");
    const status2 = query("#saved-preset-status");
    const notice = query("#saved-preset-notice");
    let presets2 = [];
    let captureReady = false;
    let busy = false;
    let needsReload = false;
    let reloadId = 0;
    function controls2() {
      const exists = presets2.some((preset) => preset.id === select.value);
      select.disabled = busy;
      name.disabled = busy;
      description.disabled = busy;
      save.disabled = busy || !captureReady || !name.value.trim();
      apply.disabled = busy || !captureReady || !exists;
      update.disabled = busy || !captureReady || !exists;
      rename.disabled = busy || !exists || !name.value.trim();
      remove.disabled = busy || !exists;
    }
    function fillName() {
      const preset = presets2.find((item) => item.id === select.value);
      name.value = preset?.name ?? "";
      description.value = preset?.description ?? "";
      controls2();
    }
    async function reload(preferred = select.value) {
      const id = ++reloadId;
      const result = await listPresets();
      if (id !== reloadId) return;
      presets2 = result.presets;
      select.replaceChildren(
        new Option(presets2.length ? "Select a saved preset" : "No saved presets", ""),
        ...presets2.map((preset) => new Option(preset.name, preset.id))
      );
      select.value = presets2.some((preset) => preset.id === preferred) ? preferred : "";
      notice.textContent = result.skipped ? "Some stored presets use an invalid or unsupported format." : "";
      controls2();
    }
    async function run(work) {
      if (busy) return;
      busy = true;
      status2.textContent = "";
      controls2();
      try {
        status2.textContent = await work();
      } catch (error) {
        status2.textContent = error instanceof Error ? error.message : "Could not access saved presets.";
      } finally {
        busy = false;
        controls2();
        if (needsReload) {
          needsReload = false;
          refresh2();
        }
      }
    }
    select.addEventListener("change", () => {
      fillName();
      status2.textContent = "";
    });
    name.addEventListener("input", controls2);
    save.addEventListener("click", () => void run(async () => {
      const id = await editPreset({ type: "save", name: name.value, description: description.value, capture: await readCapture2() });
      await reload(id);
      fillName();
      return "Preset saved.";
    }));
    rename.addEventListener("click", () => void run(async () => {
      const id = await editPreset({ type: "rename", id: select.value, name: name.value, description: description.value });
      await reload(id);
      fillName();
      return "Preset details saved.";
    }));
    update.addEventListener("click", () => void run(async () => {
      await editPreset({ type: "update", id: select.value, capture: await readCapture2() });
      await reload();
      return "Preset audio settings updated.";
    }));
    remove.addEventListener("click", () => void run(async () => {
      await editPreset({ type: "delete", id: select.value });
      await reload("");
      fillName();
      return "Preset deleted.";
    }));
    apply.addEventListener("click", () => void run(async () => {
      const { presets: current } = await listPresets();
      const preset = current.find((item) => item.id === select.value);
      if (!preset) throw new Error("This preset is no longer available.");
      status2.textContent = "Applying preset\u2026";
      return restore(preset);
    }));
    const refresh2 = () => void reload().catch(() => {
      notice.textContent = "Could not read saved presets.";
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[savedPresetsKey]) return;
      if (busy) needsReload = true;
      else refresh2();
    });
    refresh2();
    return {
      setCaptureReady(ready) {
        captureReady = ready;
        controls2();
      }
    };
  }

  // extension/src/shared/preferences.ts
  var preferenceLimit = 240;
  var preferenceContextLimit = 4;
  var installationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var preferenceTextPattern = /^[^\u0000-\u001f\u007f]+$/;
  var commonWords = /* @__PURE__ */ new Set(["about", "like", "make", "more", "less", "much", "prefer", "please", "some", "song", "sound", "that", "this", "want", "with", "would"]);
  function terms(text) {
    return [...new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? [])].filter((word) => !commonWords.has(word));
  }
  function relevantPreferences(prompt, newestFirst) {
    const keywords = new Set(terms(prompt));
    const ranked = newestFirst.map((text) => ({ text, matches: terms(text).filter((word) => keywords.has(word)).length })).sort((a, b) => b.matches - a.matches);
    const relevant = ranked[0]?.matches ? ranked.filter((item) => item.matches > 0) : ranked;
    return relevant.slice(0, preferenceContextLimit).map((item) => item.text);
  }
  function explicitPreference(prompt) {
    const text = prompt.trim();
    if (/^remember that\s+\S/i.test(text)) return text.replace(/^remember that\s+/i, "");
    if (/^i usually prefer\s+\S/i.test(text)) return text;
  }

  // extension/src/shared/deployment.ts
  var demoCodePattern = /^[A-Za-z0-9_-]{32,128}$/;
  var localStemWsUrl = "ws://127.0.0.1:8788";
  var dnsName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  function endpoint(raw, name, protocol, local, forStems) {
    const invalid = new Error(`${name} must be a ${protocol} endpoint on ${local ? "127.0.0.1" : "a specific public DNS hostname"}.`);
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw invalid;
    }
    if (raw !== raw.trim() || !raw.startsWith(protocol + "//") || url.protocol !== protocol || url.username || url.password || /[\s?#\\@]/.test(raw) || url.pathname !== "/" && !(forStems && !local && url.pathname === "/stem")) throw invalid;
    if (raw !== url.origin && raw !== url.href) throw invalid;
    if (local) {
      if (url.hostname !== "127.0.0.1" || (forStems ? Number(url.port) < 1024 : url.port !== "8787")) throw invalid;
    } else if (url.port || !dnsName.test(url.hostname) || /\.(local|localhost|internal)$/.test(url.hostname)) {
      throw invalid;
    }
    return url;
  }
  function deploymentFromEnv(mode, env) {
    if (mode !== "development" && mode !== "production") throw new Error("Build mode must be development or production.");
    const local = mode === "development";
    const api = endpoint(
      env.API_BASE_URL ?? (local ? "http://127.0.0.1:8787" : ""),
      "API_BASE_URL",
      local ? "http:" : "https:",
      local,
      false
    );
    const stemUrl = env.STEM_WS_URL ?? (local ? localStemWsUrl : "");
    const localStem = local || stemUrl === localStemWsUrl || stemUrl === localStemWsUrl + "/";
    const stems = endpoint(stemUrl, "STEM_WS_URL", localStem ? "ws:" : "wss:", localStem, true);
    const delay = env.STEM_DELAY_SECONDS === void 0 ? local ? 2.8 : 4.5 : Number(env.STEM_DELAY_SECONDS);
    if (!Number.isFinite(delay) || delay < 2.8 || delay > 8 || Math.round(delay * 10) / 10 !== delay) {
      throw new Error("STEM_DELAY_SECONDS must be 2.8 to 8.0 seconds in tenths.");
    }
    return {
      mode,
      apiBaseUrl: api.origin,
      stemWsUrl: stems.origin + (stems.pathname === "/" ? "" : stems.pathname),
      stemDelaySeconds: delay
    };
  }
  var deployment = typeof define_MOODSHIFT_DEPLOYMENT_default === "undefined" ? deploymentFromEnv("development", {}) : define_MOODSHIFT_DEPLOYMENT_default;
  function usesCloudStems(config = deployment) {
    return config.stemWsUrl.startsWith("wss://");
  }

  // extension/src/api-client.ts
  var demoCodeKey = "moodshiftDemoAccessCode";
  async function cloudDemoCode(config = deployment) {
    if (config.mode !== "production") return;
    const code = (await chrome.storage.local.get(demoCodeKey))[demoCodeKey];
    if (typeof code !== "string" || !demoCodePattern.test(code)) {
      throw new Error("Enter the private demo access code in MoodShift settings.");
    }
    return code;
  }
  async function apiRequest(path, body, signal, config = deployment) {
    const code = await cloudDemoCode(config);
    const url = new URL(path, config.apiBaseUrl);
    if (code && url.protocol !== "https:") throw new Error("Private demo codes require HTTPS.");
    const headers = { "Content-Type": "application/json" };
    if (code) headers.Authorization = `Bearer ${code}`;
    return fetch(url.href, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
      credentials: "omit",
      redirect: "error"
    });
  }
  async function apiErrorDetail(response, config = deployment) {
    const body = await response.json().catch(() => void 0);
    if (typeof body?.error === "string") return body.error.slice(0, 240);
    if (config.mode === "development") return `Check the local proxy (HTTP ${response.status}).`;
    if (response.status === 401 && body?.protection != null) {
      return "Vercel Deployment Protection blocked the request. Use the production domain where /health works without a Vercel login.";
    }
    return `Cloud API returned HTTP ${response.status}. Check /health on the configured production domain.`;
  }

  // extension/src/local-preferences.ts
  var localPreferencesKey = "moodshiftSoundPreferences";
  var maxPreferences = 30;
  function parseLocalPreferences(value) {
    if (value === void 0) return [];
    if (!Array.isArray(value) || value.length > maxPreferences || !value.every((row) => typeof row?.id === "string" && installationIdPattern.test(row.id) && typeof row.text === "string" && row.text.length <= preferenceLimit && preferenceTextPattern.test(row.text) && row.text.trim() === row.text)) {
      throw new Error("Could not read saved local preferences.");
    }
    return value;
  }
  function soundPreferenceText(text) {
    const trimmed = text.trim();
    if (!preferenceTextPattern.test(trimmed) || trimmed.length > preferenceLimit) {
      throw new Error(`Enter a single sound preference up to ${preferenceLimit} characters.`);
    }
    return trimmed;
  }
  async function loadLocalPreferences() {
    return parseLocalPreferences((await chrome.storage.local.get(localPreferencesKey))[localPreferencesKey]);
  }
  async function editLocalPreference(edit) {
    return navigator.locks.request(localPreferencesKey, async () => {
      const preferences = await loadLocalPreferences();
      const index = edit.id === void 0 ? -1 : preferences.findIndex((row) => row.id === edit.id);
      if (edit.id !== void 0 && index < 0) throw new Error("This preference is no longer available.");
      if ("remove" in edit) preferences.splice(index, 1);
      else {
        const text = soundPreferenceText(edit.text);
        if (preferences.some((row) => row.id !== edit.id && row.text.toLowerCase() === text.toLowerCase())) {
          throw new Error("This sound preference is already saved.");
        }
        if (index >= 0) preferences.splice(index, 1);
        if (preferences.length >= maxPreferences) throw new Error(`Delete a preference before saving more than ${maxPreferences}.`);
        preferences.unshift({ id: edit.id ?? crypto.randomUUID(), text });
      }
      await chrome.storage.local.set({ [localPreferencesKey]: preferences });
      return preferences;
    });
  }

  // extension/src/personalization-panel.ts
  var storageKey = "moodshiftPersonalization";
  function parseSettings(value) {
    const settings = value;
    if (typeof settings?.installationId === "string" && installationIdPattern.test(settings.installationId)) {
      return {
        installationId: settings.installationId,
        enabled: settings.enabled === true,
        useSupermemory: typeof settings.useSupermemory === "boolean" ? settings.useSupermemory : settings.enabled === true
      };
    }
  }
  async function updateSettings(changes = {}) {
    return navigator.locks.request(storageKey, async () => {
      const stored = parseSettings((await chrome.storage.local.get(storageKey))[storageKey]);
      const next = { installationId: crypto.randomUUID(), enabled: false, useSupermemory: false, ...stored, ...changes };
      if (stored && next.enabled === stored.enabled && next.useSupermemory === stored.useSupermemory) return stored;
      await chrome.storage.local.set({ [storageKey]: next });
      return next;
    });
  }
  function mountPersonalization(root, onChange) {
    const query = (selector) => root.querySelector(selector);
    const enable = query("#memory-enabled");
    const form2 = query("#memory-form");
    const field = query("#memory-preference");
    const save = query("#memory-save");
    const cancel = query("#memory-cancel-edit");
    const localList = query("#memory-local-list");
    const remoteEnabled = query("#memory-remote-enabled");
    const remoteSave = query("#memory-remote-save");
    const remoteField = query("#memory-remote-preference");
    const remoteForm = query("#memory-remote-form");
    const view = query("#memory-view");
    const clear = query("#memory-clear");
    const list = query("#memory-list");
    const state = query("#memory-status");
    const remoteState = query("#memory-remote-status");
    let settings;
    let ready = false;
    let busy = false;
    let clearing = false;
    let preferences = [];
    let editingId;
    function controls2() {
      enable.disabled = !ready || busy;
      field.disabled = !ready || busy;
      save.disabled = field.disabled || !field.value.trim();
      cancel.disabled = busy;
      remoteEnabled.disabled = !ready || busy;
      remoteField.disabled = !settings?.enabled || !settings.useSupermemory || busy;
      remoteSave.disabled = remoteField.disabled || !remoteField.value.trim();
      view.disabled = !ready || busy;
      clear.disabled = !ready || busy;
      for (const button of localList.querySelectorAll("button")) button.disabled = busy;
    }
    function setSettings(next) {
      const changed = !!settings?.enabled !== !!next?.enabled || next?.enabled && (settings?.installationId !== next.installationId || settings.useSupermemory !== next.useSupermemory);
      settings = next;
      ready = true;
      enable.checked = next?.enabled === true;
      remoteEnabled.checked = next?.useSupermemory === true;
      controls2();
      if (changed) onChange();
    }
    function setEditing(id, text = "") {
      editingId = id;
      field.value = text;
      save.textContent = id ? "Save changes" : "Save locally";
      cancel.hidden = !id;
      controls2();
    }
    function showLocal(next) {
      if (JSON.stringify(preferences) === JSON.stringify(next)) return;
      preferences = next;
      localList.replaceChildren(...next.map(({ id, text }) => {
        const row = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = text;
        const actions = document.createElement("div");
        actions.className = "saved-preset-actions";
        for (const action of ["Edit", "Delete"]) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = action;
          button.setAttribute("aria-label", `${action} preference: ${text}`);
          button.addEventListener("click", () => {
            if (action === "Edit") {
              setEditing(id, text);
              field.focus();
            } else {
              void run(async () => {
                showLocal(await editLocalPreference({ id, remove: true }));
                if (editingId === id) setEditing();
                return "Local preference deleted.";
              }).then(() => field.focus());
            }
          });
          actions.append(button);
        }
        row.append(label, actions);
        return row;
      }));
      localList.hidden = !next.length;
      controls2();
      if (settings?.enabled) onChange();
    }
    function showPreferences(preferences2) {
      list.replaceChildren(...preferences2.map((text) => {
        const node = document.createElement("li");
        node.textContent = text;
        return node;
      }));
      list.hidden = !preferences2.length;
    }
    async function run(work, status2 = state) {
      if (busy) return "Wait for the current preference action to finish.";
      busy = true;
      controls2();
      status2.textContent = "Working\u2026";
      try {
        const message = await work();
        status2.textContent = message;
        return message;
      } catch (error) {
        const message = error instanceof TypeError && status2 === remoteState ? deployment.mode === "development" ? "Could not reach the local proxy." : "Could not reach the configured cloud API." : error instanceof Error ? error.message : "Could not complete the preference action.";
        status2.textContent = message;
        return message;
      } finally {
        busy = false;
        controls2();
      }
    }
    async function remote(action) {
      const latest = await updateSettings();
      if (action.action === "remember" && (!latest.enabled || !latest.useSupermemory)) {
        throw new Error("Enable personalization and Supermemory to save a cloud preference.");
      }
      const response = await apiRequest("/api/memory", { ...action, installationId: latest.installationId }, AbortSignal.timeout(6500));
      if (!response.ok) throw new Error(await apiErrorDetail(response));
      return response.json();
    }
    function remember(preference, id) {
      return run(async () => {
        showLocal(await editLocalPreference({ id, text: preference }));
        if (editingId === id && field.value.trim() === preference.trim()) setEditing();
        return id ? "Local preference updated." : "Preference saved on this device.";
      });
    }
    enable.addEventListener("change", () => {
      const enabled = enable.checked;
      if (!enabled && settings) setSettings({ ...settings, enabled: false });
      void run(async () => {
        try {
          setSettings(await updateSettings({ enabled }));
        } catch {
          setSettings(parseSettings((await chrome.storage.local.get(storageKey))[storageKey]));
          throw new Error("Could not save the personalization setting.");
        }
        return enabled ? "Personalization enabled." : "Personalization disabled. Saved preferences are kept.";
      });
    });
    field.addEventListener("input", controls2);
    form2.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!save.disabled) void remember(field.value, editingId);
    });
    cancel.addEventListener("click", () => {
      setEditing();
      field.focus();
    });
    remoteEnabled.addEventListener("change", () => {
      const useSupermemory = remoteEnabled.checked;
      void run(async () => {
        try {
          setSettings(await updateSettings({ useSupermemory }));
        } catch (error) {
          remoteEnabled.checked = settings?.useSupermemory === true;
          throw error;
        }
        return useSupermemory ? "Supermemory enabled for compatible backends." : "Supermemory disabled. Remote preferences are kept.";
      }, remoteState);
    });
    remoteField.addEventListener("input", controls2);
    remoteForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (remoteSave.disabled) return;
      void run(async () => {
        const text = soundPreferenceText(remoteField.value);
        const reply = await remote({ action: "remember", preference: text, enabled: true });
        if (reply?.remembered !== true) throw new Error("Supermemory did not confirm the preference.");
        remoteField.value = "";
        return reply.processing ? "Preference sent to Supermemory. Indexing may take a moment." : "Preference saved to Supermemory.";
      }, remoteState);
    });
    view.addEventListener("click", () => void run(async () => {
      showPreferences([]);
      const reply = await remote({ action: "view" });
      if (!Array.isArray(reply?.preferences) || !reply.preferences.every((text) => typeof text === "string")) {
        throw new Error("Supermemory returned an unreadable preference list.");
      }
      showPreferences(reply.preferences.slice(0, 30));
      return reply.hasMore ? "Showing up to 30 indexed preferences." : reply.preferences.length ? "Preferences from Supermemory." : "No indexed preferences found.";
    }, remoteState));
    clear.addEventListener("click", () => void run(async () => {
      clearing = true;
      onChange();
      try {
        const reply = await remote({ action: "clear" });
        if (reply?.cleared !== true) throw new Error("Supermemory did not confirm deletion.");
        showPreferences([]);
        return "Supermemory confirmed remote preferences were cleared.";
      } finally {
        clearing = false;
      }
    }, remoteState));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[storageKey]) setSettings(parseSettings(changes[storageKey].newValue));
      if (changes[localPreferencesKey]) {
        try {
          showLocal(parseLocalPreferences(changes[localPreferencesKey].newValue));
        } catch {
          state.textContent = "Could not read saved local preferences.";
        }
      }
    });
    void chrome.storage.local.get(storageKey).then((values) => setSettings(parseSettings(values[storageKey]))).catch(() => {
      state.textContent = "Could not read personalization settings.";
    });
    void loadLocalPreferences().then(showLocal).catch(() => {
      state.textContent = "Could not read saved local preferences.";
    });
    return {
      remember,
      context(prompt) {
        if (!settings?.enabled) return {};
        const localPreferences = relevantPreferences(prompt, preferences.map((row) => row.text));
        return {
          localPreferences: localPreferences.length ? localPreferences : void 0,
          personalization: settings.useSupermemory && !clearing ? { enabled: true, installationId: settings.installationId } : void 0
        };
      }
    };
  }

  // extension/src/panel-tabs.ts
  var tabKey = "moodshiftPanelTab";
  function mountPanelTabs() {
    const names = ["home", "advanced"];
    const tabs = names.map((name) => document.querySelector(`#${name}-tab`));
    const panels = names.map((name) => document.querySelector(`#${name}-panel`));
    const sharedControls = [
      { element: document.querySelector("#preset-library"), slots: names.map((name) => document.querySelector(`#${name}-presets`)) },
      { element: document.querySelector("#stem-controls"), slots: names.map((name) => document.querySelector(`#${name}-stems`)) }
    ];
    function select(index, focus = false) {
      tabs.forEach((tab, current) => {
        const selected = current === index;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        panels[current].hidden = !selected;
      });
      for (const { element: element2, slots } of sharedControls) {
        if (element2.parentElement !== slots[index]) slots[index].append(element2);
      }
      localStorage.setItem(tabKey, names[index]);
      if (focus) tabs[index].focus();
    }
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => select(index));
      tab.addEventListener("keydown", (event) => {
        const next = { ArrowLeft: 1 - index, ArrowRight: 1 - index, Home: 0, End: 1 }[event.key];
        if (next === void 0) return;
        event.preventDefault();
        select(next, true);
      });
    });
    select(localStorage.getItem(tabKey) === "advanced" ? 1 : 0);
  }

  // extension/src/shared/types.ts
  var stemModes = ["full", "instrumental", "vocals"];
  var silentFeatures = Object.freeze({
    rms: 0,
    bassEnergy: 0,
    midEnergy: 0,
    trebleEnergy: 0,
    brightness: 0,
    isSilent: true
  });
  function directStemIntent(prompt) {
    const phrase = prompt.trim().toLowerCase().replace(/[.!?]+$/, "").replaceAll("-only", " only").replace(/^please\s+/, "").replace(/^(?:just\s+)?(?:play|give me)\s+/, "").replace(/^(?:just|only)\s+/, "").replace(/^the\s+/, "");
    if (/^(?:instrumental(?: only)?|remove (?:the )?vocals)$/.test(phrase)) return "instrumental";
    if (/^(?:vocals(?: only)?|isolate (?:the )?vocals)$/.test(phrase)) return "vocals";
    if (/^(?:back to (?:the )?)?full (?:mix|song)$/.test(phrase)) return "full";
    if (/^(?:underlying )?(?:beat|drums|bass)(?: only)?$/.test(phrase)) return "unsupported";
  }
  function plainText(value, max) {
    if (typeof value !== "string" || value.length > max) throw new Error("Invalid interpretation text.");
    const text = value.replace(/[\p{Cc}\p{Cf}<>]/gu, " ").replace(/\s+/g, " ").trim();
    if (!text) throw new Error("Empty interpretation text.");
    return text;
  }
  function parseInterpretation(input, current) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Invalid interpretation response.");
    }
    const { mode, patch: rawPatch, summary, unsupported, stemMode } = input;
    if (Object.keys(input).some((key) => !["mode", "patch", "summary", "unsupported", "stemMode"].includes(key)) || mode !== "patch" && mode !== "reset" && mode !== "unsupported") {
      throw new Error("Invalid interpretation mode or fields.");
    }
    if (stemMode !== void 0 && (mode === "unsupported" || !stemModes.includes(stemMode))) {
      throw new Error("Invalid stem request.");
    }
    if (!Array.isArray(unsupported) || unsupported.length > 5) throw new Error("Invalid unsupported operations.");
    const notices = unsupported.map((item) => plainText(item, 100));
    const validated = clampPatch(rawPatch);
    if (mode !== "patch" && Object.keys(validated).length) throw new Error("Unexpected patch for this mode.");
    if (mode === "unsupported" && notices.length === 0) throw new Error("Missing unsupported operation.");
    const patch = {};
    for (const key of effectKeys) {
      const value = validated[key];
      if (value !== void 0 && value !== current[key]) patch[key] = value;
    }
    const result = { mode, patch, summary: plainText(summary, 240), unsupported: notices };
    if (stemMode !== void 0) result.stemMode = stemMode;
    return result;
  }

  // extension/src/sidepanel.ts
  mountPanelTabs();
  var statusLabel = document.querySelector("#status");
  var chords = mountChords(document.querySelector("#chords"));
  var lyrics = mountLyrics(document.querySelector("#lyrics"), chords.setPlayback);
  var stopButton = document.querySelector("#stop");
  var meter = document.querySelector("#meter");
  var inputStatus = document.querySelector("#input-status");
  var feedback = document.querySelector("#feedback");
  var controls = document.querySelector("#controls");
  var presetGroup = document.querySelector("#presets");
  var monitorButtons = [...document.querySelectorAll("[data-mode]")];
  var stemButtons = [...document.querySelectorAll("[data-stem]")];
  var stemLabel = document.querySelector("#stem-status");
  document.querySelector("#stem-buffer").textContent = `Worker \xB7 ${usesCloudStems() ? "Cloud" : "This device"} \xB7 ${deployment.stemDelaySeconds}s playback buffer`;
  var form = document.querySelector("#interpret");
  var promptInput = document.querySelector("#prompt");
  var applyButton = document.querySelector("#apply");
  var status = { phase: "ready" };
  var refreshId = 0;
  var commandId = 0;
  var stopping = false;
  var queuedEdits = {};
  var editTimer;
  var commandPending = false;
  var presetApplying = false;
  var interpretation;
  var savedPresets = mountSavedPresets(document.querySelector("#saved-presets"), readCapture, restorePreset);
  var personalization = mountPersonalization(document.querySelector("#personalization"), () => {
    if (interpretation) {
      cancelInterpretation();
      feedback.textContent = "Personalization changed. Submit the prompt again.";
    }
  });
  if (deployment.mode === "production") {
    document.querySelector("#cloud-settings").hidden = false;
    document.querySelector("#cloud-stem-note").hidden = !usesCloudStems();
    const settings = document.querySelector("#cloud-code-form");
    const field = document.querySelector("#cloud-code");
    const result = document.querySelector("#cloud-code-status");
    settings.addEventListener("submit", async (event) => {
      event.preventDefault();
      const code = field.value.trim();
      if (code && !demoCodePattern.test(code)) {
        result.textContent = "Enter a 32\u2013128 character code using letters, numbers, hyphens, or underscores.";
        return;
      }
      try {
        if (code) await chrome.storage.local.set({ [demoCodeKey]: code });
        else await chrome.storage.local.remove(demoCodeKey);
        cancelInterpretation();
        field.value = "";
        result.textContent = code ? "Private demo code saved." : "Private demo code cleared.";
      } catch {
        result.textContent = "Could not update the private demo code.";
      }
    });
  }
  function updateApply() {
    applyButton.disabled = status.phase !== "capturing" || stopping || commandPending || interpretation !== void 0 || Object.keys(queuedEdits).length > 0 || !promptInput.value.trim();
    savedPresets.setCaptureReady(status.phase === "capturing" && !stopping && !commandPending && !interpretation && !Object.keys(queuedEdits).length && status.stem.phase !== "loading" && status.stem.phase !== "buffering");
  }
  function cancelInterpretation() {
    interpretation?.controller.abort();
    interpretation = void 0;
    updateApply();
  }
  function renderMeter(features) {
    const capture = status.phase === "capturing" ? status : void 0;
    meter.value = capture && !capture.session.muted && !capture.outputPaused ? Math.sqrt(features.rms) : 0;
    inputStatus.textContent = capture?.outputPaused ? "Audio output paused. Click MoodShift on the source tab to retry." : capture?.session.muted ? "Source tab muted." : capture && features.isSilent ? "Paused or silent input." : "";
  }
  function displayValue(value, unit) {
    if (unit === "%") return `${Math.round(value * 100)}%`;
    return `${Number(value.toFixed(1))} ${unit}`;
  }
  var sliders = effectKeys.map((key) => {
    const spec = effectSpecs[key];
    const label = document.createElement("label");
    const text = document.createElement("span");
    const value = document.createElement("output");
    const input = document.createElement("input");
    text.textContent = spec.label;
    input.id = `effect-${key}`;
    value.htmlFor = input.id;
    input.type = "range";
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    label.append(text, value, input);
    controls.append(label);
    input.addEventListener("input", () => {
      cancelInterpretation();
      queuedEdits[key] = input.valueAsNumber;
      updateApply();
      value.textContent = displayValue(input.valueAsNumber, spec.unit);
      clearTimeout(editTimer);
      editTimer = setTimeout(flushEdits, 45);
    });
    input.addEventListener("change", flushEdits);
    return { key, input, value };
  });
  for (const [name, patch] of [...Object.entries(presets), ["Reset", neutralEffects]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    button.addEventListener("click", () => {
      clearEdits();
      applyLocal(patch);
    });
    presetGroup.append(button);
  }
  function clearEdits() {
    clearTimeout(editTimer);
    queuedEdits = {};
  }
  function flushEdits() {
    const patch = queuedEdits;
    clearEdits();
    if (Object.keys(patch).length > 0) applyLocal(patch);
  }
  function applyLocal(patch) {
    cancelInterpretation();
    if (status.phase === "capturing") void command({ type: "APPLY_EFFECTS", sessionId: status.session.id, patch });
  }
  for (const button of monitorButtons) {
    button.addEventListener("click", () => {
      if (status.phase !== "capturing") return;
      const monitor = button.dataset.mode;
      void command({ type: "SET_MONITOR", sessionId: status.session.id, monitor });
    });
  }
  for (const button of stemButtons) {
    button.addEventListener("click", () => {
      if (status.phase !== "capturing") return;
      cancelInterpretation();
      void command({ type: "SET_STEM", mode: button.dataset.stem, sessionId: status.session.id });
    });
  }
  function render(next) {
    const previousId = status.phase === "capturing" ? status.session.id : void 0;
    const nextId = next.phase === "capturing" ? next.session.id : void 0;
    if (previousId !== nextId) {
      clearEdits();
      commandId++;
      commandPending = false;
      presetApplying = false;
      cancelInterpretation();
      stopping = false;
      feedback.textContent = "";
    }
    status = next;
    lyrics.setSource(next.phase === "capturing" ? next.session : void 0);
    updateApply();
    stopButton.disabled = next.phase !== "capturing" || stopping;
    const enabled = !stopButton.disabled && !presetApplying;
    controls.disabled = !enabled;
    for (const button of presetGroup.querySelectorAll("button")) button.disabled = !enabled;
    for (const button of monitorButtons) {
      button.disabled = !enabled;
      button.setAttribute("aria-pressed", String(button.dataset.mode === (next.phase === "capturing" ? next.monitor : "modified")));
    }
    const stem = next.phase === "capturing" ? next.stem : void 0;
    for (const button of stemButtons) {
      button.disabled = !enabled;
      button.setAttribute("aria-pressed", String(button.dataset.stem === (stem?.mode ?? "full")));
    }
    switch (stem?.phase) {
      case "loading":
        stemLabel.textContent = "Connecting to the local model\u2026";
        break;
      case "buffering":
        stemLabel.textContent = `Buffering stem audio \xB7 ${deployment.stemDelaySeconds} s delay\u2026`;
        break;
      case "active":
        stemLabel.textContent = next.phase === "capturing" && next.monitor === "original" ? "Original \xB7 Live mix. Modified resumes the delayed stem." : `Active \xB7 Audio trails video by about ${deployment.stemDelaySeconds} s.`;
        break;
      case "unavailable":
        stemLabel.textContent = `Unavailable \xB7 ${stem.message}`;
        break;
      default:
        stemLabel.textContent = "";
    }
    const effects = next.phase === "capturing" ? next.effects : neutralEffects;
    for (const { key, input, value } of sliders) {
      const setting = queuedEdits[key] ?? effects[key];
      input.value = String(setting);
      value.textContent = displayValue(setting, effectSpecs[key].unit);
    }
    renderMeter(next.phase === "capturing" ? next.features : silentFeatures);
    switch (next.phase) {
      case "ready":
        statusLabel.textContent = "Ready \xB7 Click MoodShift on the tab you want to hear.";
        break;
      case "starting":
        statusLabel.textContent = `Capturing\u2026 \xB7 ${next.source.title}`;
        break;
      case "capturing":
        statusLabel.textContent = `Listening to this tab \xB7 ${next.session.title}`;
        break;
      case "error":
        statusLabel.textContent = `Error \xB7 ${next.message}`;
        break;
    }
  }
  async function readCapture() {
    if (status.phase !== "capturing" || commandPending || stopping || interpretation || Object.keys(queuedEdits).length) {
      throw new Error("Wait for the current audio change to finish.");
    }
    const sessionId = status.session.id;
    const reply = await toWorker({ type: "GET_STATUS" });
    if (!reply.ok || reply.status.phase !== "capturing" || reply.status.session.id !== sessionId || status.phase !== "capturing" || status.session.id !== sessionId || commandPending || stopping || interpretation || Object.keys(queuedEdits).length) {
      throw new Error("Select a tab and wait for the current audio change to finish.");
    }
    return reply.status;
  }
  async function restorePreset(preset) {
    const capture = await readCapture();
    const id = ++commandId;
    commandPending = true;
    presetApplying = true;
    refreshId++;
    render(status);
    const current = () => id === commandId;
    try {
      const result = await applySavedPreset(preset, capture, current);
      if (!current()) throw new Error("Preset application was superseded.");
      refreshId++;
      render(result.status);
      return result.limitation ? `Effects and monitor applied. Stem unavailable \xB7 ${result.limitation}` : `Applied \u2713 \xB7 ${preset.name}`;
    } finally {
      if (current()) {
        presetApplying = false;
        commandPending = false;
        render(status);
        void refresh();
      }
    }
  }
  async function command(message, detail = "", stemMode) {
    const id = ++commandId;
    commandPending = true;
    updateApply();
    refreshId++;
    if (message.type === "APPLY_EFFECTS" || message.type === "SET_STEM") feedback.textContent = "Applying\u2026";
    try {
      let reply = await toWorker(message);
      if (id !== commandId) return;
      if (!reply.ok) throw new Error(reply.message);
      if (message.type === "APPLY_EFFECTS" && stemMode && reply.status.phase === "capturing") {
        reply = await toWorker({
          type: "SET_STEM",
          mode: stemMode,
          sessionId: message.sessionId,
          baseRevision: reply.status.revision
        });
        if (id !== commandId) return;
        if (!reply.ok) {
          feedback.textContent = `Effects updated. Stem unavailable \xB7 ${reply.message}`;
          void refresh();
          return;
        }
      }
      refreshId++;
      render(reply.status);
      if ((message.type === "APPLY_EFFECTS" || message.type === "SET_STEM") && reply.status.phase === "capturing" && reply.status.session.id === message.sessionId) {
        feedback.textContent = detail ? `Applied \u2713 \xB7 ${detail}` : "Applied \u2713";
      }
    } catch (error) {
      if (id !== commandId) return;
      stopping = false;
      feedback.textContent = `Error \xB7 ${error instanceof Error ? error.message : String(error)}`;
      void refresh();
    } finally {
      if (id === commandId) {
        commandPending = false;
        updateApply();
      }
    }
  }
  async function refresh() {
    const id = ++refreshId;
    try {
      const reply = await toWorker({ type: "GET_STATUS" });
      if (id === refreshId) render(reply.ok ? reply.status : { phase: "error", message: reply.message });
    } catch {
      if (id === refreshId) render({ phase: "error", message: "Reopen MoodShift to reconnect." });
    }
  }
  stopButton.addEventListener("click", () => {
    if (status.phase !== "capturing") return;
    clearEdits();
    cancelInterpretation();
    stopping = true;
    presetApplying = false;
    render(status);
    void command({ type: "STOP", sessionId: status.session.id });
  });
  promptInput.addEventListener("input", updateApply);
  promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  var GeminiUnavailable = class extends Error {
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = promptInput.value.trim();
    if (applyButton.disabled || !prompt || prompt.length > 500 || status.phase !== "capturing") return;
    const preference = explicitPreference(prompt);
    if (preference) {
      const message = await personalization.remember(preference);
      if (promptInput.value.trim() === prompt && !interpretation) feedback.textContent = message;
      return;
    }
    const { session, effects, revision, features, outputPaused } = status;
    const direct = directStemIntent(prompt);
    if (direct === "unsupported") {
      feedback.textContent = "Unsupported \xB7 Beat, drum and bass isolation require separate stems.";
      return;
    }
    if (direct) {
      await command({ type: "SET_STEM", sessionId: session.id, mode: direct });
      return;
    }
    const request = { id: crypto.randomUUID(), controller: new AbortController() };
    interpretation = request;
    updateApply();
    feedback.textContent = "Interpreting\u2026";
    const deadline = setTimeout(() => request.controller.abort(), 15e3);
    try {
      const response = await apiRequest("/api/interpret", {
        prompt,
        currentEffects: effects,
        audioFeatures: session.muted || outputPaused ? silentFeatures : features,
        ...personalization.context(prompt)
      }, request.controller.signal);
      if (!response.ok) {
        const detail2 = await apiErrorDetail(response);
        if (response.status === 504) throw new Error("Gemini timed out. Try again.");
        if (response.status >= 500 || response.status === 429) throw new GeminiUnavailable(detail2);
        throw new Error(detail2);
      }
      const body = await response.json();
      if (interpretation?.id !== request.id) return;
      const result = parseInterpretation(body, effects);
      const detail = [result.summary, result.unsupported.length ? `Unsupported \xB7 ${result.unsupported.join(", ")}` : ""].filter(Boolean).join(" ");
      if (result.mode === "unsupported") {
        feedback.textContent = detail;
        return;
      }
      if (result.mode === "patch" && Object.keys(result.patch).length === 0) {
        if (result.stemMode) {
          await command({ type: "SET_STEM", sessionId: session.id, mode: result.stemMode, baseRevision: revision }, detail);
        } else feedback.textContent = detail;
        return;
      }
      await command({
        type: "APPLY_EFFECTS",
        sessionId: session.id,
        baseRevision: revision,
        patch: result.mode === "reset" ? neutralEffects : result.patch
      }, detail, result.stemMode);
    } catch (error) {
      if (interpretation?.id !== request.id) return;
      if (request.controller.signal.aborted) {
        feedback.textContent = "Error \xB7 Gemini timed out. Try again.";
      } else if (error instanceof TypeError || error instanceof GeminiUnavailable) {
        const detail = error instanceof GeminiUnavailable ? error.message : deployment.mode === "development" ? "Start the local proxy with npm run dev:server." : "Check the configured cloud API connection.";
        feedback.textContent = `Offline \xB7 Gemini unavailable. Presets and manual controls still work. ${detail}`;
      } else {
        feedback.textContent = `Error \xB7 ${error instanceof Error ? error.message : "Invalid Gemini reply."}`;
      }
    } finally {
      clearTimeout(deadline);
      if (interpretation?.id === request.id) interpretation = void 0;
      updateApply();
    }
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message.target === "panel" && message.type === "STATUS_CHANGED") void refresh();
  });
  var meterUpdates = new BroadcastChannel(meterChannel);
  meterUpdates.addEventListener("message", (event) => {
    if (status.phase === "capturing" && status.session.id === event.data.sessionId) {
      status.features = event.data.features;
      renderMeter(event.data.features);
    }
  });
  void refresh();
})();
