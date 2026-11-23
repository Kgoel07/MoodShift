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

  // extension/src/shared/home-layout.ts
  var homeSections = {
    lyrics: { label: "Lyrics", visible: true },
    stems: { label: "Stems", visible: true },
    equalizer: { label: "Equalizer", visible: true },
    pitch: { label: "Pitch Control", visible: false },
    reverb: { label: "Reverb", visible: false },
    controls: { label: "Audio controls", visible: false },
    presets: { label: "My Presets", visible: false }
  };
  var homeSectionKeys = Object.keys(homeSections);
  var homeLayoutKey = "moodshiftHomeLayout";
  function readHomeLayout(input) {
    const saved = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    return Object.fromEntries(homeSectionKeys.map((key) => [
      key,
      Object.hasOwn(saved, key) && typeof saved[key] === "boolean" ? saved[key] : homeSections[key].visible
    ]));
  }
  function rangeFill(value, min, max) {
    if (!Number.isFinite(value) || !Number.isFinite(max - min) || max <= min) return 0;
    return Math.max(0, Math.min(100, (value - min) / (max - min) * 100));
  }

  // extension/src/shared/display-settings.ts
  var lyricsOffsetKey = "lyricsManualCorrectionV2";
  var previousOffsetKey = "lyricsManualCorrection";
  var sidepanelOffsetKey = "lyricsOffset";
  var displayOptionsKey = "moodshiftDisplayOptions";
  var displayKeys = [homeLayoutKey, lyricsOffsetKey, previousOffsetKey, sidepanelOffsetKey, displayOptionsKey];
  var lyricsTimingCalibration = -1.2;
  var lyricOffsetRange = { min: -10, max: 10 };
  function clampLyricsCorrection(value) {
    return Math.round(Math.max(lyricOffsetRange.min, Math.min(lyricOffsetRange.max, Number.isFinite(value) ? value : 0)) * 10) / 10;
  }
  function restoreLyricsCorrection(saved, previous) {
    if (typeof saved === "number" && Number.isFinite(saved)) return clampLyricsCorrection(saved);
    if (typeof previous !== "number" || !Number.isFinite(previous) || previous === 0) return 0;
    return clampLyricsCorrection(previous - lyricsTimingCalibration);
  }
  function readDisplay(values) {
    const options = values[displayOptionsKey];
    return {
      home: readHomeLayout(values[homeLayoutKey]),
      lyricsOffset: restoreLyricsCorrection(values[lyricsOffsetKey], values[sidepanelOffsetKey] ?? values[previousOffsetKey]),
      lyricsFollow: options?.lyricsFollow !== false,
      lyricsOpen: options?.lyricsOpen !== false,
      chordsOpen: options?.chordsOpen === true
    };
  }

  // extension/src/playout-timing.ts
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

  // extension/src/shared/equalizer.ts
  var eqRange = { minHz: 20, maxHz: 2e4, minGain: -12, maxGain: 12, minQ: 0.3, maxQ: 12 };
  var defaultBands = [
    { id: "sub", frequency: 60, name: "Sub Bass" },
    { id: "bass", frequency: 170, name: "Bass" },
    { id: "low-mid", frequency: 400, name: "Low Mids" },
    { id: "mid", frequency: 1e3, name: "Mids" },
    { id: "high-mid", frequency: 3e3, name: "High Mids" },
    { id: "treble", frequency: 1e4, name: "Treble" }
  ];
  var customBandLimit = 12;
  var baseIds = new Set(defaultBands.map((band) => band.id));
  var uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  var customBand = new RegExp(`^point:${uuid}$`);
  var customEqPreset = new RegExp(`^eq:${uuid}$`);
  var eqPresets = {
    balanced: { name: "Balanced", gains: [0, 0, 0, 0, 0, 0] },
    bass: { name: "Bass Boost", gains: [5, 4, 1, -1, 0, 0] },
    vocal: { name: "Vocal Clarity", gains: [-3, -2, -1, 2, 4, 1] },
    warm: { name: "Warm", gains: [1, 3, 2, 0, -2, -2] },
    bright: { name: "Bright", gains: [-1, -1, -1, 0, 3, 5] }
  };
  function isDefaultBand(id) {
    return baseIds.has(id);
  }
  function builtInBands(id) {
    return defaultBands.map(({ id: bandId, frequency }, i) => ({ id: bandId, frequency, gain: eqPresets[id].gains[i], q: 1 }));
  }
  function defaultEqualizer() {
    return { enabled: true, preset: "balanced", bands: builtInBands("balanced") };
  }
  function limit(value, min, max, digits) {
    if (!Number.isFinite(value)) throw new Error("Enter a valid frequency, gain, or bandwidth.");
    return Number(Math.min(max, Math.max(min, value)).toFixed(digits));
  }
  function sanitizeBand(input) {
    if (!input || typeof input.id !== "string" || !isDefaultBand(input.id) && !customBand.test(input.id)) {
      throw new Error("This EQ point is invalid.");
    }
    const { minHz, maxHz, minGain, maxGain, minQ, maxQ } = eqRange;
    return {
      id: input.id,
      frequency: limit(input.frequency, minHz, maxHz, 0),
      gain: limit(input.gain, minGain, maxGain, 1),
      q: limit(input.q, minQ, maxQ, 2)
    };
  }
  function validateBands(input) {
    if (!Array.isArray(input) || input.length < defaultBands.length || input.length > defaultBands.length + customBandLimit) {
      throw new Error("This EQ has an invalid number of bands.");
    }
    const bands = input.map(sanitizeBand);
    const byId = new Map(bands.map((band) => [band.id, band]));
    if (byId.size !== bands.length || defaultBands.some((band) => !byId.has(band.id))) {
      throw new Error("This EQ is missing a default band or has duplicate points.");
    }
    return [...defaultBands.map((band) => byId.get(band.id)), ...bands.filter((band) => !isDefaultBand(band.id))];
  }
  function validateEq(input) {
    const eq = input;
    if (!eq || typeof eq.enabled !== "boolean" || eq.preset !== null && (typeof eq.preset !== "string" || !Object.hasOwn(eqPresets, eq.preset) && !customEqPreset.test(eq.preset))) throw new Error("Invalid equalizer settings.");
    return { enabled: eq.enabled, preset: eq.preset, bands: validateBands(eq.bands) };
  }
  function changeEq(current, edit) {
    switch (edit.kind) {
      case "eq-enabled":
        return validateEq({ ...current, enabled: edit.enabled });
      case "eq-reset":
        return { ...defaultEqualizer(), enabled: current.enabled };
      case "eq-preset": {
        const bands = Object.hasOwn(eqPresets, edit.preset) ? builtInBands(edit.preset) : edit.bands;
        return validateEq({ enabled: true, preset: edit.preset, bands });
      }
      case "eq-forget":
        return current.preset === edit.preset ? { ...current, preset: null } : current;
      case "eq-band": {
        const previous = current.bands.find((band) => band.id === edit.id);
        if (!previous) throw new Error("That EQ point is no longer available.");
        const next = sanitizeBand({ ...previous, ...edit.patch, id: previous.id });
        if (next.frequency === previous.frequency && next.gain === previous.gain && next.q === previous.q) return current;
        return { ...current, preset: null, bands: current.bands.map((band) => band === previous ? next : band) };
      }
      case "eq-add": {
        const point = sanitizeBand(edit.point);
        if (isDefaultBand(point.id)) throw new Error("Choose a new EQ point.");
        if (current.bands.some((band) => band.id === point.id)) return current;
        return validateEq({ ...current, preset: null, bands: [...current.bands, point] });
      }
      case "eq-remove":
        if (isDefaultBand(edit.id)) throw new Error("The six default bands can be reset in the equalizer.");
        return { ...current, preset: null, bands: current.bands.filter((band) => band.id !== edit.id) };
      default:
        throw new Error("Unknown equalizer action.");
    }
  }

  // extension/src/eq-presets.ts
  var eqPresetsKey = "moodshiftEqPresets";
  var maxPresets = 30;
  function readEqPresets(input) {
    if (!Array.isArray(input)) return [];
    const result = /* @__PURE__ */ new Map();
    for (const row of input.slice(0, maxPresets)) {
      if (typeof row?.id !== "string" || !customEqPreset.test(row.id) || typeof row?.name !== "string" || !row.name.trim() || row.name.length > 48) continue;
      try {
        result.set(row.id, { id: row.id, name: row.name.trim(), bands: validateBands(row.bands) });
      } catch {
      }
    }
    return [...result.values()];
  }
  async function loadEqPresets() {
    return readEqPresets((await chrome.storage.local.get(eqPresetsKey))[eqPresetsKey]);
  }
  async function saveEqPreset(name, bands) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 48) throw new Error("Enter a name between 1 and 48 characters.");
    const preset = { id: `eq:${crypto.randomUUID()}`, name: trimmed, bands: validateBands(bands) };
    return navigator.locks.request(eqPresetsKey, async () => {
      const presets2 = await loadEqPresets();
      if (presets2.some((row) => row.name.toLowerCase() === trimmed.toLowerCase())) throw new Error("An EQ preset already uses that name.");
      if (presets2.length >= maxPresets) throw new Error("Delete an EQ preset before saving another.");
      await chrome.storage.local.set({ [eqPresetsKey]: [...presets2, preset] });
      return preset;
    });
  }
  async function deleteEqPreset(id) {
    await navigator.locks.request(eqPresetsKey, async () => {
      const presets2 = await loadEqPresets();
      await chrome.storage.local.set({ [eqPresetsKey]: presets2.filter((preset) => preset.id !== id) });
    });
  }

  // extension/src/shared/messages.ts
  var meterChannel = "moodshift-meter";
  function toWorker(command2) {
    return chrome.runtime.sendMessage({ ...command2, target: "worker" });
  }

  // extension/src/shared/reverb.ts
  var reverbPresets = {
    dreamy: { label: "\u{1F319} Dreamy Reverb", amount: 0.28, duration: 2.4, preDelay: 0.012, toneHz: 3800 },
    hall: { label: "\u{1F3DB}\uFE0F Concert Hall", amount: 0.24, duration: 2.8, preDelay: 0.028, toneHz: 6500 },
    slowed: { label: "\u{1F327}\uFE0F Slowed + Reverb", amount: 0.34, duration: 3.4, preDelay: 0.018, toneHz: 2800 }
  };
  var reverbDuration = { min: 0.4, max: 4, step: 0.1 };
  var defaultReverb = Object.freeze({ preset: "dreamy", duration: 2.4, lastAmount: 0.28 });
  function bounded(value, min, max) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Reverb values must be finite numbers.");
    return Math.max(min, Math.min(max, value));
  }
  function validateReverb(input) {
    const value = input;
    if (!value || typeof value !== "object" || !Object.hasOwn(reverbPresets, value.preset) || Object.keys(value).some((key) => !["preset", "duration", "lastAmount"].includes(key))) throw new Error("Invalid reverb settings.");
    return {
      preset: value.preset,
      duration: Math.round(bounded(value.duration, reverbDuration.min, reverbDuration.max) * 10) / 10,
      lastAmount: bounded(value.lastAmount, 0, effectSpecs.reverbMix.max)
    };
  }
  function changeReverb(current, mix, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid reverb change.");
    const patch = input;
    if (Object.keys(patch).some((key) => !["preset", "duration", "enabled", "amount"].includes(key)) || patch.enabled !== void 0 && typeof patch.enabled !== "boolean") throw new Error("Invalid reverb change.");
    let settings = { ...current };
    if (patch.preset !== void 0) {
      if (!Object.hasOwn(reverbPresets, patch.preset)) throw new Error("Unknown reverb preset.");
      const preset = reverbPresets[patch.preset];
      settings = { preset: patch.preset, duration: preset.duration, lastAmount: preset.amount };
      mix = preset.amount;
    }
    if (patch.duration !== void 0) settings.duration = patch.duration;
    if (patch.amount !== void 0) {
      mix = bounded(patch.amount, 0, effectSpecs.reverbMix.max);
      if (mix > 0) settings.lastAmount = mix;
    }
    if (patch.enabled === false) mix = 0;
    if (patch.enabled === true && mix === 0) mix = settings.lastAmount || defaultReverb.lastAmount;
    return { settings: validateReverb(settings), mix };
  }

  // extension/src/shared/pitch.ts
  var pitchRange = { min: -6, max: 6, step: 0.1 };
  var defaultPitch = { enabled: false, semitones: 0 };
  function pitchSettings(input) {
    const pitch2 = input;
    if (!pitch2 || typeof pitch2.enabled !== "boolean" || !Number.isFinite(pitch2.semitones)) {
      throw new Error("Choose a valid pitch setting.");
    }
    const { min, max } = pitchRange;
    return { enabled: pitch2.enabled, semitones: Math.round(Math.max(min, Math.min(max, pitch2.semitones)) * 10) / 10 || 0 };
  }

  // extension/src/shared/tuning.ts
  function defaultTuning() {
    return { pitch: { ...defaultPitch }, eq: defaultEqualizer() };
  }
  function validateTuning(input) {
    const value = input;
    if (!value) throw new Error("Invalid pitch and EQ settings.");
    return { pitch: pitchSettings(value.pitch), eq: validateEq(value.eq) };
  }
  function changeTuning(current, edit) {
    if (!edit || typeof edit !== "object") throw new Error("Invalid pitch or EQ action.");
    if (edit.kind === "pitch") return { ...current, pitch: pitchSettings({ ...current.pitch, ...edit.patch }) };
    const eq = changeEq(current.eq, edit);
    return eq === current.eq ? current : { ...current, eq };
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
      monitor: preset.monitor,
      ...preset.reverb === void 0 ? {} : { reverb: validateReverb(preset.reverb) },
      ...preset.tuning === void 0 ? {} : { tuning: validateTuning(preset.tuning) }
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
    const reverb3 = capture.reverb;
    return {
      audioSettings: capture.effects,
      stemMode: capture.stem.mode,
      monitor: capture.monitor,
      ...capture.tuning ? { tuning: capture.tuning } : {},
      ...reverb3 ? { reverb: { preset: reverb3.preset, duration: reverb3.duration, lastAmount: reverb3.lastAmount } } : {}
    };
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
    const sessionId2 = capture.session.id;
    const assertCurrent = () => {
      if (!current()) throw new Error("Preset application was superseded.");
    };
    const requireCapture = (reply) => {
      assertCurrent();
      if (!reply.ok) {
        console.warn("MoodShift could not restore saved audio settings", reply.message);
        throw new Error("Couldn\u2019t apply this preset. Check the playing tab and try again.");
      }
      if (reply.status.phase !== "capturing" || reply.status.session.id !== sessionId2) {
        throw new Error("The selected tab changed during preset application.");
      }
      return reply.status;
    };
    let status2 = requireCapture(await send({
      type: "APPLY_EFFECTS",
      sessionId: sessionId2,
      patch: preset.audioSettings,
      baseRevision: capture.revision,
      ...preset.reverb ? { reverb: preset.reverb } : {},
      ...preset.tuning ? { tuning: preset.tuning } : {}
    }));
    const matches = () => effectKeys.every((key) => status2.effects[key] === preset.audioSettings[key]) && (!preset.tuning || JSON.stringify(status2.tuning) === JSON.stringify(preset.tuning)) && (!preset.reverb || status2.reverb && status2.reverb.preset === preset.reverb.preset && status2.reverb.duration === preset.reverb.duration && status2.reverb.lastAmount === preset.reverb.lastAmount);
    if (!matches()) throw new Error("Audio settings changed during preset application.");
    let limitation;
    if (status2.stem.mode !== preset.stemMode || preset.stemMode !== "full" && status2.stem.phase !== "active") {
      const reply = await send({ type: "SET_STEM", sessionId: sessionId2, mode: preset.stemMode, baseRevision: status2.revision });
      assertCurrent();
      if (reply.ok) status2 = requireCapture(reply);
      else {
        limitation = reply.message;
        status2 = requireCapture(await send({ type: "GET_STATUS" }));
        if (!matches()) throw new Error("Audio settings changed during preset application.");
      }
    }
    if (status2.monitor !== preset.monitor) {
      status2 = requireCapture(await send({ type: "SET_MONITOR", sessionId: sessionId2, monitor: preset.monitor, baseRevision: status2.revision }));
    }
    if (!matches() || status2.monitor !== preset.monitor) throw new Error("Audio settings changed during preset application.");
    if (status2.stem.mode !== preset.stemMode || preset.stemMode !== "full" && status2.stem.phase !== "active") {
      limitation ??= "The requested stem is unavailable.";
    }
    return { status: status2, limitation };
  }

  // extension/src/control-state.ts
  function controlState(capture, display) {
    const { preset, duration, lastAmount } = capture.reverb ?? defaultReverb;
    return {
      effects: capture.effects,
      tuning: capture.tuning ?? defaultTuning(),
      reverb: { preset, duration, lastAmount },
      monitor: capture.monitor,
      stemMode: capture.stem.mode,
      display
    };
  }
  async function loadDisplay() {
    return readDisplay(await chrome.storage.local.get(displayKeys));
  }
  async function loadControlPresets() {
    const [audio, eq] = await Promise.all([listPresets().then((result) => result.presets).catch(() => []), loadEqPresets().catch(() => [])]);
    return { audio, eq };
  }

  // extension/src/display-client.ts
  function observeDisplay(render2, failure = () => {
  }) {
    let generation = 0;
    const refresh2 = () => {
      const id = ++generation;
      void loadDisplay().then((settings) => {
        if (id === generation) render2(settings);
      }, failure);
    };
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && displayKeys.some((key) => Object.hasOwn(changes, key))) refresh2();
    });
    refresh2();
  }
  async function setDisplay(control, value) {
    const reply = await toWorker({ type: "SET_DISPLAY", action: { control, operation: "set", value } });
    if (!reply.ok) throw new Error(reply.message);
  }

  // extension/src/player-captions.ts
  function currentCaptions(cues, position) {
    return cues.filter((cue) => cue.time <= position && position < cue.end).map((cue) => cue.text).join("\n");
  }
  function canUseCaptions(result) {
    return result.kind !== "synced" && result.kind !== "plain";
  }

  // extension/src/lyrics-panel.ts
  var correctionKey = "lyricsCorrections";
  var now = () => performance.timeOrigin + performance.now();
  function mountLyrics(root, onPlayback) {
    const form2 = root.querySelector("#lyrics-search");
    const options = root.querySelector("#lyric-options");
    const details2 = root;
    const title = root.querySelector("#lyrics-title");
    const artist = root.querySelector("#lyrics-artist");
    const search = root.querySelector("#lyrics-submit");
    const status2 = root.querySelector("#lyrics-status");
    const viewport = root.querySelector("#lyrics-viewport");
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
    function refreshControls() {
      form2.hidden = session.playback === null;
      options.hidden = form2.hidden;
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
      const automatic = timing?.playoutSeconds ?? 0;
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
          status2.textContent = "This track is listed as instrumental.";
          break;
        case "invalid":
          status2.textContent = "Lyrics unavailable \xB7 Enter the title and artist to search.";
          break;
        case "missing":
          status2.textContent = "Lyrics unavailable \xB7 No matching recording found.";
          break;
        case "ambiguous":
          status2.textContent = "Multiple recordings match. Check the song details.";
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
    let savedOffset;
    let displayReady = false;
    observeDisplay((preference) => {
      if (savedOffset !== preference.lyricsOffset) offset.value = String(preference.lyricsOffset);
      savedOffset = preference.lyricsOffset;
      follow.checked = preference.lyricsFollow;
      details2.open = preference.lyricsOpen;
      displayReady = true;
      highlight();
      centerActive();
    });
    offset.addEventListener("input", highlight);
    offset.addEventListener("change", () => {
      const value = clampLyricsCorrection(offset.valueAsNumber);
      offset.value = String(value);
      void setDisplay("lyrics.offset", value).catch(() => void 0);
      highlight();
    });
    follow.addEventListener("change", () => {
      centerActive();
      void setDisplay("lyrics.follow", follow.checked).catch(() => void 0);
    });
    details2.addEventListener("toggle", () => {
      if (displayReady) void setDisplay("lyrics.open", details2.open).catch(() => void 0);
    });
    function pauseFollow() {
      if (!follow.checked || follow.disabled) return;
      follow.checked = false;
      void setDisplay("lyrics.follow", false).catch(() => void 0);
    }
    for (const event of ["wheel", "touchstart"]) {
      viewport.addEventListener(event, pauseFollow, { passive: true });
    }
    viewport.addEventListener("keydown", (event) => {
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(event.key)) pauseFollow();
    });
    return {
      setTiming(next) {
        if (timing?.playoutSeconds === next?.playoutSeconds) return;
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
    const open = () => details2.open && !document.hidden && !details2.closest("[hidden]");
    function disconnectLive() {
      const port = livePort;
      livePort = void 0;
      port?.disconnect();
      liveTimeline.clear();
      liveUnavailable = false;
    }
    function connectLive(sessionId2) {
      const port = chrome.runtime.connect({ name: liveChordPort + sessionId2 });
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
    let displayReady = false;
    observeDisplay((settings2) => {
      details2.open = settings2.chordsOpen;
      displayReady = true;
      sync();
    });
    details2.addEventListener("toggle", () => {
      sync();
      if (displayReady) void setDisplay("chords.open", details2.open).catch(() => void 0);
    });
    const settings = details2.closest("#settings-panel");
    if (settings) new MutationObserver(sync).observe(settings, { attributes: true, attributeFilter: ["hidden"] });
    document.addEventListener("visibilitychange", sync);
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

  // extension/src/local-preferences.ts
  var localPreferencesKey = "moodshiftSoundPreferences";
  var personalizationKey = "moodshiftPersonalization";
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
  async function promptPreferences(prompt) {
    const values = await chrome.storage.local.get([personalizationKey, localPreferencesKey]);
    if (values[personalizationKey]?.enabled !== true) return;
    const matches = relevantPreferences(prompt, parseLocalPreferences(values[localPreferencesKey]).map((row) => row.text));
    return matches.length ? matches : void 0;
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
  function parseSettings(value) {
    return { enabled: value?.enabled === true };
  }
  async function updateSettings(enabled) {
    const next = { enabled };
    await chrome.storage.local.set({ [personalizationKey]: next });
    return next;
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
      const changed = Boolean(settings?.enabled) !== Boolean(next?.enabled);
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
    async function run(work) {
      if (busy) return "Wait for the current preference action to finish.";
      busy = true;
      controls2();
      state.textContent = "Working\u2026";
      try {
        const message = await work();
        state.textContent = message;
        return message;
      } catch (error) {
        console.warn("MoodShift sound preference action failed", error);
        const message = "Couldn\u2019t update your sound preferences. Try again.";
        state.textContent = message;
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
          setSettings(await updateSettings(enabled));
        } catch {
          setSettings(parseSettings((await chrome.storage.local.get(personalizationKey))[personalizationKey]));
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
      if (changes[personalizationKey]) setSettings(parseSettings(changes[personalizationKey].newValue));
      if (changes[localPreferencesKey]) {
        try {
          showLocal(parseLocalPreferences(changes[localPreferencesKey].newValue));
        } catch {
          state.textContent = "Could not read saved local preferences.";
        }
      }
    });
    void chrome.storage.local.get(personalizationKey).then((values) => setSettings(parseSettings(values[personalizationKey]))).catch(() => {
      state.textContent = "Could not read personalization settings.";
    });
    void loadLocalPreferences().then(showLocal).catch(() => {
      state.textContent = "Could not read saved local preferences.";
    });
    return {
      remember
    };
  }

  // extension/src/panel-tabs.ts
  var tabKey = "moodshiftPanelTab";
  function mountPanelTabs() {
    const names = ["home", "settings"];
    const tabs = names.map((name) => document.querySelector(`#${name}-tab`));
    const panels = names.map((name) => document.querySelector(`#${name}-panel`));
    const controls2 = document.querySelector("#home-layout-controls");
    const notice = document.querySelector("#home-layout-status");
    let layout = readHomeLayout(void 0);
    const pending = /* @__PURE__ */ new Map();
    let selected = 0;
    const sections = homeSectionKeys.map((key) => {
      const home = document.querySelector(`#home-${key}`);
      const settings = document.querySelector(`#settings-${key}`);
      const element2 = settings.firstElementChild;
      const label = document.createElement("label");
      label.className = "home-option";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.dataset.homeSection = key;
      toggle.disabled = true;
      label.append(homeSections[key].label, toggle);
      controls2.append(label);
      toggle.addEventListener("change", () => {
        const edit = { checked: toggle.checked };
        pending.set(key, edit);
        updateSections();
        void setDisplay(`home.${key}`, edit.checked).then(() => {
          layout[key] = edit.checked;
          notice.textContent = "";
        }, () => {
          notice.textContent = "Couldn\u2019t save the Home layout. Please try again.";
        }).finally(() => {
          if (pending.get(key) === edit) pending.delete(key);
          updateSections();
        });
      });
      return { key, home, settings, element: element2, toggle };
    });
    function updateSections() {
      for (const { key, home, settings, element: element2, toggle } of sections) {
        const visible = pending.get(key)?.checked ?? layout[key];
        const destination = selected === 0 && visible ? home : settings;
        if (element2.parentElement !== destination) destination.append(element2);
        home.hidden = destination !== home;
        toggle.checked = visible;
      }
    }
    function select(index, focus = false) {
      selected = index;
      tabs.forEach((tab, current) => {
        const selected2 = current === index;
        tab.setAttribute("aria-selected", String(selected2));
        tab.tabIndex = selected2 ? 0 : -1;
        panels[current].hidden = !selected2;
      });
      updateSections();
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
    select(["advanced", "settings"].includes(localStorage.getItem(tabKey) ?? "") ? 1 : 0);
    observeDisplay((settings) => {
      layout = settings.home;
      updateSections();
      for (const { toggle } of sections) toggle.disabled = false;
    }, () => {
      notice.textContent = "Couldn\u2019t load the saved Home layout.";
    });
  }

  // extension/src/range-control.ts
  function paintRange(input) {
    input.style.setProperty("--fill", `${rangeFill(input.valueAsNumber, Number(input.min), Number(input.max))}%`);
  }

  // extension/src/reverb-panel.ts
  function mountReverb(root, change, editing) {
    const controls2 = root.querySelector("fieldset");
    const enabled = root.querySelector("#reverb-enabled");
    const preset = root.querySelector("#reverb-preset");
    const amount = root.querySelector("#effect-reverbMix");
    const duration = root.querySelector("#reverb-duration");
    const amountLabel = root.querySelector("#reverb-amount-value");
    const durationLabel = root.querySelector("#reverb-duration-value");
    const notice = root.querySelector("[role=status]");
    let durationEditing = false;
    let sessionId2;
    amount.max = String(effectSpecs.reverbMix.max);
    duration.min = String(reverbDuration.min);
    duration.max = String(reverbDuration.max);
    duration.step = String(reverbDuration.step);
    for (const [key, definition] of Object.entries(reverbPresets)) preset.add(new Option(definition.label, key));
    enabled.addEventListener("change", () => {
      editing();
      change({ enabled: enabled.checked });
    });
    preset.addEventListener("change", () => {
      editing();
      change({ preset: preset.value });
    });
    amount.addEventListener("input", () => {
      editing();
      paintRange(amount);
      amountLabel.value = `${Math.round(amount.valueAsNumber * 100)}%`;
      change({ amount: amount.valueAsNumber });
    });
    duration.addEventListener("input", () => {
      editing();
      durationEditing = true;
      paintRange(duration);
      durationLabel.value = `${duration.valueAsNumber.toFixed(1)} s`;
    });
    duration.addEventListener("change", () => {
      editing();
      durationEditing = false;
      change({ duration: duration.valueAsNumber });
    });
    return {
      render(status2, ready) {
        controls2.disabled = !ready;
        const capture = status2.phase === "capturing" ? status2 : void 0;
        if (capture?.session.id !== sessionId2) {
          durationEditing = false;
          sessionId2 = capture?.session.id;
        }
        const settings = capture?.reverb ?? defaultReverb;
        const mix = capture?.effects.reverbMix ?? 0;
        enabled.checked = mix > 0;
        preset.value = settings.preset;
        amount.value = String(mix);
        amountLabel.value = `${Math.round(mix * 100)}%`;
        if (!durationEditing) {
          duration.value = String(settings.duration);
          durationLabel.value = `${settings.duration.toFixed(1)} s`;
        }
        paintRange(amount);
        paintRange(duration);
        const speed = capture?.reverb?.speed;
        notice.textContent = mix > 0 && settings.preset === "slowed" ? speed?.state === "active" ? `Playback slowed to ${Number(speed.rate.toFixed(2))}\xD7` : speed?.message ?? "Reverb active. Playback slowing is unavailable." : "";
      }
    };
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

  // extension/src/shared/track.ts
  var platforms = { youtube: "YouTube", spotify: "Spotify", soundcloud: "SoundCloud", tab: "Browser audio" };
  function youtubeArtwork(videoId) {
    if (/^[\w-]{11}$/.test(videoId)) return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  }
  function trackTitle(title, platform) {
    const suffix = ` - ${platforms[platform]}`;
    return title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() || title : title;
  }

  // extension/src/now-playing.ts
  var marks = {
    youtube: '<rect x="2" y="5" width="20" height="14" rx="4" fill="currentColor"/><path d="m10 9 6 3-6 3z" fill="var(--panel)"/>',
    spotify: '<circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M6 9c4-1 8-.6 12 1.5M7 12.5c3.5-.7 6.5-.4 10 1M8 16c3-.6 5-.3 7 .7" fill="none" stroke="var(--panel)" stroke-width="1.5" stroke-linecap="round"/>',
    soundcloud: '<path d="M10 17V8a5.5 5.5 0 0 1 9 3.5 2.8 2.8 0 1 1 1 5.5z" fill="currentColor"/><path d="M2 14v2m3-4v5m3-7v7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    tab: '<path d="M9 17V6l10-2v11M9 9l10-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><ellipse cx="6" cy="17" rx="3.5" ry="2.5" fill="currentColor"/><ellipse cx="16" cy="15" rx="3.5" ry="2.5" fill="currentColor"/>'
  };
  function mountNowPlaying() {
    const title = document.querySelector("#status");
    const artist = document.querySelector("#track-artist");
    const source = document.querySelector("#track-platform");
    const artwork = document.querySelector("#song-artwork");
    const frame = document.querySelector("#track-art");
    const icon = document.querySelector("#platform-icon");
    let status2 = { phase: "ready" };
    let playback = null;
    let imageUrl;
    let platform;
    artwork.addEventListener("load", () => {
      artwork.hidden = !imageUrl || artwork.currentSrc !== imageUrl;
    });
    artwork.addEventListener("error", () => {
      artwork.hidden = true;
    });
    function render2() {
      const session = status2.phase === "capturing" ? status2.session : void 0;
      const current = session?.platform ?? "tab";
      frame.parentElement.dataset.phase = status2.phase;
      if (current !== platform) {
        platform = current;
        frame.dataset.platform = current;
        icon.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22">${marks[current]}</svg>`;
      }
      const song = session && !playback?.ad ? playback?.song : void 0;
      const nextImage = song?.title && playback && "videoId" in playback ? youtubeArtwork(playback.videoId) : void 0;
      if (nextImage !== imageUrl) {
        imageUrl = nextImage;
        artwork.hidden = true;
        if (nextImage) artwork.src = nextImage;
        else artwork.removeAttribute("src");
      }
      const setText = (element2, value) => {
        if (element2.textContent !== value) element2.textContent = value;
      };
      setText(source, session ? platforms[current] : "Now playing");
      setText(title, session ? song?.title || trackTitle(session.title, current) : status2.phase === "starting" ? "Connecting to this tab\u2026" : status2.phase === "error" ? "Couldn\u2019t connect to this tab" : "Choose a playing tab");
      setText(artist, session ? song?.artist ?? "" : status2.phase === "error" ? status2.message : status2.phase === "starting" ? status2.source.title : "Click the MoodShift icon on the tab.");
      title.title = title.textContent ?? "";
      artist.title = artist.textContent ?? "";
      artist.hidden = !artist.textContent;
    }
    return {
      setStatus(next) {
        const previous = status2.phase === "capturing" ? status2.session : void 0;
        const session = next.phase === "capturing" ? next.session : void 0;
        if (previous?.id !== session?.id || previous?.title !== session?.title || previous?.platform !== session?.platform) playback = null;
        status2 = next;
        render2();
      },
      setPlayback(next) {
        playback = next;
        render2();
      }
    };
  }

  // extension/src/tuning-client.ts
  var sessionId = (status2) => status2.phase === "capturing" ? status2.session.id : void 0;
  function mergeEdit(a, b) {
    if (a.kind === "pitch" && b.kind === "pitch") return { kind: "pitch", patch: { ...a.patch, ...b.patch } };
    if (a.kind === "eq-band" && b.kind === "eq-band" && a.id === b.id) return { ...b, patch: { ...a.patch, ...b.patch } };
  }
  var TuningClient = class {
    constructor(report, editing = () => {
    }) {
      this.report = report;
      this.editing = editing;
      this.listeners = /* @__PURE__ */ new Set();
      this.queue = [];
      this.current = { phase: "ready" };
      this.loaded = false;
      this.request = 0;
    }
    get busy() {
      return Boolean(this.queue.length || this.inFlight);
    }
    get view() {
      let settings = this.current.tuning ?? defaultTuning();
      const source = sessionId(this.current);
      for (const pending of [this.inFlight, ...this.queue]) {
        if (!pending || pending.sessionId !== source) continue;
        try {
          settings = changeTuning(settings, pending.action);
        } catch {
        }
      }
      return { settings, status: this.current, ready: this.loaded && this.current.phase !== "starting" };
    }
    subscribe(listener) {
      this.listeners.add(listener);
      listener(this.view);
    }
    notify() {
      const view = this.view;
      for (const listener of this.listeners) listener(view);
    }
    accept(status2) {
      if (status2.phase === "capturing" && this.current.phase === "capturing" && status2.session.id === this.current.session.id && status2.revision < this.current.revision) return;
      this.current = status2;
      this.loaded = Boolean(status2.tuning);
      this.notify();
    }
    async refresh() {
      const id = ++this.request;
      try {
        const reply = await toWorker({ type: "GET_STATUS" });
        if (id === this.request && reply.ok) this.accept(reply.status);
      } catch (error) {
        console.warn("MoodShift tuning status unavailable", error);
        if (id === this.request) this.report("Couldn\u2019t load audio settings. Reopen MoodShift to reconnect.");
      }
    }
    edit(action, scrub = false) {
      if (!this.view.ready) return;
      try {
        changeTuning(this.view.settings, action);
      } catch (error) {
        this.report(error instanceof Error ? error.message : "Couldn\u2019t edit this setting.");
        return;
      }
      this.editing();
      const source = sessionId(this.current);
      const tail = this.queue.at(-1);
      const merged = tail && tail.sessionId === source ? mergeEdit(tail.action, action) : void 0;
      if (merged) tail.action = merged;
      else this.queue.push({ sessionId: source, action });
      this.report("");
      this.notify();
      if (scrub) this.timer ??= setTimeout(() => {
        this.timer = void 0;
        void this.flush();
      }, 42);
      else {
        clearTimeout(this.timer);
        this.timer = void 0;
        void this.flush();
      }
    }
    async flush() {
      if (this.inFlight) return;
      while (this.queue.length && !this.timer) {
        const pending = this.queue.shift();
        if (pending.sessionId !== sessionId(this.current)) continue;
        this.inFlight = pending;
        let acknowledged;
        try {
          const reply = await toWorker({ type: "SET_TUNING", sessionId: pending.sessionId, edit: pending.action });
          if (!reply.ok) throw new Error(reply.message);
          acknowledged = reply.status;
        } catch (error) {
          console.warn("MoodShift tuning edit failed", error);
          this.report("Couldn\u2019t update this audio setting. Please try again.");
        } finally {
          this.inFlight = void 0;
        }
        if (acknowledged && pending.sessionId === sessionId(this.current)) this.accept(acknowledged);
        else {
          this.notify();
          void this.refresh();
        }
      }
    }
  };

  // extension/src/shared/eq-response.ts
  var logSpan = Math.log(eqRange.maxHz / eqRange.minHz);
  var frequencyAt = (position) => eqRange.minHz * Math.exp(position * logSpan);
  var frequencyPosition = (frequency) => Math.log(frequency / eqRange.minHz) / logSpan;
  var effectiveFrequency = (frequency, rate) => Math.min(frequency, rate * 0.499);
  function equalizerResponse(eq, rate) {
    const bands = eq.enabled ? eq.bands.filter((band) => band.gain !== 0) : [];
    const coefficients = bands.map(({ frequency, gain, q }) => {
      const omega = 2 * Math.PI * effectiveFrequency(frequency, rate) / rate;
      const alpha = Math.sin(omega) / (2 * q);
      const amplitude = 10 ** (gain / 40);
      return { center: Math.cos(omega), numerator: alpha * amplitude, denominator: alpha / amplitude };
    });
    const rawDb = (hz) => {
      const omega = 2 * Math.PI * effectiveFrequency(hz, rate) / rate;
      const cosine = Math.cos(omega), sine = Math.sin(omega);
      let db = 0;
      for (const { center, numerator, denominator } of coefficients) {
        const realSquared = (cosine - center) ** 2;
        db += 10 * Math.log10((realSquared + (numerator * sine) ** 2) / (realSquared + (denominator * sine) ** 2));
      }
      return db;
    };
    let peak = 0;
    if (bands.some((band) => band.gain > 0)) {
      for (let i = 0; i <= 240; i++) peak = Math.max(peak, rawDb(frequencyAt(i / 240)));
      for (const band of bands) peak = Math.max(peak, rawDb(band.frequency));
    }
    const trimDb = Math.min(0, 12 - peak);
    return { trimDb, gainDb: (hz) => rawDb(hz) + trimDb };
  }

  // extension/src/eq-chart.ts
  function frequencyLabel(hz) {
    return hz >= 1e3 ? `${Number((hz / 1e3).toFixed(1))}k` : String(Math.round(hz));
  }
  var gainLabel = (gain) => `${gain > 0 ? "+" : ""}${gain.toFixed(1)}`;
  var gainSpan = eqRange.maxGain - eqRange.minGain;
  var clampUnit = (n) => Math.max(0, Math.min(1, n));
  var points = 256;
  var EqChart = class {
    constructor(canvas, compact, onResize) {
      this.canvas = canvas;
      this.compact = compact;
      this.context = this.canvas.getContext("2d");
      this.colors = getComputedStyle(this.canvas);
      this.accent = this.colors.getPropertyValue("--accent").trim();
      this.muted = this.colors.getPropertyValue("--muted").trim();
      this.line = this.colors.getPropertyValue("--line").trim();
      this.curve = new Float32Array(points + 1);
      this.width = 0;
      this.height = 0;
      this.ratio = 1;
      this.rate = 48e3;
      this.trimDb = 0;
      new ResizeObserver(([{ contentRect }]) => {
        this.width = contentRect.width;
        this.height = contentRect.height;
        this.ratio = Math.min(devicePixelRatio, 2);
        canvas.width = Math.round(this.width * this.ratio);
        canvas.height = Math.round(this.height * this.ratio);
        this.draw();
        onResize?.();
      }).observe(canvas);
    }
    get left() {
      return this.compact ? 26 : 48;
    }
    get top() {
      return this.compact ? 8 : 18;
    }
    get graphWidth() {
      return Math.max(1, this.width - this.left - (this.compact ? 9 : 22));
    }
    get graphHeight() {
      return Math.max(1, this.height - this.top - (this.compact ? 18 : 30));
    }
    y(gain) {
      return this.top + (eqRange.maxGain - gain) / gainSpan * this.graphHeight;
    }
    position(band) {
      return { x: this.left + frequencyPosition(band.frequency) * this.graphWidth, y: this.y(band.gain) };
    }
    editAt(clientX, clientY, clamp2 = true) {
      const rect = this.canvas.getBoundingClientRect();
      const x = (clientX - rect.x - this.left) / this.graphWidth;
      const y = (clientY - rect.y - this.top) / this.graphHeight;
      if (!clamp2 && (x < 0 || x > 1 || y < 0 || y > 1)) return;
      return { frequency: Math.round(frequencyAt(clampUnit(x))), gain: Number((eqRange.maxGain - gainSpan * clampUnit(y)).toFixed(1)) };
    }
    setEq(eq, rate = 48e3) {
      if (this.eq === eq && this.rate === rate) return;
      this.eq = eq;
      this.rate = rate;
      const { gainDb, trimDb } = equalizerResponse(eq, rate);
      this.trimDb = trimDb;
      for (let i = 0; i <= points; i++) this.curve[i] = gainDb(frequencyAt(i / points));
      this.draw();
    }
    setSpectrum(data) {
      this.spectrum = data;
      this.draw();
    }
    draw() {
      const { context: ctx, left, top, graphHeight: height, graphWidth: width } = this;
      if (!this.width || !this.height) return;
      ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.font = `${this.compact ? 9 : 11}px system-ui, sans-serif`;
      ctx.strokeStyle = this.line;
      ctx.fillStyle = this.muted;
      ctx.lineWidth = 1;
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      for (const db of this.compact ? [-12, 0, 12] : [-12, -6, 0, 6, 12]) {
        const y = this.y(db);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + width, y);
        ctx.stroke();
        ctx.fillText(`${db > 0 ? "+" : ""}${db}${this.compact ? "" : " dB"}`, left - 5, y);
      }
      ctx.textAlign = "center";
      const ticks = this.compact ? [60, 400, 3e3, 1e4] : [20, 60, 200, 600, 2e3, 6e3, 2e4];
      for (const hz of ticks) {
        const x = left + frequencyPosition(hz) * width;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + height);
        ctx.stroke();
        ctx.fillText(frequencyLabel(hz), x, top + height + (this.compact ? 9 : 15));
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, width, height);
      ctx.clip();
      if (this.spectrum?.length) {
        ctx.beginPath();
        ctx.moveTo(left, top + height);
        this.spectrum.forEach((level, i, values) => {
          const x = left + i / (values.length - 1) * width;
          const y = top + height * (1 - level / 255 * 0.86);
          ctx.lineTo(x, y);
        });
        ctx.lineTo(left + width, top + height);
        ctx.closePath();
        ctx.fillStyle = this.accent;
        ctx.globalAlpha = 0.17;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      for (let i = 0; i <= points; i++) {
        const frequency = frequencyAt(i / points);
        if (frequency > effectiveFrequency(frequency, this.rate)) break;
        const x = left + i / points * width, y = this.y(this.curve[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = this.accent;
      ctx.lineWidth = this.compact ? 1.6 : 2;
      ctx.stroke();
      ctx.restore();
    }
  };

  // extension/src/eq-preset-controls.ts
  function mountEqPresetControls(root, client, report) {
    const select = root.querySelector("[data-eq-preset]");
    const form2 = root.querySelector("#eq-preset-form");
    const name = form2?.querySelector("input");
    const remove = root.querySelector("#eq-preset-delete");
    let presets2 = [];
    let busy = false;
    function refreshSelection() {
      const { settings, ready } = client.view;
      const id = settings.eq.preset ?? "";
      select.value = [...select.options].some((option) => option.value === id) ? id : "";
      select.disabled = busy || !ready;
      if (remove) remove.hidden = !presets2.some((preset) => preset.id === select.value);
    }
    function drawPresets() {
      const custom = new Option("Custom curve", "");
      custom.disabled = true;
      select.replaceChildren(custom, ...Object.entries(eqPresets).map(([id, { name: name2 }]) => new Option(name2, id)));
      if (presets2.length) {
        const saved = document.createElement("optgroup");
        saved.label = "Saved EQ presets";
        for (const preset of presets2) saved.append(new Option(preset.name, preset.id));
        select.append(saved);
      }
      refreshSelection();
    }
    async function run(work) {
      if (busy) return;
      busy = true;
      refreshSelection();
      try {
        report(await work());
      } catch (error) {
        report(error instanceof Error ? error.message : "Couldn\u2019t update your EQ presets.");
      } finally {
        busy = false;
        refreshSelection();
      }
    }
    select.addEventListener("change", () => {
      const saved = presets2.find((preset) => preset.id === select.value);
      client.edit({ kind: "eq-preset", preset: select.value, ...saved ? { bands: saved.bands } : {} });
    });
    form2?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!client.view.ready || !name) return;
      void run(async () => {
        const preset = await saveEqPreset(name.value, client.view.settings.eq.bands);
        name.value = "";
        presets2 = await loadEqPresets();
        drawPresets();
        return `Saved ${preset.name}.`;
      });
    });
    remove?.addEventListener("click", () => {
      const id = select.value;
      if (!presets2.some((preset) => preset.id === id)) return;
      void run(async () => {
        await deleteEqPreset(id);
        client.edit({ kind: "eq-forget", preset: id });
        return "EQ preset deleted.";
      });
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[eqPresetsKey]) return;
      presets2 = readEqPresets(changes[eqPresetsKey].newValue);
      drawPresets();
    });
    client.subscribe(refreshSelection);
    drawPresets();
    void loadEqPresets().then((saved) => {
      presets2 = saved;
      drawPresets();
    }).catch(() => report("Couldn\u2019t load your saved EQ presets."));
  }

  // extension/src/tuning-panel.ts
  function mountPitch(root, client) {
    const enabled = root.querySelector("#pitch-enabled");
    const slider = root.querySelector("#pitch-value");
    const value = root.querySelector("#pitch-readout");
    const reset2 = root.querySelector("#pitch-reset");
    const notice = root.querySelector("#pitch-status");
    const controls2 = root.querySelector("fieldset");
    slider.min = String(pitchRange.min);
    slider.max = String(pitchRange.max);
    slider.step = String(pitchRange.step);
    enabled.addEventListener("change", () => client.edit({ kind: "pitch", patch: { enabled: enabled.checked } }));
    slider.addEventListener("input", () => client.edit({ kind: "pitch", patch: { enabled: true, semitones: slider.valueAsNumber } }, true));
    slider.addEventListener("change", () => client.edit({ kind: "pitch", patch: { enabled: true, semitones: slider.valueAsNumber } }));
    reset2.addEventListener("click", () => client.edit({ kind: "pitch", patch: { semitones: 0 } }));
    client.subscribe(({ settings, status: status2, ready }) => {
      const { pitch: pitch2 } = settings;
      const playback = status2.phase === "capturing" ? status2.audioTiming?.pitch : void 0;
      controls2.disabled = !ready;
      enabled.checked = pitch2.enabled;
      slider.value = String(pitch2.semitones);
      value.value = `${gainLabel(pitch2.semitones)} st`;
      slider.setAttribute("aria-valuetext", `${gainLabel(pitch2.semitones)} semitones`);
      reset2.disabled = pitch2.semitones === 0;
      paintRange(slider);
      let text = "";
      switch (playback?.phase) {
        case "starting":
          text = "Starting pitch control\u2026";
          break;
        case "unavailable":
          text = "Pitch could not start. Turn it off and on to try again.";
          break;
      }
      if (notice.textContent !== text) notice.textContent = text;
    });
  }
  function mountCompactEq(root, client, report) {
    const graph = new EqChart(root.querySelector("canvas"), true);
    const enabled = root.querySelector("#eq-enabled");
    const reset2 = root.querySelector("#eq-reset");
    const controls2 = root.querySelector("fieldset");
    const bands = root.querySelector("#eq-bands");
    const expand = root.querySelector("#open-domain");
    const knobs = defaultBands.map(({ id, name }) => {
      const label = document.createElement("label");
      const value = document.createElement("output");
      const frequency = document.createElement("span");
      const track = document.createElement("span");
      const input = document.createElement("input");
      label.className = "eq-band";
      track.className = "eq-slider-track";
      input.id = `eq-band-${id}`;
      input.type = "range";
      input.min = String(eqRange.minGain);
      input.max = String(eqRange.maxGain);
      input.step = "0.1";
      input.setAttribute("aria-orientation", "vertical");
      value.htmlFor = input.id;
      track.append(input);
      label.append(value, track, frequency);
      bands.append(label);
      const edit = (scrub) => client.edit({ kind: "eq-band", id, patch: { gain: input.valueAsNumber } }, scrub);
      input.addEventListener("input", () => edit(true));
      input.addEventListener("change", () => edit(false));
      return { id, name, input, value, frequency };
    });
    enabled.addEventListener("change", () => client.edit({ kind: "eq-enabled", enabled: enabled.checked }));
    reset2.addEventListener("click", () => client.edit({ kind: "eq-reset" }));
    expand.addEventListener("click", () => {
      void chrome.tabs.create({ url: chrome.runtime.getURL("domain.html") }).catch((error) => {
        console.warn("MoodShift could not open Domain Expansion", error);
        report("Couldn\u2019t open Domain Expansion. Please try again.");
      });
    });
    mountEqPresetControls(root, client, report);
    client.subscribe(({ settings, status: status2, ready }) => {
      controls2.disabled = !ready;
      enabled.checked = settings.eq.enabled;
      graph.setEq(settings.eq, status2.phase === "capturing" ? status2.audioTiming?.sampleRate : void 0);
      for (const [i, { name, input, value, frequency }] of knobs.entries()) {
        const band = settings.eq.bands[i];
        const db = gainLabel(band.gain);
        input.value = String(band.gain);
        input.setAttribute("aria-label", `${name}, ${band.frequency} Hz`);
        input.setAttribute("aria-valuetext", `${db} dB`);
        value.value = db;
        frequency.textContent = frequencyLabel(band.frequency);
        frequency.title = `${band.frequency} Hz`;
        paintRange(input);
      }
    });
  }

  // extension/src/api-client.ts
  var demoCodeKey = "moodshiftDemoAccessCode";
  var cloudAccessMessage = "Online processing isn\u2019t set up for this installation. Contact whoever provided MoodShift.";
  var CloudAccessError = class extends Error {
  };
  async function cloudDemoCode(config = deployment) {
    if (config.mode !== "production") return;
    const code = (await chrome.storage.local.get(demoCodeKey))[demoCodeKey];
    if (typeof code !== "string" || !demoCodePattern.test(code)) {
      throw new CloudAccessError(cloudAccessMessage);
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
  function apiErrorDetail(response) {
    console.warn("MoodShift online processing returned an error", response.status);
    if (response.status === 401 || response.status === 403) return cloudAccessMessage;
    if (response.status === 429) return "Too many requests right now. Try again in a moment.";
    if (response.status >= 500) return "Online processing is unavailable right now. Try again shortly.";
    return "Couldn\u2019t apply that request. Try describing the sound again.";
  }

  // extension/src/shared/controls.ts
  var controlActionLimit = 12;
  var controlPresetLimit = 30;
  var clamp = (value, { min, max }) => Math.min(max, Math.max(min, value));
  var frequencyRange = { min: eqRange.minHz, max: eqRange.maxHz };
  var gainRange = { min: eqRange.minGain, max: eqRange.maxGain };
  var qRange = { min: eqRange.minQ, max: eqRange.maxQ };
  var mixModes = ["original", "modified", ...stemModes];
  function numberTarget(action, current, neutral, range) {
    if (action.operation === "reset") return neutral;
    return clamp((action.operation === "adjust" ? current : 0) + action.value, range);
  }
  function numeric(label, range, neutral, current, apply) {
    return {
      label,
      parameter: { kind: "number", range },
      operations: ["set", "adjust", "reset"],
      apply: (state, action) => apply(state, numberTarget(action, current(state), neutral, range), action)
    };
  }
  function flag(label, apply) {
    return { label, parameter: { kind: "boolean" }, operations: ["set"], apply: (state, action) => apply(state, action.value) };
  }
  function choice(label, choices, apply) {
    return { label, parameter: { kind: "choice", choices }, operations: ["set"], apply: (state, action) => apply(state, action.value) };
  }
  function named(label, apply) {
    return { label, parameter: { kind: "name" }, operations: ["set"], apply: (state, action, saved) => apply(state, action.value, saved) };
  }
  function reset(label, apply) {
    return { label, parameter: { kind: "none" }, operations: ["reset"], apply };
  }
  function tune(state, edit) {
    state.tuning = changeTuning(state.tuning, edit);
  }
  function reverb(state, patch) {
    const next = changeReverb(state.reverb, state.effects.reverbMix, patch);
    state.reverb = next.settings;
    state.effects = applyPatch(state.effects, { reverbMix: next.mix });
  }
  function setMix(state, mode) {
    if (mode === "original" || mode === "modified") state.monitor = mode;
    else {
      state.monitor = "modified";
      state.stemMode = mode;
      state.selectStem = true;
    }
  }
  function setBand(state, id, patch) {
    tune(state, { kind: "eq-band", id, patch });
  }
  function frequencyEdit(label, property, range, fallback) {
    return {
      label,
      atFrequency: true,
      parameter: { kind: "number", range },
      operations: property === "frequency" ? ["set"] : ["set", "adjust", "reset"],
      apply(state, action) {
        const frequency = Math.round(clamp(action.frequency, frequencyRange));
        const band = state.tuning.eq.bands.find((item) => item.frequency === frequency);
        const target = numberTarget(action, band?.[property] ?? fallback, fallback, range);
        if (band) setBand(state, band.id, { [property]: target });
        else if (property === "gain" && target !== 0) {
          tune(state, { kind: "eq-add", point: { id: `point:${crypto.randomUUID()}`, frequency, gain: target, q: 1 } });
        } else if (action.operation !== "reset") throw new Error(`Add a gain adjustment at ${frequency} Hz before editing that EQ point.`);
        if (property === "gain" && target !== 0 && !state.tuning.eq.enabled) tune(state, { kind: "eq-enabled", enabled: true });
      }
    };
  }
  function findPreset(rows, name) {
    const preset = rows.find((row) => row.name.toLowerCase() === name.toLowerCase());
    if (!preset) throw new Error("That saved preset is no longer available.");
    return preset;
  }
  var displayControls = {
    "lyrics.offset": numeric(
      "Lyric and Songle chord timing offset (seconds, positive delays the display)",
      lyricOffsetRange,
      0,
      (state) => state.display.lyricsOffset,
      (state, value) => {
        state.display = { ...state.display, lyricsOffset: clampLyricsCorrection(value) };
      }
    ),
    "lyrics.follow": flag("Follow synchronized lyrics as the song plays", (state, value) => {
      state.display = { ...state.display, lyricsFollow: value };
    }),
    "lyrics.open": flag("Expand or collapse the Lyrics section", (state, value) => {
      state.display = { ...state.display, lyricsOpen: value };
    }),
    "chords.open": flag("Expand or collapse Chords in Settings", (state, value) => {
      state.display = { ...state.display, chordsOpen: value };
    }),
    ...Object.fromEntries(homeSectionKeys.map((key) => [`home.${key}`, flag(`Show ${homeSections[key].label} on Home`, (state, value) => {
      if (state.display.home[key] !== value) state.display = { ...state.display, home: { ...state.display.home, [key]: value } };
    })]))
  };
  var registry = {
    "audio.reset": reset("Reset all audio effects, pitch, EQ, reverb and source mix to normal", (state) => {
      state.effects = { ...neutralEffects };
      state.tuning = defaultTuning();
      state.reverb = { ...defaultReverb };
      setMix(state, "full");
    }),
    mix: choice("Select Original, Modified, Full Mix, Vocals only, or Instrumental without vocals", mixModes, setMix),
    ...Object.fromEntries(effectKeys.filter((key) => key !== "reverbMix").map((key) => {
      const spec = effectSpecs[key];
      return [key, numeric(
        `${spec.label} (${spec.unit === "%" ? "fraction from 0 to 1" : spec.unit})`,
        spec,
        spec.neutral,
        (state) => state.effects[key],
        (state, value) => {
          state.effects = applyPatch(state.effects, { [key]: value });
        }
      )];
    })),
    "pitch.enabled": flag("Enable or bypass pitch while retaining the value", (state, enabled) => tune(state, { kind: "pitch", patch: { enabled } })),
    "pitch.semitones": numeric(
      "Independent pitch in semitones. Preserve playback speed",
      pitchRange,
      0,
      (state) => state.tuning.pitch.semitones,
      (state, semitones, action) => tune(state, { kind: "pitch", patch: action.operation === "reset" ? { semitones } : { semitones, enabled: true } })
    ),
    "eq.enabled": flag("Enable or bypass the equalizer", (state, enabled) => tune(state, { kind: "eq-enabled", enabled })),
    ...Object.fromEntries(defaultBands.map((band) => [`eq.${band.id}`, numeric(
      `Equalizer ${band.name} gain (dB, default band ${band.frequency} Hz)`,
      gainRange,
      0,
      (state) => state.tuning.eq.bands.find((point) => point.id === band.id).gain,
      (state, gain) => {
        setBand(state, band.id, { gain });
        if (gain !== 0 && !state.tuning.eq.enabled) tune(state, { kind: "eq-enabled", enabled: true });
      }
    )])),
    "eq.frequency": frequencyEdit("Equalizer gain (dB) at a specific frequency. Can create a custom point", "gain", gainRange, 0),
    "eq.bandwidth": frequencyEdit("Bandwidth Q for an existing EQ point at the specified frequency. Higher Q is narrower", "q", qRange, 1),
    "eq.move": frequencyEdit("Move an existing EQ point from frequency to value in Hz", "frequency", frequencyRange, 0),
    "eq.remove": {
      label: "Remove a custom EQ point at the specified frequency",
      parameter: { kind: "none" },
      operations: ["remove"],
      atFrequency: true,
      apply(state, action) {
        const point = state.tuning.eq.bands.find((band) => band.frequency === Math.round(action.frequency) && band.id.startsWith("point:"));
        if (!point) throw new Error("There is no custom EQ point at that frequency.");
        tune(state, { kind: "eq-remove", id: point.id });
      }
    },
    "eq.reset": reset("Reset to the six flat EQ bands and clear custom points", (state) => tune(state, { kind: "eq-reset" })),
    "eq.preset": choice(
      `Built-in EQ preset ${Object.entries(eqPresets).map(([id, preset]) => `${id} (${preset.name})`).join(", ")}`,
      Object.keys(eqPresets),
      (state, preset) => tune(state, { kind: "eq-preset", preset })
    ),
    "eq.saved": named("Apply an existing saved EQ preset by exact name", (state, name, saved) => {
      const preset = findPreset(saved.eq, name);
      tune(state, { kind: "eq-preset", preset: preset.id, bands: preset.bands });
    }),
    "reverb.enabled": flag("Enable or disable reverb while remembering its amount", (state, enabled) => reverb(state, { enabled })),
    "reverb.preset": choice(
      `Reverb preset ${Object.entries(reverbPresets).map(([id, preset]) => `${id} (${preset.label})`).join(", ")}. Slowed changes speed on YouTube watch pages`,
      Object.keys(reverbPresets),
      (state, preset) => reverb(state, { preset })
    ),
    "reverb.amount": numeric(
      "Wet reverb mix as a fraction, for example 0.25 is 25%",
      effectSpecs.reverbMix,
      0,
      (state) => state.effects.reverbMix,
      (state, amount) => reverb(state, { amount })
    ),
    "reverb.duration": numeric(
      "Reverb tail duration in seconds",
      reverbDuration,
      defaultReverb.duration,
      (state) => state.reverb.duration,
      (state, duration) => reverb(state, { duration })
    ),
    preset: choice("Built-in audio preset", Object.keys(presets), (state, name) => {
      const effects = presets[name];
      reverb(state, { amount: effects.reverbMix });
      state.effects = { ...effects };
    }),
    "preset.saved": named("Apply an existing My Presets mix by exact name", (state, name, saved) => {
      const preset = findPreset(saved.audio, name);
      state.effects = { ...preset.audioSettings };
      if (preset.reverb) state.reverb = preset.reverb;
      if (preset.tuning) state.tuning = preset.tuning;
      state.monitor = preset.monitor;
      state.stemMode = preset.stemMode;
      state.selectStem = true;
    }),
    ...displayControls
  };
  var controlIds = Object.keys(registry);
  var controlDescriptions = Object.entries(registry).map(([control, { label, parameter, operations, atFrequency }]) => ({
    control,
    label,
    parameter,
    operations,
    ...atFrequency ? { frequencyHz: frequencyRange } : {}
  }));
  function record(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid MoodShift control response.");
    return input;
  }
  function cleanText(input, max) {
    if (typeof input !== "string" || !input.trim() || input.length > max || /[\u0000-\u001f\u007f]/.test(input)) {
      throw new Error("Invalid MoodShift control text.");
    }
    return input.trim();
  }
  function parseControlActions(input) {
    if (!Array.isArray(input) || input.length > controlActionLimit) throw new Error("Invalid number of changes.");
    return input.map((raw) => {
      const { control, operation, frequency, value, ...extra } = record(raw);
      if (Object.keys(extra).length || typeof control !== "string" || !Object.hasOwn(registry, control)) throw new Error("Unknown audio control.");
      const entry = registry[control];
      if (!entry.operations.includes(operation)) throw new Error("That operation is unavailable for this control.");
      if (entry.atFrequency ? typeof frequency !== "number" || !Number.isFinite(frequency) || frequency < frequencyRange.min || frequency > frequencyRange.max : frequency !== void 0) throw new Error("Invalid EQ point frequency.");
      const parameter = entry.parameter;
      if (operation === "reset" || operation === "remove") {
        if (value !== void 0) throw new Error("A reset or remove action takes no value.");
      } else if (parameter.kind === "number") {
        if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e5) throw new Error("Invalid numeric setting.");
      } else if (parameter.kind === "boolean") {
        if (typeof value !== "boolean") throw new Error("Invalid toggle setting.");
      } else if (parameter.kind === "choice") {
        if (typeof value !== "string" || !parameter.choices.includes(value)) throw new Error("Unknown setting choice.");
      } else if (parameter.kind === "name") {
        cleanText(value, 64);
      }
      return {
        control,
        operation,
        ...frequency === void 0 ? {} : { frequency },
        ...value === void 0 ? {} : { value: typeof value === "string" ? value.trim() : value }
      };
    });
  }
  function parseControlResult(input) {
    const { actions, summary, unsupported, ...extra } = record(input);
    if (Object.keys(extra).length || !Array.isArray(unsupported) || unsupported.length > 5) throw new Error("Invalid MoodShift response.");
    return { actions: parseControlActions(actions), summary: cleanText(summary, 240), unsupported: unsupported.map((text) => cleanText(text, 120)) };
  }

  // extension/src/natural-command.ts
  var CommandFeedbackError = class extends Error {
  };
  function legacyResult(input, effects) {
    const result = parseInterpretation(input, effects);
    const changes = result.mode === "reset" ? neutralEffects : result.patch;
    const actions = [];
    for (const key of effectKeys) {
      if (changes[key] === void 0) continue;
      actions.push({ control: key === "reverbMix" ? "reverb.amount" : key, operation: "set", value: changes[key] });
    }
    if (result.stemMode) actions.push({ control: "mix", operation: "set", value: result.stemMode });
    return { actions, summary: result.summary, unsupported: result.unsupported };
  }
  async function runNaturalCommand(text, options) {
    const prompt = text.trim();
    if (!prompt || prompt.length > 500) throw new CommandFeedbackError("Try a short audio command of up to 500 characters.");
    options.signal.throwIfAborted();
    const reply = await toWorker({ type: "GET_STATUS" });
    if (!reply.ok || reply.status.phase !== "capturing" || options.sessionId && reply.status.session.id !== options.sessionId) {
      throw new CommandFeedbackError("Select a playing tab with the MoodShift icon first.");
    }
    const capture = reply.status;
    const preference = explicitPreference(prompt);
    if (preference) {
      options.signal.throwIfAborted();
      await editLocalPreference({ text: preference });
      return { message: "Preference saved on this device." };
    }
    const [display, saved, localPreferences] = await Promise.all([
      loadDisplay(),
      loadControlPresets(),
      promptPreferences(prompt).catch(() => void 0)
    ]);
    options.signal.throwIfAborted();
    const { session, effects, revision, features, outputPaused } = capture;
    const direct = directStemIntent(prompt);
    let result;
    let legacy = false;
    if (direct === "unsupported") return { message: "Unsupported \xB7 Beat, drum and bass isolation require separate stems." };
    if (direct) {
      result = {
        actions: [{ control: "mix", operation: "set", value: direct }],
        summary: direct === "full" ? "Full Mix" : direct === "vocals" ? "Vocals" : "Instrumental",
        unsupported: []
      };
    } else {
      const request = { prompt, currentEffects: effects, audioFeatures: session.muted || outputPaused ? silentFeatures : features, localPreferences };
      const { effects: _effects, ...settings } = controlState(capture, display);
      const names = (rows) => rows.map((row) => row.name).filter((name) => !/[\u0000-\u001f\u007f]/.test(name)).slice(0, controlPresetLimit);
      const deadline = AbortSignal.timeout(15e3);
      const signal = AbortSignal.any([options.signal, deadline]);
      try {
        let response = await apiRequest("/api/interpret/v2", { ...request, controls: {
          ...settings,
          savedAudio: names(saved.audio),
          savedEq: names(saved.eq),
          youtubeWatch: session.platform === "youtube"
        } }, signal);
        if (response.status === 404) {
          legacy = true;
          await response.body?.cancel();
          response = await apiRequest("/api/interpret", request, signal);
        }
        if (response.status === 504) throw new CommandFeedbackError("Gemini timed out. Try again.");
        if (response.status >= 500) throw new CommandFeedbackError("Gemini unavailable. Presets and manual controls still work.");
        if (!response.ok) throw new CommandFeedbackError(apiErrorDetail(response));
        const body = await response.json();
        result = legacy ? legacyResult(body, effects) : parseControlResult(body);
      } catch (error) {
        options.signal.throwIfAborted();
        if (deadline.aborted) throw new CommandFeedbackError("Gemini timed out. Try again.");
        if (error instanceof TypeError) throw new CommandFeedbackError("Gemini unavailable. Presets and manual controls still work.");
        if (error instanceof CloudAccessError) throw new CommandFeedbackError(error.message);
        throw error;
      }
    }
    const limitation = result.unsupported.length ? ` Unsupported \xB7 ${result.unsupported.join(", ")}` : "";
    if (!result.actions.length) return { message: `${result.summary}${limitation}${legacy && limitation ? " The configured backend uses the older command API." : ""}` };
    options.signal.throwIfAborted();
    options.applying?.();
    const changed = await toWorker({
      type: "APPLY_CONTROLS",
      sessionId: session.id,
      baseRevision: revision,
      actions: result.actions,
      expectedDisplay: display
    });
    if (!changed.ok) throw new CommandFeedbackError(changed.message);
    let confirmation = result.summary;
    const pitch2 = changed.status.tuning?.pitch;
    if (pitch2 && result.actions.every((action) => action.control.startsWith("pitch."))) {
      confirmation = pitch2.enabled ? `Pitch ${pitch2.semitones > 0 ? "+" : ""}${pitch2.semitones.toFixed(1)} st.` : "Pitch off.";
    }
    const notices = changed.notices ?? [];
    const message = notices.length ? `${changed.applied ? "Settings updated. " : ""}${notices.join(" ")}` : changed.applied ? `Applied \u2713 \xB7 ${confirmation}` : `Already set. ${confirmation}`;
    return { message: message + limitation, status: changed.status };
  }

  // extension/src/sidepanel.ts
  mountPanelTabs();
  var nowPlaying = mountNowPlaying();
  var chords = mountChords(document.querySelector("#chords"));
  var lyrics = mountLyrics(document.querySelector("#lyrics"), (playback, offset) => {
    nowPlaying.setPlayback(playback);
    chords.setPlayback(playback, offset);
  });
  var stopButton = document.querySelector("#stop");
  var meter = document.querySelector("#meter");
  var inputStatus = document.querySelector("#input-status");
  var feedback = document.querySelector("#feedback");
  var controls = document.querySelector("#controls");
  var presetGroup = document.querySelector("#presets");
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
  var interpretation;
  var savedPresets = mountSavedPresets(document.querySelector("#saved-presets"), readCapture, restorePreset);
  var personalization = mountPersonalization(document.querySelector("#personalization"), () => {
    if (interpretation) {
      cancelInterpretation();
      feedback.textContent = "Personalization changed. Submit the prompt again.";
    }
  });
  var reverb2 = mountReverb(document.querySelector("#audio-effects"), (patch) => {
    if (status.phase === "capturing") void command({ type: "SET_REVERB", sessionId: status.session.id, patch });
  }, cancelInterpretation);
  var tuning = new TuningClient((message) => {
    feedback.textContent = message;
  }, cancelInterpretation);
  mountPitch(document.querySelector("#pitch-control"), tuning);
  mountCompactEq(document.querySelector("#equalizer"), tuning, (message) => {
    feedback.textContent = message;
  });
  tuning.subscribe(() => updateApply());
  document.querySelector("#cloud-stem-note").hidden = !usesCloudStems();
  function updateApply() {
    applyButton.disabled = status.phase !== "capturing" || stopping || commandPending || tuning.busy || interpretation !== void 0 || Object.keys(queuedEdits).length > 0 || !promptInput.value.trim();
    savedPresets.setCaptureReady(status.phase === "capturing" && !stopping && !commandPending && !tuning.busy && !interpretation && !Object.keys(queuedEdits).length && status.stem.phase !== "loading" && status.stem.phase !== "buffering");
  }
  function cancelInterpretation() {
    interpretation?.controller.abort();
    interpretation = void 0;
    updateApply();
  }
  function renderMeter(features) {
    const capture = status.phase === "capturing" ? status : void 0;
    meter.value = capture && !capture.session.muted && !capture.outputPaused ? Math.sqrt(features.rms) : 0;
    inputStatus.textContent = capture?.outputPaused ? "Audio paused. Click MoodShift on the playing tab to resume." : capture?.session.muted ? "Source tab muted." : capture && features.isSilent ? "Paused or silent input." : "";
  }
  function displayValue(value, unit) {
    if (unit === "%") return `${Math.round(value * 100)}%`;
    return `${Number(value.toFixed(1))} ${unit}`;
  }
  var sliders = effectKeys.filter((key) => key !== "reverbMix").map((key) => {
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
      paintRange(input);
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
  var quickPresets = ["Dreamy", "Warm", "Bass Boost", "Underwater"];
  var presetEmojis = { Dreamy: "\u{1F319}", Warm: "\u2600\uFE0F", "Bass Boost": "\u{1F50A}", Underwater: "\u{1F30A}" };
  var morePresets = document.querySelector("#other-presets");
  var presetButtons = [...Object.entries(presets), ["Reset", neutralEffects]].map(([name, patch]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.audioPreset = name;
    const emoji = presetEmojis[name];
    if (emoji) {
      const icon = document.createElement("span");
      icon.textContent = emoji;
      icon.setAttribute("aria-hidden", "true");
      icon.className = "preset-emoji";
      button.append(icon, name);
      button.setAttribute("aria-label", name);
    } else button.textContent = name;
    button.addEventListener("click", () => {
      clearEdits();
      applyLocal(patch);
    });
    (quickPresets.includes(name) ? presetGroup : morePresets).append(button);
    return { button, patch, name };
  });
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
      cancelInterpretation();
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
    tuning.accept(next);
    nowPlaying.setStatus(next);
    chords.setCapture(nextId);
    lyrics.setSource(next.phase === "capturing" ? next.session : void 0);
    lyrics.setTiming(next.phase === "capturing" ? next.audioTiming : void 0);
    updateApply();
    stopButton.disabled = next.phase !== "capturing" || stopping;
    const enabled = !stopButton.disabled && !presetApplying;
    reverb2.render(next, enabled);
    controls.disabled = !enabled;
    for (const { button, patch, name } of presetButtons) {
      button.disabled = !enabled;
      if (name !== "Reset") button.setAttribute("aria-pressed", String(next.phase === "capturing" && effectKeys.every((key) => (queuedEdits[key] ?? next.effects[key]) === patch[key])));
    }
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
        stemLabel.textContent = "Preparing your mix\u2026 The song will keep playing.";
        break;
      case "active":
        stemLabel.textContent = next.phase === "capturing" && next.monitor === "original" ? "Playing the original mix." : "Your separated mix can play a few seconds behind the video.";
        break;
      case "unavailable":
        stemLabel.textContent = "Couldn\u2019t separate the audio. Full Mix is still playing.";
        break;
      default:
        stemLabel.textContent = "";
    }
    const effects = next.phase === "capturing" ? next.effects : neutralEffects;
    for (const { key, input, value } of sliders) {
      const setting = queuedEdits[key] ?? effects[key];
      input.value = String(setting);
      paintRange(input);
      value.textContent = displayValue(setting, effectSpecs[key].unit);
    }
    renderMeter(next.phase === "capturing" ? next.features : silentFeatures);
  }
  async function readCapture() {
    if (status.phase !== "capturing" || commandPending || stopping || interpretation || tuning.busy || Object.keys(queuedEdits).length) {
      throw new Error("Wait for the current audio change to finish.");
    }
    const sessionId2 = status.session.id;
    const reply = await toWorker({ type: "GET_STATUS" });
    if (!reply.ok || reply.status.phase !== "capturing" || reply.status.session.id !== sessionId2 || status.phase !== "capturing" || status.session.id !== sessionId2 || commandPending || stopping || interpretation || tuning.busy || Object.keys(queuedEdits).length) {
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
      if (result.limitation) console.warn("MoodShift preset stem unavailable", result.limitation);
      return result.limitation ? "Effects applied. The separated mix is unavailable right now." : `Applied \u2713 \xB7 ${preset.name}`;
    } finally {
      if (current()) {
        presetApplying = false;
        commandPending = false;
        render(status);
        void refresh();
      }
    }
  }
  async function command(message) {
    const id = ++commandId;
    commandPending = true;
    updateApply();
    refreshId++;
    if (message.type === "APPLY_EFFECTS" || message.type === "SET_STEM" || message.type === "SET_REVERB") feedback.textContent = "Applying\u2026";
    try {
      const reply = await toWorker(message);
      if (id !== commandId) return;
      if (!reply.ok) throw new Error(reply.message);
      refreshId++;
      render(reply.status);
      if ((message.type === "APPLY_EFFECTS" || message.type === "SET_STEM" || message.type === "SET_REVERB") && reply.status.phase === "capturing" && reply.status.session.id === message.sessionId) {
        feedback.textContent = "Applied \u2713";
      }
    } catch (error) {
      if (id !== commandId) return;
      stopping = false;
      console.warn("MoodShift playback control failed", error);
      feedback.textContent = message.type === "SET_STEM" ? "Couldn\u2019t switch mixes. Check that the song is playing and try again." : "Couldn\u2019t update playback. Try again on the playing tab.";
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
        if (!reply.ok) console.warn("MoodShift status error", reply.message);
        render(reply.ok ? reply.status : { phase: "error", message: "Reopen MoodShift to reconnect." });
      }
    } catch (error) {
      console.warn("MoodShift status unavailable", error);
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
  document.querySelector("#voice-command").addEventListener("click", () => {
    void toWorker({ type: "OPEN_VOICE" }).then((reply) => {
      if (!reply.ok) feedback.textContent = reply.message;
    }).catch(() => {
      feedback.textContent = "Couldn\u2019t open voice commands.";
    });
  });
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
    const sessionId2 = status.session.id;
    const request = { id: crypto.randomUUID(), controller: new AbortController() };
    interpretation = request;
    updateApply();
    feedback.textContent = "Interpreting\u2026";
    try {
      const result = await runNaturalCommand(prompt, {
        sessionId: sessionId2,
        signal: request.controller.signal,
        applying: () => {
          feedback.textContent = "Applying\u2026";
        }
      });
      if (interpretation?.id !== request.id) return;
      feedback.textContent = result.message;
      if (result.status) void refresh();
    } catch (error) {
      if (interpretation?.id !== request.id) return;
      feedback.textContent = error instanceof CommandFeedbackError ? error.message : "Couldn\u2019t apply that request. Try describing the sound again.";
    } finally {
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
