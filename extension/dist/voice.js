"use strict";
(() => {
  // <define:__MOODSHIFT_DEPLOYMENT__>
  var define_MOODSHIFT_DEPLOYMENT_default = { mode: "development", apiBaseUrl: "http://127.0.0.1:8787", stemWsUrl: "ws://127.0.0.1:8788", stemDelaySeconds: 2.8 };

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

  // extension/src/shared/messages.ts
  function toWorker(command) {
    return chrome.runtime.sendMessage({ ...command, target: "worker" });
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
    const pitch = input;
    if (!pitch || typeof pitch.enabled !== "boolean" || !Number.isFinite(pitch.semitones)) {
      throw new Error("Choose a valid pitch setting.");
    }
    const { min, max } = pitchRange;
    return { enabled: pitch.enabled, semitones: Math.round(Math.max(min, Math.min(max, pitch.semitones)) * 10) / 10 || 0 };
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
      const request2 = { prompt, currentEffects: effects, audioFeatures: session.muted || outputPaused ? silentFeatures : features, localPreferences };
      const { effects: _effects, ...settings } = controlState(capture, display);
      const names = (rows) => rows.map((row) => row.name).filter((name) => !/[\u0000-\u001f\u007f]/.test(name)).slice(0, controlPresetLimit);
      const deadline = AbortSignal.timeout(15e3);
      const signal = AbortSignal.any([options.signal, deadline]);
      try {
        let response = await apiRequest("/api/interpret/v2", { ...request2, controls: {
          ...settings,
          savedAudio: names(saved.audio),
          savedEq: names(saved.eq),
          youtubeWatch: session.platform === "youtube"
        } }, signal);
        if (response.status === 404) {
          legacy = true;
          await response.body?.cancel();
          response = await apiRequest("/api/interpret", request2, signal);
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
    const pitch = changed.status.tuning?.pitch;
    if (pitch && result.actions.every((action) => action.control.startsWith("pitch."))) {
      confirmation = pitch.enabled ? `Pitch ${pitch.semitones > 0 ? "+" : ""}${pitch.semitones.toFixed(1)} st.` : "Pitch off.";
    }
    const notices = changed.notices ?? [];
    const message = notices.length ? `${changed.applied ? "Settings updated. " : ""}${notices.join(" ")}` : changed.applied ? `Applied \u2713 \xB7 ${confirmation}` : `Already set. ${confirmation}`;
    return { message: message + limitation, status: changed.status };
  }

  // extension/src/voice.ts
  var speechWindow = window;
  var getRecognizer = () => speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
  var listen = document.querySelector("#voice-listen");
  var cancel = document.querySelector("#voice-cancel");
  var status = document.querySelector("#voice-status");
  var transcript = document.querySelector("#voice-transcript");
  var source;
  var request;
  var recognizer;
  var timer;
  var speaking = false;
  var applying = false;
  var speechErrors = {
    "not-allowed": "Microphone access was blocked. Allow it in Chrome and try again.",
    "service-not-allowed": "Speech recognition is unavailable in this Chrome profile.",
    "audio-capture": "Chrome couldn\u2019t find a microphone. Connect one and try again.",
    "no-speech": "I didn\u2019t catch that. Try speaking again.",
    network: "Chrome\u2019s speech service couldn\u2019t connect. Try again or type your command in MoodShift."
  };
  function controls() {
    listen.disabled = !source || Boolean(request) || !getRecognizer();
    cancel.hidden = !request || applying;
    status.toggleAttribute("data-listening", speaking);
  }
  function releaseMicrophone() {
    clearTimeout(timer);
    speaking = false;
    const input = recognizer;
    recognizer = void 0;
    if (!input) return;
    input.onstart = input.onspeechend = input.onresult = input.onerror = input.onend = null;
    try {
      input.abort();
    } catch {
    }
  }
  function end(message) {
    releaseMicrophone();
    request?.abort();
    request = void 0;
    applying = false;
    if (message) status.textContent = message;
    controls();
  }
  async function refreshSource() {
    try {
      const reply = await toWorker({ type: "GET_STATUS" });
      const next = reply.ok && reply.status.phase === "capturing" ? reply.status.session.id : void 0;
      if (source !== next && request) end("The playing tab changed. Try again.");
      source = next;
      if (!request && (!transcript.textContent || !source)) {
        status.textContent = !getRecognizer() ? "Speech recognition is unavailable in this browser." : source ? "Click Listen, then speak your audio command." : "Select a playing tab with the MoodShift icon first.";
      }
    } catch {
      if (!request) status.textContent = "Couldn\u2019t connect to MoodShift. Try reopening voice commands.";
    }
    controls();
  }
  async function submit(text, current, sessionId) {
    transcript.textContent = text;
    transcript.hidden = false;
    status.textContent = "Interpreting\u2026";
    controls();
    try {
      const result = await runNaturalCommand(text, { sessionId, signal: current.signal, applying: () => {
        applying = true;
        status.textContent = "Applying\u2026";
        controls();
      } });
      if (request === current) end(result.message);
    } catch (error) {
      if (request === current) end(error instanceof CommandFeedbackError ? error.message : "Couldn\u2019t apply that command. Try again.");
    }
  }
  listen.addEventListener("click", () => {
    const Speech = getRecognizer();
    if (!Speech || !source || request || document.hidden) return;
    const sessionId = source;
    const current = request = new AbortController();
    transcript.textContent = "";
    transcript.hidden = true;
    status.textContent = "Starting microphone\u2026";
    controls();
    try {
      const input = recognizer = new Speech();
      input.continuous = false;
      input.interimResults = false;
      input.lang = navigator.language;
      input.onstart = () => {
        if (document.hidden || request !== current) {
          end("Listening cancelled.");
          return;
        }
        speaking = true;
        status.textContent = "\u{1F399}\uFE0F Listening\u2026";
        controls();
      };
      input.onspeechend = () => input.stop();
      input.onresult = (event) => {
        if (recognizer !== input || request !== current) return;
        const result = event.results[event.resultIndex];
        if (!result?.isFinal) return;
        const text = result[0]?.transcript.trim() ?? "";
        releaseMicrophone();
        if (!text || text.length > 500) {
          end("Try again with a short audio command.");
          return;
        }
        void submit(text, current, sessionId);
      };
      input.onend = () => {
        if (recognizer === input) end("I didn\u2019t catch that. Try speaking again.");
      };
      input.onerror = (event) => {
        if (recognizer === input) end(speechErrors[event.error] ?? "Couldn\u2019t recognize speech. Try again.");
      };
      timer = setTimeout(() => end("Listening ended. Try speaking again."), 15e3);
      input.start();
    } catch {
      end("Couldn\u2019t start the microphone. Check your Chrome permissions.");
    }
  });
  cancel.addEventListener("click", () => end("Voice command cancelled."));
  document.querySelector("#voice-close").addEventListener("click", () => {
    end();
    window.close();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (request) end("Voice command cancelled.");
      else window.close();
    }
  });
  window.addEventListener("blur", () => {
    if (speaking) end("Listening cancelled.");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && request && !applying) end("Voice command cancelled.");
  });
  window.addEventListener("pagehide", () => end());
  chrome.runtime.onMessage.addListener((message) => {
    if (message.target === "panel" && message.type === "STATUS_CHANGED") void refreshSource();
  });
  void refreshSource();
})();
