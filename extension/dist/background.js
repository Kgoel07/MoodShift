"use strict";
(() => {
  // <define:__MOODSHIFT_DEPLOYMENT__>
  var define_MOODSHIFT_DEPLOYMENT_default = { mode: "development", apiBaseUrl: "http://127.0.0.1:8787", stemWsUrl: "ws://127.0.0.1:8788", stemDelaySeconds: 2.8 };

  // extension/src/shared/messages.ts
  function toAudio(command) {
    return chrome.runtime.sendMessage({ ...command, target: "audio" });
  }
  function statusChanged() {
    void chrome.runtime.sendMessage({ target: "panel", type: "STATUS_CHANGED" }).catch(() => void 0);
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

  // extension/src/shared/lyrics.ts
  function trackKey(value) {
    return value.normalize("NFKD").toLowerCase().replace(new RegExp("\\p{M}", "gu"), "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }
  function normalizeSongTitle(value) {
    return value.replace(/\s*[-–—|]\s*(?:YouTube(?: Music)?|Spotify|SoundCloud)\s*$/i, "").replace(/\s*[[(](?:official\s+(?:music\s+video|audio|video|lyric(?:s)?\s+video)|music\s+video|lyric(?:s)?\s+video|lyrics|visuali[sz]er|hd|4k)[\])]\s*/gi, " ").replace(/\s+[-–—|]\s+(?:official\s+(?:music\s+video|video|audio)|(?:song\s+)?lyrics)\s*$/i, "").replace(/\s+/g, " ").trim();
  }
  function parseLrc(text) {
    const offset = Number(text.match(/^\s*\[offset:([+-]?\d+)\]\s*$/im)?.[1] ?? 0) / 1e3;
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
      const entry = raw.trimStart();
      const tags = entry.match(/^(?:\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\])+/)?.[0];
      if (!tags) continue;
      const lyric = entry.slice(tags.length).replace(/<\d{1,3}:[0-5]\d(?:\.\d{1,3})?>/g, "").trim();
      for (const match of tags.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)) {
        const seconds = Number(match[1]) * 60 + Number(match[2]) + Number("0." + (match[3] ?? "0"));
        lines.push({ time: Math.max(0, seconds - offset), text: lyric });
      }
    }
    if (!lines.some((line) => line.text)) return [];
    const merged = [];
    for (const line of lines.sort((a, b) => a.time - b.time)) {
      const last = merged.at(-1);
      if (last?.time !== line.time) merged.push(line);
      else if (line.text && line.text !== last.text) last.text = [last.text, line.text].filter(Boolean).join("\n");
    }
    return merged;
  }
  function validSong(query) {
    return !!trackKey(query.title) && !!trackKey(query.artist) && query.title.length <= 200 && query.artist.length <= 200 && (query.album === void 0 || typeof query.album === "string" && query.album.length <= 200) && Number.isFinite(query.duration) && query.duration >= 1 && query.duration <= 3600;
  }

  // extension/src/lyrics-provider.ts
  function editionRank(album) {
    if (/\b(?:remaster(?:ed)?|deluxe|anniversary|reissue|expanded|compilation|greatest hits|live at)\b/.test(album)) return 2;
    if (/\boriginal (?:recording|release|mix|version)\b/.test(album)) return 0;
    return 1;
  }
  function matchLyrics(payload, song) {
    if (!Array.isArray(payload)) return { kind: "error" };
    const candidates = [];
    const title = trackKey(normalizeSongTitle(song.title));
    const artist = trackKey(song.artist);
    for (const row of payload.slice(0, 20)) {
      if (!row || typeof row !== "object" || typeof row.trackName !== "string" || typeof row.artistName !== "string" || typeof row.duration !== "number" || !Number.isFinite(row.duration)) continue;
      const difference = Math.abs(row.duration - song.duration);
      if (difference > 2 || trackKey(normalizeSongTitle(row.trackName)) !== title || trackKey(row.artistName) !== artist) continue;
      const plain = typeof row.plainLyrics === "string" && row.plainLyrics.length <= 32e3 ? row.plainLyrics.trim() : "";
      const timed = typeof row.syncedLyrics === "string" && row.syncedLyrics.length <= 32e3 ? parseLrc(row.syncedLyrics) : [];
      const reliableTiming = timed.some((line) => line.text) && timed.length <= 1500 && timed.at(-1).time < song.duration + 2;
      const album2 = typeof row.albumName === "string" ? trackKey(row.albumName) : "";
      if (row.instrumental === true) candidates.push({ difference, album: album2, lyrics: { kind: "instrumental" } });
      else if (reliableTiming) candidates.push({ difference, album: album2, lyrics: { kind: "synced", lines: timed } });
      else if (plain) candidates.push({ difference, album: album2, lyrics: { kind: "plain", text: plain } });
    }
    candidates.sort((left, right) => left.difference - right.difference);
    if (!candidates.length) return { kind: "missing" };
    const album = trackKey(song.album ?? "");
    const sameAlbum = album ? candidates.filter((candidate) => candidate.album === album) : [];
    const pool = sameAlbum.length ? sameAlbum : candidates;
    const close = pool.filter((candidate) => candidate.difference <= pool[0].difference + 0.75);
    const withLyrics = close.filter((candidate) => candidate.lyrics.kind !== "instrumental");
    const available = withLyrics.length ? withLyrics : close;
    const bestRank = Math.min(...available.map((candidate) => editionRank(candidate.album)));
    const best = available.filter((candidate) => editionRank(candidate.album) === bestRank);
    const selected = best.find((candidate) => candidate.lyrics.kind === "synced") ?? best[0];
    const signature = (lyrics) => lyrics.kind === "instrumental" ? "" : trackKey(lyrics.kind === "plain" ? lyrics.text : lyrics.lines.map((line) => line.text).join(" "));
    for (const { lyrics, difference } of best) {
      if (lyrics.kind !== selected.lyrics.kind || Math.abs(difference - selected.difference) > 0.25) continue;
      if (signature(lyrics) !== signature(selected.lyrics)) return { kind: "ambiguous" };
      if (lyrics.kind === "synced" && selected.lyrics.kind === "synced") {
        const reference = selected.lyrics.lines.filter((line) => line.text);
        const other = lyrics.lines.filter((line) => line.text);
        if (reference.length !== other.length || other.some((line, i) => Math.abs(line.time - reference[i].time) > 2)) {
          return { kind: "ambiguous" };
        }
      }
    }
    return selected.lyrics;
  }
  var storageKey = "lyricsLookup";
  var spacing = 350;
  var pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var LyricsLookup = class {
    constructor(fetcher, client, storage) {
      this.fetcher = fetcher;
      this.client = client;
      this.storage = storage;
      this.requests = /* @__PURE__ */ new Map();
      this.tail = Promise.resolve();
    }
    search(song, retry = false, signal) {
      if (!validSong(song)) return Promise.resolve({ kind: "invalid" });
      const key = JSON.stringify([
        "recording-v2",
        trackKey(normalizeSongTitle(song.title)),
        trackKey(song.artist),
        trackKey(song.album ?? ""),
        Math.round(song.duration * 10)
      ]);
      const requestKey = signal ?? key;
      const pending2 = this.requests.get(requestKey);
      if (pending2) return pending2;
      if (this.requests.size >= 4) return Promise.resolve({ kind: "error" });
      const request = this.tail.then(async () => {
        if (signal?.aborted) return { kind: "error" };
        this.state ??= this.storage?.get(storageKey).then((values) => values[storageKey]).catch(() => void 0).then((stored) => stored ?? this.empty()) ?? Promise.resolve(this.empty());
        const state = await this.state;
        const now = Date.now();
        state.cache = state.cache.filter((entry) => entry.expiry > now);
        const cached = state.cache.find((entry) => entry.key === key);
        if (cached && !retry) return cached.result;
        if (state.retryAt > now) return { kind: "limited", retryAt: state.retryAt };
        const delay = state.lastFinished + spacing - now;
        if (delay > 0) await pause(delay);
        if (signal?.aborted) return { kind: "error" };
        const result = await this.fetchLyrics(song, state, signal);
        state.lastFinished = Date.now();
        if (signal?.aborted) return { kind: "error" };
        if (result.kind !== "limited" && result.kind !== "error") {
          const lifetime = result.kind === "synced" || result.kind === "plain" ? 30 * 6e4 : 5 * 6e4;
          state.cache = [
            { key, result, expiry: state.lastFinished + lifetime },
            ...state.cache.filter((entry) => entry.key !== key)
          ].slice(0, 12);
        }
        await this.storage?.set({ [storageKey]: state }).catch(() => void 0);
        return result;
      }).catch(() => ({ kind: "error" })).finally(() => this.requests.delete(requestKey));
      this.tail = request;
      this.requests.set(requestKey, request);
      return request;
    }
    empty() {
      return { cache: [], retryAt: 0, lastFinished: 0 };
    }
    async fetchLyrics(song, state, signal) {
      const endpoint2 = new URL("https://lrclib.net/api/search");
      endpoint2.searchParams.set("track_name", normalizeSongTitle(song.title));
      endpoint2.searchParams.set("artist_name", song.artist.trim());
      try {
        const timeout = AbortSignal.timeout(8e3);
        const response = await this.fetcher(endpoint2, {
          headers: { "X-User-Agent": this.client, Accept: "application/json" },
          credentials: "omit",
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout
        });
        const retryAfter = response.headers.get("Retry-After");
        if (response.status === 429 || response.status === 503 && retryAfter) {
          const now = Date.now();
          const ms = /^\d+$/.test(retryAfter ?? "") ? Number(retryAfter) * 1e3 : Date.parse(retryAfter ?? "") - now;
          const wait = Number.isFinite(ms) ? Math.max(1e3, ms) : 3e4;
          state.retryAt = now + wait * (1 + Math.random() * 0.25);
          return { kind: "limited", retryAt: state.retryAt };
        }
        if (response.status === 404) return { kind: "missing" };
        if (response.status === 400) return { kind: "invalid" };
        if (!response.ok || !response.headers.get("Content-Type")?.includes("application/json")) return { kind: "error" };
        return matchLyrics(await response.json(), song);
      } catch {
        return { kind: "error" };
      }
    }
  };
  function installLyricsLookup() {
    const lookup = new LyricsLookup(
      fetch.bind(globalThis),
      "MoodShift/" + chrome.runtime.getManifest().version + " (https://github.com/Kgoel07/MoodShift)",
      chrome.storage.session
    );
    const active = /* @__PURE__ */ new Map();
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (message.target !== "lyrics" || sender.url !== chrome.runtime.getURL("sidepanel.html")) return;
      if ("cancel" in message) {
        active.get(`${sender.documentId}:${message.cancel}`)?.abort();
        return;
      }
      const query = message.query;
      if (!query || typeof query.title !== "string" || typeof query.artist !== "string") return;
      const id = typeof message.requestId === "string" && message.requestId.length <= 40 ? `${sender.documentId}:${message.requestId}` : void 0;
      const controller = id ? new AbortController() : void 0;
      if (id && controller) active.set(id, controller);
      void lookup.search(query, message.retry === true, controller?.signal).then(reply).finally(() => {
        if (id) active.delete(id);
      });
      return true;
    });
  }

  // extension/src/shared/chords.ts
  var validChordVideo = (id) => typeof id === "string" && /^[\w-]{11}$/.test(id);
  function normalizeSongle(body) {
    const rows = body?.chords;
    if (!Array.isArray(rows) || rows.length > 5e3) return { kind: "invalid" };
    const events = [];
    let previous = -1;
    for (const row of rows) {
      const { start, duration, name } = row ?? {};
      if (!Number.isSafeInteger(start) || start < 0 || start <= previous || !Number.isSafeInteger(duration) || duration <= 0 || !Number.isSafeInteger(start + duration) || typeof name !== "string" || !/^(?:N|[A-G][#b♯♭]?[\w#b♯♭/()+°ø-]{0,23})$/.test(name)) {
        return { kind: "invalid" };
      }
      previous = start;
      const prev = events.at(-1);
      if (prev) prev.endTime = Math.min(prev.endTime, start / 1e3);
      if (name !== "N") {
        events.push({ startTime: start / 1e3, endTime: (start + duration) / 1e3, chord: name, source: "songle" });
      }
    }
    return events.length ? { kind: "found", events } : { kind: "empty" };
  }

  // extension/src/chords-provider.ts
  var cacheKey = "songleChordCacheV1";
  var cacheAge = 7 * 24 * 60 * 60 * 1e3;
  var pending = /* @__PURE__ */ new Map();
  var cacheWrite = Promise.resolve();
  async function fetchSongle(videoId, fetcher = fetch) {
    const endpoint2 = new URL("https://widget.songle.jp/api/v1/song/chord.json");
    endpoint2.searchParams.set("url", `www.youtube.com/watch?v=${videoId}`);
    try {
      const response = await fetcher(endpoint2, { signal: AbortSignal.timeout(4500), credentials: "omit" });
      if (response.status === 404) return { kind: "missing" };
      if (!response.ok) return { kind: "unavailable" };
      const json = await response.json();
      return normalizeSongle(json);
    } catch (error) {
      return { kind: error instanceof SyntaxError ? "invalid" : "unavailable" };
    }
  }
  async function load(videoId) {
    try {
      const values = await chrome.storage.local.get(cacheKey);
      const hit = values[cacheKey]?.[videoId];
      if (hit?.result?.kind === "found" && Date.now() - hit.savedAt < cacheAge) return hit.result;
    } catch {
    }
    const result = await fetchSongle(videoId);
    if (result.kind === "found") {
      const write = cacheWrite.then(async () => {
        const values = await chrome.storage.local.get(cacheKey);
        const entries = Object.entries(values[cacheKey] ?? {}).filter(([id]) => id !== videoId);
        await chrome.storage.local.set({
          [cacheKey]: Object.fromEntries([...entries.slice(-15), [videoId, { savedAt: Date.now(), result }]])
        });
      });
      cacheWrite = write.catch(() => void 0);
      await cacheWrite;
    }
    return result;
  }
  function installChordLookup() {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.target !== "chords" || sender.url !== chrome.runtime.getURL("sidepanel.html")) return;
      const videoId = message.videoId;
      if (!validChordVideo(videoId)) {
        respond({ kind: "invalid" });
        return;
      }
      let request = pending.get(videoId);
      if (!request) {
        request = load(videoId).finally(() => pending.delete(videoId));
        pending.set(videoId, request);
      }
      void request.then(respond, () => respond({ kind: "unavailable" }));
      return true;
    });
  }

  // extension/src/shared/track.ts
  function platformFor(url) {
    try {
      const { protocol, hostname } = new URL(url ?? "");
      if (protocol !== "https:" && protocol !== "http:") return "tab";
      const matches = (domain) => hostname === domain || hostname.endsWith(`.${domain}`);
      if (matches("youtube.com") || matches("youtu.be")) return "youtube";
      if (matches("spotify.com")) return "spotify";
      if (matches("soundcloud.com")) return "soundcloud";
    } catch {
    }
    return "tab";
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
  var tuningKey = "moodshiftTuning";
  function defaultTuning() {
    return { pitch: { ...defaultPitch }, eq: defaultEqualizer() };
  }
  function validateTuning(input) {
    const value = input;
    if (!value) throw new Error("Invalid pitch and EQ settings.");
    return { pitch: pitchSettings(value.pitch), eq: validateEq(value.eq) };
  }
  function readTuning(input) {
    const value = input;
    const defaults = defaultTuning();
    try {
      defaults.pitch = pitchSettings(value?.pitch);
    } catch {
    }
    try {
      defaults.eq = validateEq(value?.eq);
    } catch {
    }
    return defaults;
  }
  function changeTuning(current, edit) {
    if (!edit || typeof edit !== "object") throw new Error("Invalid pitch or EQ action.");
    if (edit.kind === "pitch") return { ...current, pitch: pitchSettings({ ...current.pitch, ...edit.patch }) };
    const eq = changeEq(current.eq, edit);
    return eq === current.eq ? current : { ...current, eq };
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
  function storeDisplay(settings, previous) {
    const patch = {};
    if (settings.home !== previous.home) patch[homeLayoutKey] = settings.home;
    if (settings.lyricsOffset !== previous.lyricsOffset) patch[lyricsOffsetKey] = settings.lyricsOffset;
    const { lyricsFollow, lyricsOpen, chordsOpen } = settings;
    if (lyricsFollow !== previous.lyricsFollow || lyricsOpen !== previous.lyricsOpen || chordsOpen !== previous.chordsOpen) {
      patch[displayOptionsKey] = { lyricsFollow, lyricsOpen, chordsOpen };
    }
    return patch;
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

  // extension/src/shared/controls.ts
  var controlActionLimit = 12;
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
  var controlDescriptions = Object.entries(registry).map(([control, { label, parameter, operations: operations2, atFrequency }]) => ({
    control,
    label,
    parameter,
    operations: operations2,
    ...atFrequency ? { frequencyHz: frequencyRange } : {}
  }));
  var isDisplayControl = (control) => Object.hasOwn(displayControls, control);
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
  function applyControls(current, input, saved) {
    const plan = { ...current, selectStem: false };
    for (const action of parseControlActions(input)) registry[action.control].apply(plan, action, saved);
    return plan;
  }
  function changeDisplay(current, input) {
    const [action] = parseControlActions([input]);
    if (!isDisplayControl(action.control)) throw new Error("Unknown display option.");
    const plan = {
      display: current,
      effects: { ...neutralEffects },
      tuning: defaultTuning(),
      reverb: { ...defaultReverb },
      monitor: "modified",
      stemMode: "full",
      selectStem: false
    };
    registry[action.control].apply(plan, action, { audio: [], eq: [] });
    return plan.display;
  }

  // extension/src/background.ts
  installLyricsLookup();
  installChordLookup();
  var offscreenUrl = chrome.runtime.getURL("offscreen.html");
  var creating;
  var operations = Promise.resolve();
  var starting;
  var failure;
  var voiceUrl = chrome.runtime.getURL("voice.html");
  var openingVoice;
  function openVoice() {
    openingVoice ??= (async () => {
      const [window] = await chrome.runtime.getContexts({ documentUrls: [voiceUrl] });
      if (window && window.windowId >= 0) {
        try {
          await chrome.windows.update(window.windowId, { focused: true });
          return;
        } catch {
        }
      }
      await chrome.windows.create({ url: voiceUrl, type: "popup", width: 370, height: 335, focused: true });
    })().finally(() => {
      openingVoice = void 0;
    });
    return openingVoice;
  }
  chrome.commands.onCommand.addListener((command) => {
    if (command === "voice-command") void openVoice().catch(() => console.warn("MoodShift could not open voice commands."));
  });
  async function hasOffscreen() {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [offscreenUrl]
    });
    return contexts.length > 0;
  }
  function ensureOffscreen() {
    creating ??= (async () => {
      if (await hasOffscreen()) return;
      await chrome.offscreen.createDocument({
        url: offscreenUrl,
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: "Keep the selected tab audible while applying live audio effects."
      });
    })().finally(() => {
      creating = void 0;
    });
    return creating;
  }
  function queue(work) {
    const next = operations.then(work);
    operations = next.then(() => void 0, () => void 0);
    return next;
  }
  async function audioStatus() {
    if (!await hasOffscreen()) return { phase: "ready" };
    try {
      const reply = await toAudio({ type: "READ" });
      if (reply.ok) return reply.status;
      return { phase: "error", message: reply.message };
    } catch (error) {
      if (await hasOffscreen()) throw error;
      return { phase: "ready" };
    }
  }
  async function status() {
    if (starting) return { phase: "starting", source: starting, tuning: await storedTuning() };
    const current = await audioStatus();
    if (current.phase === "capturing") return current;
    const tuning = await storedTuning();
    return failure ? { phase: "error", message: failure, tuning } : { ...current, tuning };
  }
  async function storedTuning() {
    try {
      return readTuning((await chrome.storage.local.get(tuningKey))[tuningKey]);
    } catch (error) {
      console.warn("MoodShift could not load pitch and EQ settings", error);
      return readTuning(void 0);
    }
  }
  async function remember(current) {
    if (current.phase === "capturing") await chrome.storage.session.set({ capture: current.session });
    else await chrome.storage.session.remove("capture");
  }
  async function stop(sessionId) {
    const current = await audioStatus();
    if (current.phase !== "capturing" || current.session.id !== sessionId) return current;
    const reply = await toAudio({ type: "STOP", sessionId });
    if (!reply.ok) throw new Error(reply.message);
    await remember(reply.status);
    return reply.status;
  }
  async function updateAudio(message) {
    const reply = await toAudio(message);
    if (reply.ok) {
      try {
        if (reply.status.tuning && (message.type === "SET_TUNING" || message.type === "APPLY_EFFECTS" && message.tuning)) {
          await chrome.storage.local.set({ [tuningKey]: reply.status.tuning });
        }
      } finally {
        statusChanged();
      }
    }
    return reply;
  }
  var same = (before, after) => JSON.stringify(before) === JSON.stringify(after);
  var staleCommand = "Settings changed while Gemini was working. Try the command again.";
  async function dispatchControls(message) {
    const prepared = await queue(async () => {
      const actions = parseControlActions(message.actions);
      const [capture, display, saved] = await Promise.all([audioStatus(), loadDisplay(), loadControlPresets()]);
      if (capture.phase !== "capturing" || capture.session.id !== message.sessionId || capture.revision !== message.baseRevision || actions.some((action) => isDisplayControl(action.control)) && !same(display, message.expectedDisplay)) throw new Error(staleCommand);
      const before = controlState(capture, display);
      const plan2 = applyControls(before, actions, saved);
      const patch = Object.fromEntries(effectKeys.filter((key) => before.effects[key] !== plan2.effects[key]).map((key) => [key, plan2.effects[key]]));
      const reverbChanged = !same(before.reverb, plan2.reverb);
      const pitchChanged2 = !same(before.tuning.pitch, plan2.tuning.pitch);
      const eqChanged = !same(before.tuning.eq, plan2.tuning.eq);
      const restartReverbSpeed = actions.some((action) => action.control === "reverb.preset" || action.control === "preset.saved" || action.control === "reverb.enabled" && action.value === true);
      const displayPatch = storeDisplay(plan2.display, display);
      const anyEffects = Object.keys(patch).length > 0 || reverbChanged || restartReverbSpeed;
      let current2 = capture;
      if (anyEffects || pitchChanged2 || eqChanged) {
        const reply = await updateAudio({
          type: "APPLY_EFFECTS",
          sessionId: message.sessionId,
          baseRevision: capture.revision,
          patch,
          ...pitchChanged2 || eqChanged ? { tuning: plan2.tuning } : {},
          ...reverbChanged || restartReverbSpeed ? { reverb: plan2.reverb, restartReverbSpeed } : {}
        });
        if (!reply.ok) throw new Error(reply.message);
        if (reply.status.phase !== "capturing" || reply.status.session.id !== message.sessionId) throw new Error(staleCommand);
        current2 = reply.status;
      }
      const displayChanged = Object.keys(displayPatch).length > 0;
      if (displayChanged) await chrome.storage.local.set(displayPatch);
      return { current: current2, plan: plan2, pitchChanged: pitchChanged2, applied: anyEffects || eqChanged || displayChanged };
    });
    let { current, applied } = prepared;
    const { plan, pitchChanged } = prepared;
    const notices = [];
    const sessionId = message.sessionId;
    if (plan.selectStem && (current.stem.mode !== plan.stemMode || current.stem.phase !== (plan.stemMode === "full" ? "idle" : "active"))) {
      const reply = await toAudio({ type: "SET_STEM", sessionId, mode: plan.stemMode, baseRevision: current.revision });
      if (reply.ok && reply.status.phase === "capturing" && reply.status.session.id === sessionId) {
        current = reply.status;
        applied = true;
      } else {
        notices.push("The separated mix could not be enabled.");
        if (pitchChanged && current.audioTiming?.pitch.phase === "starting") {
          const next = await audioStatus();
          if (next.phase === "capturing" && next.session.id === sessionId && same(next.tuning?.pitch, plan.tuning.pitch)) current = next;
        }
      }
    }
    if (current.monitor !== plan.monitor && !notices.length) {
      const reply = await queue(() => updateAudio({ type: "SET_MONITOR", sessionId, monitor: plan.monitor, baseRevision: current.revision }));
      if (!reply.ok || reply.status.phase !== "capturing" || reply.status.session.id !== sessionId) throw new Error(staleCommand);
      current = reply.status;
      applied = true;
    }
    if (pitchChanged && plan.tuning.pitch.enabled && plan.tuning.pitch.semitones !== 0) {
      const until = Date.now() + 4e3;
      while (current.audioTiming?.pitch.phase === "starting" && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const next = await audioStatus();
        if (next.phase !== "capturing" || next.session.id !== sessionId || !same(next.tuning?.pitch, plan.tuning.pitch)) throw new Error(staleCommand);
        current = next;
      }
      if (current.audioTiming?.pitch.phase === "active") applied = true;
      else notices.push("Pitch could not start.");
    } else applied ||= pitchChanged;
    if (prepared.applied && plan.reverb.preset === "slowed" && plan.effects.reverbMix > 0 && current.reverb?.speed.state === "unavailable") {
      notices.push("Playback slowing is unavailable on this tab.");
    }
    statusChanged();
    return { ok: true, status: current, applied, notices };
  }
  async function select(source) {
    try {
      failure = void 0;
      const current = await audioStatus();
      if (current.phase === "capturing" && current.session.tabId === source.tabId && !current.outputPaused) return;
      starting = source;
      statusChanged();
      if (current.phase === "capturing") await stop(current.session.id);
      await ensureOffscreen();
      const session = { ...source, id: crypto.randomUUID() };
      const tuning = await storedTuning();
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: source.tabId });
      const reply = await toAudio({ type: "START", session, streamId, tuning });
      if (!reply.ok) throw new Error(reply.message);
      await remember(reply.status);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn("MoodShift capture setup failed", detail);
      failure = "Play audio, then click MoodShift on that tab again. If it still fails, refresh the tab.";
    } finally {
      starting = void 0;
      statusChanged();
    }
  }
  chrome.action.onClicked.addListener((tab) => {
    void chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
    if (tab.id === void 0) return;
    const source = {
      tabId: tab.id,
      title: tab.title || "Selected tab",
      muted: tab.mutedInfo?.muted ?? false,
      platform: platformFor(tab.url)
    };
    void queue(() => select(source));
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void queue(async () => {
      const current = await audioStatus();
      if (current.phase !== "capturing" || current.session.tabId !== tabId) return;
      await stop(current.session.id);
      statusChanged();
    }).catch(console.error);
  });
  chrome.tabs.onUpdated.addListener((tabId, { title, mutedInfo, url }, tab) => {
    if (title === void 0 && mutedInfo === void 0 && url === void 0) return;
    void queue(async () => {
      const current = await audioStatus();
      if (current.phase !== "capturing" || current.session.tabId !== tabId) return;
      const reply = await toAudio({
        type: "UPDATE_TAB",
        sessionId: current.session.id,
        title,
        muted: mutedInfo?.muted,
        platform: url || tab.url ? platformFor(url ?? tab.url) : void 0
      });
      if (reply.ok) {
        await remember(reply.status);
        statusChanged();
      }
    }).catch(console.error);
  });
  chrome.tabCapture.onStatusChanged.addListener(({ status: captureState, tabId }) => {
    if (captureState !== "stopped" && captureState !== "error") return;
    void queue(async () => {
      const current = await audioStatus();
      if (current.phase !== "capturing" || current.session.tabId !== tabId) return;
      const captures = await chrome.tabCapture.getCapturedTabs();
      if (captures.some((capture) => capture.tabId === tabId && capture.status === "active")) return;
      await stop(current.session.id);
      statusChanged();
    }).catch(console.error);
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== "worker") return;
    if (message.type === "SYNC_REVERB_RATE") {
      if (sender.url !== offscreenUrl || sender.id !== chrome.runtime.id) return;
      void (async () => {
        const stored = await chrome.storage.session.get("capture");
        const capture = stored.capture;
        if (capture?.id !== message.sessionId) return { state: "unavailable", message: "Reverb active. The captured tab changed." };
        let timeout;
        try {
          const speed = await Promise.race([
            chrome.tabs.sendMessage(capture.tabId, { type: "REVERB_PLAYBACK", owner: message.owner, enabled: message.enabled }, { frameId: 0 }),
            new Promise((resolve) => {
              timeout = setTimeout(() => resolve({ state: "unavailable", message: "Reverb active. The player did not answer the speed request." }), 1200);
            })
          ]);
          return speed ?? { state: "unavailable", message: "Reverb active. Slowing is supported on YouTube only." };
        } finally {
          clearTimeout(timeout);
        }
      })().then(sendResponse, () => sendResponse({ state: "unavailable", message: "Reverb active. Slowing is supported on YouTube only." }));
      return true;
    }
    if (message.type === "GET_STEM_CODE") {
      if (!usesCloudStems() || sender.id !== chrome.runtime.id || sender.url !== offscreenUrl) {
        sendResponse({ ok: false, message: "Cloud stem authentication is unavailable." });
        return;
      }
      void cloudDemoCode().then(
        (code) => sendResponse(code ? { ok: true, code } : { ok: false, message: "Cloud stem authentication is unavailable." }),
        (error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "Could not read the private demo code." })
      );
      return true;
    }
    if (message.type === "AUDIO_ENDED") {
      if (sender.url === offscreenUrl) void queue(async () => remember(await audioStatus())).catch(console.error);
      return;
    }
    if (message.type === "SET_STEM") {
      void toAudio(message).then(sendResponse, () => sendResponse({ ok: false, message: "Select an audio tab with the MoodShift icon." }));
      return true;
    }
    if (message.type === "APPLY_CONTROLS") {
      void dispatchControls(message).then(sendResponse, (error) => sendResponse({ ok: false, message: String(error.message ?? error) }));
      return true;
    }
    if (message.type === "OPEN_VOICE") {
      if (sender.url !== chrome.runtime.getURL("sidepanel.html")) return;
      void openVoice().then(status).then(
        (current) => sendResponse({ ok: true, status: current }),
        () => sendResponse({ ok: false, message: "Couldn\u2019t open voice commands." })
      );
      return true;
    }
    const operation = message.type === "GET_STATUS" ? status().then((current) => ({ ok: true, status: current })) : queue(async () => {
      if (message.type === "STOP") {
        const current = await stop(message.sessionId);
        statusChanged();
        return { ok: true, status: current.phase === "capturing" ? current : { ...current, tuning: await storedTuning() } };
      }
      if (message.type === "SET_DISPLAY") {
        const previous = await loadDisplay();
        const patch = storeDisplay(changeDisplay(previous, message.action), previous);
        if (Object.keys(patch).length) await chrome.storage.local.set(patch);
        return { ok: true, status: await status() };
      }
      if (message.type === "SET_TUNING" && message.sessionId === void 0) {
        const current = await status();
        if (current.phase === "capturing") return { ok: false, message: "The selected tab changed. Please try again." };
        const tuning = changeTuning(current.tuning, message.edit);
        await chrome.storage.local.set({ [tuningKey]: tuning });
        statusChanged();
        return { ok: true, status: { ...current, tuning } };
      }
      if (message.type !== "APPLY_EFFECTS" && message.type !== "SET_MONITOR" && message.type !== "SET_REVERB" && message.type !== "SET_TUNING") {
        return { ok: false, message: "Unknown audio command." };
      }
      if (!await hasOffscreen()) return { ok: false, message: "Select an audio tab with the MoodShift icon." };
      return updateAudio(message);
    });
    void operation.then(
      sendResponse,
      (error) => sendResponse({ ok: false, message: String(error.message ?? error) })
    );
    return true;
  });
})();
