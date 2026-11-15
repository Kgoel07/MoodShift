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

  // extension/src/shared/mood-scenes.ts
  var mix = (patch) => Object.freeze({ ...neutralEffects, ...patch });
  var moodScenes = [
    {
      id: "midnight-drive",
      name: "Midnight Drive",
      emoji: "\u{1F319}",
      subtitle: "Deep & atmospheric",
      effects: mix({ bassDb: 4.3, trebleDb: -2.4, reverbMix: 0.17, outputGainDb: -1.5 }),
      stemMode: "full"
    },
    {
      id: "deep-focus",
      name: "Deep Focus",
      emoji: "\u{1F4DA}",
      subtitle: "Calm & balanced",
      effects: mix({ bassDb: 0.3, trebleDb: -1.4, reverbMix: 0.02 }),
      stemMode: "full"
    },
    {
      id: "karaoke-night",
      name: "Karaoke Night",
      emoji: "\u{1F3A4}",
      subtitle: "Your turn to sing",
      effects: mix({ bassDb: -0.7, trebleDb: 1, highpassHz: 45, outputGainDb: -0.5 }),
      stemMode: "instrumental"
    },
    {
      id: "energy-rush",
      name: "Energy Rush",
      emoji: "\u26A1",
      subtitle: "Punchy & powerful",
      effects: mix({ bassDb: 4, trebleDb: 3, highpassHz: 30, reverbMix: 0.02, outputGainDb: -2 }),
      stemMode: "full"
    },
    {
      id: "rainy-evening",
      name: "Rainy Evening",
      emoji: "\u{1F327}\uFE0F",
      subtitle: "Warm & mellow",
      effects: mix({ bassDb: 1.8, trebleDb: -3.3, reverbMix: 0.27, outputGainDb: -0.8 }),
      stemMode: "full"
    },
    {
      id: "cloud-nine",
      name: "Cloud Nine",
      emoji: "\u2601\uFE0F",
      subtitle: "Dreamy & spacious",
      effects: mix({ bassDb: -0.6, trebleDb: -2.3, reverbMix: 0.4, outputGainDb: -1 }),
      stemMode: "full"
    }
  ];
  function activeMoodScene(status2, pendingEdits) {
    if (status2.phase !== "capturing" || status2.monitor !== "modified") return;
    return moodScenes.find((scene) => status2.stem.mode === scene.stemMode && (scene.stemMode === "full" || status2.stem.phase === "active") && effectKeys.every((key) => (pendingEdits[key] ?? status2.effects[key]) === scene.effects[key]));
  }

  // extension/src/shared/lyrics.ts
  function playbackKey(playback) {
    if (!playback) return;
    return "videoId" in playback ? playback.videoId : playback.trackId;
  }
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
    return !!trackKey(query.title) && !!trackKey(query.artist) && query.title.length <= 200 && query.artist.length <= 200 && (query.album === void 0 || typeof query.album === "string" && query.album.length <= 200) && Number.isFinite(query.duration) && query.duration >= 1 && query.duration <= 3600;
  }

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
      const changed = playbackKey(previous) !== playbackKey(snapshot2) || previous?.song.title !== snapshot2?.song.title || previous?.song.artist !== snapshot2?.song.artist || previous?.song.album !== snapshot2?.song.album || previous?.ad !== snapshot2?.ad || Math.round((previous?.song.duration ?? 0) * 10) !== Math.round((snapshot2?.song.duration ?? 0) * 10);
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

  // extension/src/media-session-bridge.ts
  function installMediaSessionBridge() {
    const page = window;
    if (page.moodshiftMediaSessionBridge) return;
    page.moodshiftMediaSessionBridge = true;
    window.addEventListener("moodshift:read-media-session", () => {
      const session = navigator.mediaSession;
      const data = session?.metadata;
      window.dispatchEvent(new CustomEvent("moodshift:media-session", { detail: JSON.stringify({
        title: data?.title.slice(0, 250) ?? "",
        artist: data?.artist.slice(0, 250) ?? "",
        album: data?.album.slice(0, 200),
        state: session?.playbackState
      }) }));
    });
  }

  // extension/src/playout-timing.ts
  var lyricsTimingCalibration = -1.2;
  function clampLyricsCorrection(value) {
    return Math.max(-10, Math.min(10, Number.isFinite(value) ? value : 0));
  }
  function restoreLyricsCorrection(saved, previous) {
    if (typeof saved === "number" && Number.isFinite(saved)) return clampLyricsCorrection(saved);
    if (typeof previous !== "number" || !Number.isFinite(previous) || previous === 0) return 0;
    return clampLyricsCorrection(Math.round((previous - lyricsTimingCalibration) * 10) / 10);
  }
  function calibratedLyricsPosition(playback, position, correction) {
    if (position < 0) return position;
    return synchronizedPosition({ ...playback, position }, lyricsTimingCalibration + correction);
  }
  var PlaybackTimeline = class {
    constructor() {
      this.samples = [];
      this.changedTrack = false;
    }
    reset() {
      this.key = void 0;
      this.samples = [];
      this.changedTrack = false;
    }
    sample(playback, now2) {
      const key = playbackKey(playback);
      if (key !== this.key) {
        this.changedTrack = this.key !== void 0;
        this.key = key;
        this.samples = [];
      }
      const time = playback.sampledAt ?? now2;
      if (time <= (this.samples.at(-1)?.time ?? -Infinity)) return;
      this.samples.push({ time, position: playback.position, rate: playback.rate, paused: playback.paused });
      if (this.samples.length > 180) this.samples.shift();
    }
    position(playback, now2, delaySeconds) {
      const target = now2 - delaySeconds * 1e3;
      const first = this.samples[0];
      if (!first || target < first.time) {
        if (first && this.changedTrack) return -1;
        if (playback.paused) return playback.position;
        return playback.position - (delaySeconds - (now2 - (playback.sampledAt ?? now2)) / 1e3) * playback.rate;
      }
      let index = this.samples.length - 1;
      while (this.samples[index].time > target) index--;
      const point = this.samples[index];
      if (point.paused) return point.position;
      const next = this.samples[index + 1];
      if (next && next.position === point.position) return point.position;
      const elapsed = Math.min((target - point.time) / 1e3, 0.65);
      return Math.min(playback.song.duration || Infinity, point.position + elapsed * point.rate);
    }
  };

  // extension/src/player-captions.ts
  function currentCaptions(cues, position) {
    return cues.filter((cue) => cue.time <= position && position < cue.end).map((cue) => cue.text).join("\n");
  }
  function canUseCaptions(result) {
    return result.kind !== "synced" && result.kind !== "plain";
  }

  // extension/src/lyrics-panel.ts
  var offsetKey = "lyricsManualCorrectionV2";
  var previousOffsetKey = "lyricsManualCorrection";
  var correctionKey = "lyricsCorrections";
  var now = () => performance.timeOrigin + performance.now();
  function mountLyrics(root, summary, onPlayback) {
    const form2 = root.querySelector("#lyrics-search");
    const title = root.querySelector("#lyrics-title");
    const artist = root.querySelector("#lyrics-artist");
    const search = root.querySelector("#lyrics-submit");
    const status2 = root.querySelector("#lyrics-status");
    const viewport = root.querySelector("#lyrics-viewport");
    const karaokeLyrics = document.querySelector("#karaoke-lyrics");
    const homePanel = document.querySelector("#home-panel");
    const follow = root.querySelector("#lyrics-follow");
    const offset = root.querySelector("#lyrics-offset");
    const session = new LyricsSession();
    const timeline = new PlaybackTimeline();
    let source;
    let connection;
    let connecting;
    let searchTimer;
    let cooldownTimer;
    let edited = false;
    let editing = false;
    let allowSearchAt = 0;
    let lines = [];
    let lineElements = [];
    let active = -1;
    let timing;
    let captionFallback;
    let activeLookup;
    let karaokePreview = false;
    function placeLyrics() {
      const preview = karaokePreview && !homePanel.hidden && lines.length > 0;
      karaokeLyrics.hidden = !preview;
      if (preview && viewport.parentElement !== karaokeLyrics) karaokeLyrics.append(viewport);
      if (!preview && viewport.parentElement !== root) root.insertBefore(viewport, form2);
    }
    new MutationObserver(placeLyrics).observe(homePanel, { attributes: true, attributeFilter: ["hidden"] });
    function refreshControls() {
      form2.hidden = session.playback === null;
      search.disabled = !session.playback?.song.duration || Date.now() < allowSearchAt;
    }
    function clearLyrics() {
      if (captionFallback) requestCaptions(false);
      captionFallback = void 0;
      active = -1;
      lines = [];
      lineElements = [];
      viewport.replaceChildren();
      viewport.hidden = true;
      viewport.setAttribute("aria-label", "Song lyrics");
      follow.disabled = true;
      placeLyrics();
    }
    function requestCaptions(enabled) {
      try {
        connection?.postMessage({ type: "captions", enabled });
      } catch {
      }
    }
    function cancelLookup() {
      if (!activeLookup) return;
      void chrome.runtime.sendMessage({ target: "lyrics", cancel: activeLookup }).catch(() => void 0);
      activeLookup = void 0;
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
      const correction = clampLyricsCorrection(offset.valueAsNumber);
      if (!playback) {
        onPlayback(null, 0);
        return;
      }
      const automatic = timing?.seconds ?? 0;
      const basePosition = timeline.position(playback, now(), automatic);
      const aligned = { ...playback, position: calibratedLyricsPosition(playback, basePosition, correction) };
      onPlayback(aligned, 0);
      if (captionFallback) {
        const caption = currentCaptions(playback.captions ?? [], aligned.position);
        const available = !!playback.captions?.length;
        const captionStatus = available ? "Page captions" : captionFallback;
        if (status2.textContent !== captionStatus) status2.textContent = captionStatus;
        viewport.setAttribute("aria-label", "Page captions");
        if (viewport.textContent !== caption) viewport.textContent = caption;
        viewport.hidden = !caption;
      }
      if (!lines.length) return;
      const index = activeLyric(lines, aligned, 0);
      if (index === active) return;
      lineElements[active]?.removeAttribute("aria-current");
      active = index;
      if (lines[index]?.text) lineElements[index].setAttribute("aria-current", "true");
      centerActive();
    }
    function showIdentity(playback) {
      const identified = !!playback?.song.title && !!playback.song.artist;
      summary.textContent = identified ? `${playback.song.title} \xB7 ${playback.song.artist}` : "";
      summary.hidden = !identified;
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
          placeLyrics();
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
          status2.textContent = "This track is listed as instrumental.";
          break;
        case "invalid":
          status2.textContent = "Lyrics unavailable \xB7 Enter the title and artist to search.";
          break;
        case "missing":
          status2.textContent = "Lyrics unavailable \xB7 No matching recording found.";
          break;
        case "error":
          status2.textContent = "Could not load lyrics. Try again shortly.";
          break;
        case "limited": {
          allowSearchAt = result.retryAt;
          const wait = Math.max(1e3, Math.ceil(allowSearchAt - Date.now()));
          const notice = "Please wait a moment before searching again.";
          status2.textContent = notice;
          clearTimeout(cooldownTimer);
          cooldownTimer = setTimeout(() => {
            if (status2.textContent === notice && Date.now() >= allowSearchAt) status2.textContent = "You can retry the lyric search.";
            refreshControls();
          }, Math.min(2147483647, wait));
          break;
        }
      }
      if (canUseCaptions(result)) {
        captionFallback = status2.textContent;
        requestCaptions(true);
        highlight();
      }
      refreshControls();
    }
    async function find(revision, retry) {
      if (!session.acceptsLookup(revision)) return;
      cancelLookup();
      const { album, duration } = session.playback.song;
      const query = { title: title.value.trim(), artist: artist.value.trim(), duration, album: edited ? void 0 : album };
      if (!validSong(query)) {
        show({ kind: "invalid" });
        return;
      }
      clearLyrics();
      status2.textContent = "Finding lyrics\u2026";
      const requestId = activeLookup = crypto.randomUUID();
      try {
        const result = await chrome.runtime.sendMessage({
          target: "lyrics",
          query,
          retry,
          requestId
        });
        if (session.acceptsLookup(revision)) show(result);
      } catch {
        if (session.acceptsLookup(revision)) show({ kind: "error" });
      } finally {
        if (activeLookup === requestId) activeLookup = void 0;
      }
    }
    function receive(id, update) {
      const previousTrack = playbackKey(session.playback);
      const outcome = session.receive(id, update);
      if (outcome === "ignored") return;
      if (update && !update.ad) timeline.sample(update, now());
      if (outcome === "changed") showIdentity(update);
      if (outcome === "playback" && update) {
        highlight();
        return;
      }
      clearTimeout(searchTimer);
      cancelLookup();
      clearLyrics();
      refreshControls();
      highlight();
      if (!update) {
        title.value = "";
        artist.value = "";
        status2.textContent = "Waiting for a player on the selected tab\u2026";
        return;
      }
      const track = playbackKey(update);
      if (previousTrack !== track) {
        edited = false;
        editing = false;
      }
      if (editing) return;
      if (!edited) {
        title.value = update.song.title.slice(0, 200);
        artist.value = update.song.artist.slice(0, 200);
      }
      if (!update.song.duration) {
        status2.textContent = update.ad ? "Lyrics will resume after the ad." : "Lyrics will appear when the track starts.";
        return;
      }
      status2.textContent = "Finding lyrics\u2026";
      const revision = session.invalidateLookup();
      searchTimer = setTimeout(async () => {
        try {
          const stored = await chrome.storage.session.get(correctionKey);
          const corrections = stored[correctionKey];
          const correction = corrections?.[track];
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
    async function connect() {
      if (!source || connection || connecting) return;
      const { id, tabId } = source;
      connecting = id;
      const target = { tabId, frameIds: [0] };
      await Promise.allSettled([
        chrome.scripting.executeScript({ target, func: installMediaSessionBridge, world: "MAIN" }),
        chrome.scripting.executeScript({ target, files: ["youtube-playback.js"] })
      ]);
      if (connecting !== id || source?.id !== id) return;
      connecting = void 0;
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
        if (failed) status2.textContent = "Click MoodShift on the playing tab to look for lyrics.";
      });
    }
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      if (tabId === source?.tabId && change.status === "complete") void connect();
    });
    for (const input of [title, artist]) {
      input.addEventListener("input", () => {
        edited = true;
        editing = true;
        clearTimeout(searchTimer);
        cancelLookup();
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
          const track = playbackKey(playback);
          const entries = Object.entries(values[correctionKey] ?? {}).filter(([id]) => id !== track);
          return chrome.storage.session.set({
            [correctionKey]: Object.fromEntries([...entries.slice(-11), [track, correction]])
          });
        }).catch(() => void 0);
      }
      void find(revision, true);
    });
    let offsetChanged = false;
    void chrome.storage.local.get([offsetKey, previousOffsetKey]).then((values) => {
      if (offsetChanged) return;
      offset.value = String(restoreLyricsCorrection(values[offsetKey], values[previousOffsetKey]));
      highlight();
    }).catch(() => void 0);
    offset.addEventListener("input", () => {
      offsetChanged = true;
      highlight();
    });
    offset.addEventListener("change", () => {
      const value = clampLyricsCorrection(offset.valueAsNumber);
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
      setKaraokePreview(enabled) {
        karaokePreview = enabled;
        placeLyrics();
      },
      setTiming(next) {
        if (timing?.seconds === next?.seconds) return;
        timing = next;
        highlight();
      },
      setSource(next) {
        if (next?.id === source?.id) return;
        const old = connection;
        connection = void 0;
        connecting = void 0;
        old?.disconnect();
        source = next;
        session.setSource(next?.id);
        timeline.reset();
        showIdentity();
        highlight();
        clearTimeout(searchTimer);
        cancelLookup();
        clearLyrics();
        title.value = "";
        artist.value = "";
        refreshControls();
        status2.textContent = next ? "Waiting for a player on the selected tab\u2026" : "Select a playing tab with the MoodShift icon.";
        void connect();
      }
    };
  }

  // extension/src/shared/chords.ts
  var liveChordPort = "moodshift-live-chords:";
  var LiveChordTimeline = class {
    constructor() {
      this.events = [];
    }
    clear() {
      this.previous = void 0;
      this.events = [];
    }
    update({ chord, capturedAt }) {
      if (this.previous === chord) return;
      this.previous = chord;
      const recent = this.events.slice(-23);
      const last = recent.at(-1);
      if (last?.endTime === Infinity) recent[recent.length - 1] = { ...last, endTime: capturedAt };
      if (chord) recent.push({ startTime: capturedAt, endTime: Infinity, chord, source: "live" });
      this.events = recent;
    }
  };
  var validChordVideo = (id) => typeof id === "string" && /^[\w-]{11}$/.test(id);
  function chordPosition(events, playback, offset) {
    if (playback.ad) return { current: -1, next: -1 };
    return chordPositionAt(events, synchronizedPosition(playback, offset));
  }
  function chordPositionAt(events, time) {
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
  var songleStatus = {
    found: "Songle \xB7 Estimated chords",
    missing: "No chords found for this track.",
    empty: "No chords found for this track.",
    invalid: "Could not load chords. Try again.",
    unavailable: "Could not load chords. Try again."
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
    let captureId;
    let livePort;
    let liveUnavailable = false;
    let outputDelay = 0;
    const liveTimeline = new LiveChordTimeline();
    let offset = 0;
    let events;
    let buttons = [];
    let selected;
    let highlighted = -1;
    let drawn = "";
    const session = new ChordSession((id) => chrome.runtime.sendMessage({ target: "chords", videoId: id }), render2);
    const youtubePlayback = () => playback && "videoId" in playback ? playback : null;
    const open = () => details2.open && !details2.closest("[hidden]");
    function disconnectLive() {
      const port = livePort;
      livePort = void 0;
      port?.disconnect();
      liveTimeline.clear();
      liveUnavailable = false;
    }
    function connectLive(sessionId) {
      const port = chrome.runtime.connect({ name: liveChordPort + sessionId });
      livePort = port;
      port.onMessage.addListener((sample) => {
        if (livePort !== port) return;
        outputDelay = sample.outputDelay;
        liveTimeline.update(sample);
        render2();
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (livePort !== port) return;
        disconnectLive();
        liveUnavailable = true;
        render2();
      });
    }
    function showDiagram(chord) {
      if ((chord ?? "") === drawn) return;
      drawn = chord ?? "";
      diagrams.replaceChildren();
      if (chord) diagrams.append(element("h3", chord), element("h4", "Guitar"), guitar(chord), element("h4", "Piano"), piano(chord));
    }
    function render2() {
      const result = session.result;
      const youtube = youtubePlayback();
      const live = Boolean(captureId && !youtube);
      const visible = Boolean(captureId && (live || youtube && !youtube.ad && Number.isFinite(youtube.song.duration) && youtube.song.duration > 0));
      const found = live ? liveTimeline.events : result?.kind === "found" ? result.events : void 0;
      const position = live ? chordPositionAt(liveTimeline.events, (performance.timeOrigin + performance.now()) / 1e3 - outputDelay) : found && youtube ? chordPosition(found, youtube, offset) : { current: -1, next: -1 };
      retry.hidden = !visible || (live ? !liveUnavailable : result?.kind !== "unavailable" && result?.kind !== "invalid");
      let message = "Select a playing tab with the MoodShift icon.";
      if (live) {
        if (liveUnavailable) message = "Could not start live chords. Try again.";
        else message = position.current >= 0 ? "Live chord estimates" : "Listening for chords\u2026";
      } else if (youtube?.ad) message = "Chords will resume after the ad.";
      else if (youtube) message = visible ? result ? songleStatus[result.kind] : "Finding chords\u2026" : "Chords will appear when the track starts.";
      if (status2.textContent !== message) status2.textContent = message;
      content.hidden = !visible || !found?.length;
      if (found !== events) {
        const pinned = live && selected !== void 0 ? events?.[selected]?.startTime : void 0;
        const pinnedIndex = pinned === void 0 ? -1 : found?.findIndex((event) => event.startTime === pinned) ?? -1;
        const hadFocus = pinnedIndex >= 0 && progression.contains(document.activeElement);
        events = found;
        selected = pinnedIndex < 0 ? void 0 : pinnedIndex;
        highlighted = -1;
        buttons = (events ?? []).map(({ chord, startTime }, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = chord;
          button.setAttribute("aria-label", live ? `Detected chord ${chord}` : `${chord} at ${startTime.toFixed(2)} seconds`);
          button.addEventListener("click", () => {
            selected = selected === index ? void 0 : index;
            render2();
          });
          return button;
        });
        progression.replaceChildren(...buttons);
        if (hadFocus) buttons[pinnedIndex]?.focus({ preventScroll: true });
      }
      if (!found || !visible) {
        showDiagram();
        return;
      }
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
      const active = open();
      const youtube = youtubePlayback();
      session.setPlayback(active ? youtube : null);
      if (!active || !captureId || youtube) disconnectLive();
      else if (!livePort && !liveUnavailable) connectLive(captureId);
      if (active) render2();
    }
    details2.addEventListener("toggle", sync);
    const advanced = details2.closest("#advanced-panel");
    if (advanced) new MutationObserver(sync).observe(advanced, { attributes: true, attributeFilter: ["hidden"] });
    retry.addEventListener("click", () => {
      if (youtubePlayback()) session.retry();
      else {
        liveUnavailable = false;
        sync();
      }
    });
    return {
      setCapture(id) {
        if (captureId === id) return;
        disconnectLive();
        captureId = id;
        playback = null;
        sync();
      },
      setPlayback(update, timingOffset) {
        if (livePort && playbackKey(update) !== playbackKey(playback)) liveTimeline.clear();
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
    const presets = rows.map(storedPreset).filter((preset) => preset !== void 0);
    return { presets, skipped: rows.length - presets.length };
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
    let presets = [];
    let captureReady = false;
    let busy = false;
    let needsReload = false;
    let reloadId = 0;
    function controls2() {
      const exists = presets.some((preset) => preset.id === select.value);
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
      const preset = presets.find((item) => item.id === select.value);
      name.value = preset?.name ?? "";
      description.value = preset?.description ?? "";
      controls2();
    }
    async function reload(preferred = select.value) {
      const id = ++reloadId;
      const result = await listPresets();
      if (id !== reloadId) return;
      presets = result.presets;
      select.replaceChildren(
        new Option(presets.length ? "Select a saved preset" : "No saved presets", ""),
        ...presets.map((preset) => new Option(preset.name, preset.id))
      );
      select.value = presets.some((preset) => preset.id === preferred) ? preferred : "";
      notice.textContent = result.skipped ? "Some saved presets could not be loaded." : "";
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
    const state = query("#memory-status");
    let settings;
    let ready = false;
    let busy = false;
    let preferences = [];
    let editingId;
    function controls2() {
      enable.disabled = !ready || busy;
      field.disabled = !ready || busy;
      save.disabled = field.disabled || !field.value.trim();
      cancel.disabled = busy;
      for (const button of localList.querySelectorAll("button")) button.disabled = busy;
    }
    function setSettings(next) {
      const changed = !!settings?.enabled !== !!next?.enabled || next?.enabled && (settings?.installationId !== next.installationId || settings.useSupermemory !== next.useSupermemory);
      settings = next;
      ready = true;
      enable.checked = next?.enabled === true;
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
        const message = error instanceof Error ? error.message : "Could not update your preferences. Try again.";
        status2.textContent = message;
        return message;
      } finally {
        busy = false;
        controls2();
      }
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
          localPreferences: localPreferences.length ? localPreferences : void 0
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
  var DemoAccessRequired = class extends Error {
    constructor() {
      super("MoodShift could not connect. Check with whoever set up this installation.");
    }
  };
  async function cloudDemoCode(config = deployment) {
    if (config.mode !== "production") return;
    const code = (await chrome.storage.local.get(demoCodeKey))[demoCodeKey];
    if (typeof code !== "string" || !demoCodePattern.test(code)) {
      throw new DemoAccessRequired();
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
  async function apiFeedback(response, feature) {
    const detail = await apiErrorDetail(response);
    console.warn("MoodShift request failed", detail);
    if (response.status === 401 && /access code/i.test(detail)) return new DemoAccessRequired().message;
    if (response.status === 429) return "Too many requests. Try again in a moment.";
    if (response.status === 504) return "That took too long. Try again.";
    if (feature === "preferences") {
      return response.status === 403 ? "Supermemory isn\u2019t available here." : "Could not update Supermemory. Try again.";
    }
    if (response.status >= 500 || response.status === 401 || response.status === 403) {
      return "Gemini unavailable. Presets and manual controls still work.";
    }
    return "Could not apply your request. Try rephrasing it.";
  }

  // extension/src/sidepanel.ts
  mountPanelTabs();
  var logoPath = chrome.runtime.getManifest().icons?.[128];
  if (logoPath) {
    const logo = new Image(32, 32);
    logo.className = "brand-logo";
    logo.alt = "";
    logo.addEventListener("load", () => document.querySelector(".brand-mark")?.replaceWith(logo), { once: true });
    logo.src = chrome.runtime.getURL(logoPath);
  }
  var statusLabel = document.querySelector("#status");
  var chords = mountChords(document.querySelector("#chords"));
  var lyrics = mountLyrics(
    document.querySelector("#lyrics"),
    document.querySelector("#current-song"),
    chords.setPlayback
  );
  var stopButton = document.querySelector("#stop");
  var meter = document.querySelector("#meter");
  var inputStatus = document.querySelector("#input-status");
  var feedback = document.querySelector("#feedback");
  var controls = document.querySelector("#controls");
  var presetGroup = document.querySelector("#presets");
  var resetEffects = document.querySelector("#reset-effects");
  var monitorButtons = [...document.querySelectorAll("[data-mode]")];
  var stemButtons = [...document.querySelectorAll("[data-stem]")];
  var stemLabel = document.querySelector("#stem-status");
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
  var karaokeRequested = false;
  var interpretation;
  var savedPresets = mountSavedPresets(document.querySelector("#saved-presets"), readCapture, restorePreset);
  var personalization = mountPersonalization(document.querySelector("#personalization"), () => {
    if (interpretation) {
      cancelInterpretation();
      feedback.textContent = "Personalization changed. Submit the prompt again.";
    }
  });
  document.querySelector("#cloud-stem-note").hidden = !usesCloudStems();
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
    inputStatus.textContent = capture?.outputPaused ? "Playback paused. Click MoodShift on the playing tab to reconnect." : capture?.session.muted ? "This tab is muted." : capture && features.isSilent ? "Waiting for audio\u2026" : "";
  }
  function stemNotice(detail) {
    if (/another stem session is active/i.test(detail)) return "Vocals and Instrumental are busy. Try again shortly.";
    if (/muted|unmute|audio output paused/i.test(detail)) return "Resume or unmute the tab and try again.";
    if (/(?:access|private demo) code/i.test(detail)) return new DemoAccessRequired().message;
    return "Could not switch the mix. Try again.";
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
      renderMoodSelection();
      value.textContent = displayValue(input.valueAsNumber, spec.unit);
      clearTimeout(editTimer);
      editTimer = setTimeout(flushEdits, 45);
    });
    input.addEventListener("change", flushEdits);
    return { key, input, value };
  });
  var sceneButtons = moodScenes.map((scene) => {
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = true;
    button.className = "mood-card";
    button.dataset.mood = scene.id;
    button.setAttribute("aria-label", scene.name);
    button.setAttribute("aria-describedby", `${scene.id}-subtitle`);
    button.setAttribute("aria-pressed", "false");
    const emoji = document.createElement("span");
    emoji.className = "mood-emoji";
    emoji.textContent = scene.emoji;
    emoji.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "mood-name";
    name.textContent = scene.name;
    const subtitle = document.createElement("span");
    subtitle.className = "mood-subtitle";
    subtitle.id = `${scene.id}-subtitle`;
    subtitle.textContent = scene.subtitle;
    button.append(emoji, name, subtitle);
    button.addEventListener("click", () => {
      if (status.phase !== "capturing") return;
      clearEdits();
      cancelInterpretation();
      karaokeRequested = scene.stemMode === "instrumental";
      renderMoodSelection();
      void command({ type: "APPLY_EFFECTS", sessionId: status.session.id, patch: scene.effects }, scene.name, scene);
    });
    presetGroup.append(button);
    return { button, scene };
  });
  resetEffects.addEventListener("click", () => {
    clearEdits();
    karaokeRequested = false;
    applyLocal(neutralEffects);
  });
  function renderMoodSelection() {
    const selected = activeMoodScene(status, queuedEdits);
    for (const { button, scene } of sceneButtons) button.setAttribute("aria-pressed", String(selected === scene));
    lyrics.setKaraokePreview(karaokeRequested || selected?.stemMode === "instrumental");
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
      karaokeRequested = false;
      cancelInterpretation();
      stopping = false;
      feedback.textContent = "";
    }
    status = next;
    chords.setCapture(nextId);
    lyrics.setSource(next.phase === "capturing" ? next.session : void 0);
    lyrics.setTiming(next.phase === "capturing" ? next.audioTiming : void 0);
    renderMoodSelection();
    updateApply();
    stopButton.disabled = next.phase !== "capturing" || stopping;
    const enabled = !stopButton.disabled && !presetApplying;
    controls.disabled = !enabled;
    resetEffects.disabled = !enabled;
    for (const { button } of sceneButtons) button.disabled = !enabled;
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
      case "buffering":
        stemLabel.textContent = "Preparing audio\u2026";
        break;
      case "active":
        stemLabel.textContent = next.phase === "capturing" && next.monitor === "original" ? "Playing the original mix." : stem.mode === "vocals" ? "Playing vocals." : "Playing instrumental.";
        break;
      case "unavailable":
        stemLabel.textContent = `Full mix selected. ${stemNotice(stem.message)}`;
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
        statusLabel.textContent = "Could not connect. Click MoodShift on the playing tab to try again.";
        break;
    }
  }
  async function readCapture() {
    if (status.phase !== "capturing" || commandPending || stopping || interpretation || Object.keys(queuedEdits).length) {
      throw new Error("Wait for the current audio change to finish.");
    }
    const sessionId = status.session.id;
    const reply = await toWorker({ type: "GET_STATUS" }).catch((error) => {
      console.warn("MoodShift could not read the active audio session", error);
      throw new Error("Could not connect. Reopen MoodShift and try again.");
    });
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
    karaokeRequested = false;
    refreshId++;
    render(status);
    const current = () => id === commandId;
    try {
      const result = await applySavedPreset(preset, capture, current);
      if (!current()) throw new Error("The selected tab changed.");
      refreshId++;
      render(result.status);
      if (!result.limitation) return `Applied \u2713 \xB7 ${preset.name}`;
      console.warn("MoodShift applied the preset without switching the mix", result.limitation);
      return `Effects applied. ${stemNotice(result.limitation)}`;
    } catch (error) {
      console.warn("MoodShift could not apply the preset", error);
      throw new Error("Could not apply the preset. Try again.");
    } finally {
      if (current()) {
        presetApplying = false;
        commandPending = false;
        render(status);
        void refresh();
      }
    }
  }
  async function command(message, detail = "", stemRequest) {
    const scene = typeof stemRequest === "object" ? stemRequest : void 0;
    const stemMode = typeof stemRequest === "string" ? stemRequest : scene?.stemMode;
    const id = ++commandId;
    commandPending = true;
    updateApply();
    refreshId++;
    if (message.type === "APPLY_EFFECTS" || message.type === "SET_STEM") feedback.textContent = "Applying\u2026";
    try {
      let reply = await toWorker(message);
      if (id !== commandId) return;
      if (!reply.ok) throw new Error(reply.message);
      if (scene && reply.status.phase === "capturing" && reply.status.monitor !== "modified") {
        const { session, revision } = reply.status;
        reply = await toWorker({ type: "SET_MONITOR", sessionId: session.id, baseRevision: revision, monitor: "modified" });
        if (id !== commandId) return;
        if (!reply.ok) throw new Error(reply.message);
      }
      if (message.type === "APPLY_EFFECTS" && stemMode && reply.status.phase === "capturing" && (!scene || reply.status.stem.mode !== stemMode || reply.status.stem.phase !== (stemMode === "full" ? "idle" : "active"))) {
        if (scene) {
          refreshId++;
          render(reply.status);
          if (stemMode === "instrumental") feedback.textContent = "Karaoke effects applied. Preparing the instrumental mix\u2026";
        }
        reply = await toWorker({
          type: "SET_STEM",
          mode: stemMode,
          sessionId: message.sessionId,
          baseRevision: reply.status.revision
        });
        if (id !== commandId) return;
        if (!reply.ok) {
          console.warn("MoodShift could not switch the mix", reply.message);
          feedback.textContent = scene?.stemMode === "instrumental" ? "Karaoke effects applied. Instrumental is unavailable." : `Effects applied. ${stemNotice(reply.message)}`;
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
      console.warn("MoodShift audio change failed", error);
      feedback.textContent = message.type === "SET_STEM" ? stemNotice(String(error)) : message.type === "STOP" ? "Could not stop MoodShift. Try again." : "Could not change the sound. Try again.";
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
      if (id === refreshId) {
        const next = reply.ok ? reply.status : { phase: "error", message: reply.message };
        if (next.phase === "error") console.warn("MoodShift could not connect", next.message);
        render(next);
      }
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
      feedback.textContent = "MoodShift can isolate vocals or play the instrumental mix.";
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
        const message = await apiFeedback(response, "effects");
        if (interpretation?.id === request.id) feedback.textContent = message;
        return;
      }
      const body = await response.json();
      if (interpretation?.id !== request.id) return;
      const result = parseInterpretation(body, effects);
      const detail = [result.summary, result.unsupported.length ? `Unavailable \xB7 ${result.unsupported.join(", ")}` : ""].filter(Boolean).join(" ");
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
      if (error instanceof DemoAccessRequired) feedback.textContent = error.message;
      else {
        console.warn("MoodShift could not apply the request", error);
        feedback.textContent = request.controller.signal.aborted ? "That took too long. Try again." : error instanceof TypeError ? "Gemini unavailable. Presets and manual controls still work." : "Could not apply your request. Try rephrasing it.";
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
      lyrics.setTiming(event.data.audioTiming);
      renderMeter(event.data.features);
    }
  });
  void refresh();
})();
