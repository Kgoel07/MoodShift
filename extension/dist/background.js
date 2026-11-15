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
    return (best.find((candidate) => candidate.lyrics.kind === "synced") ?? best[0]).lyrics;
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

  // extension/src/background.ts
  installLyricsLookup();
  installChordLookup();
  var offscreenUrl = chrome.runtime.getURL("offscreen.html");
  var creating;
  var operations = Promise.resolve();
  var starting;
  var failure;
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
    if (starting) return { phase: "starting", source: starting };
    const current = await audioStatus();
    return failure && current.phase !== "capturing" ? { phase: "error", message: failure } : current;
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
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: source.tabId });
      const reply = await toAudio({ type: "START", session, streamId });
      if (!reply.ok) throw new Error(reply.message);
      await remember(reply.status);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failure = `Capture failed. Play audio and click MoodShift on that tab to retry. ${detail}`;
    } finally {
      starting = void 0;
      statusChanged();
    }
  }
  chrome.action.onClicked.addListener((tab) => {
    void chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
    if (tab.id === void 0) return;
    const source = { tabId: tab.id, title: tab.title || "Selected tab", muted: tab.mutedInfo?.muted ?? false };
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
  chrome.tabs.onUpdated.addListener((tabId, { title, mutedInfo }) => {
    if (title === void 0 && mutedInfo === void 0) return;
    void queue(async () => {
      const current = await audioStatus();
      if (current.phase !== "capturing" || current.session.tabId !== tabId) return;
      const reply = await toAudio({
        type: "UPDATE_TAB",
        sessionId: current.session.id,
        title,
        muted: mutedInfo?.muted
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
    const operation = message.type === "GET_STATUS" ? status().then((current) => ({ ok: true, status: current })) : queue(async () => {
      if (message.type === "STOP") {
        const current = await stop(message.sessionId);
        statusChanged();
        return { ok: true, status: current };
      }
      if (message.type !== "APPLY_EFFECTS" && message.type !== "SET_MONITOR") {
        return { ok: false, message: "Unknown audio command." };
      }
      if (!await hasOffscreen()) return { ok: false, message: "Select an audio tab with the MoodShift icon." };
      const reply = await toAudio(message);
      if (reply.ok) statusChanged();
      return reply;
    });
    void operation.then(
      sendResponse,
      (error) => sendResponse({ ok: false, message: String(error.message ?? error) })
    );
    return true;
  });
})();
