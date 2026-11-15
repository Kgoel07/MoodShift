"use strict";
(() => {
  // extension/src/shared/messages.ts
  function toAudio(command) {
    return chrome.runtime.sendMessage({ ...command, target: "audio" });
  }
  function statusChanged() {
    void chrome.runtime.sendMessage({ target: "panel", type: "STATUS_CHANGED" }).catch(() => void 0);
  }

  // extension/src/shared/lyrics.ts
  function trackKey(value) {
    return value.normalize("NFKD").toLowerCase().replace(new RegExp("\\p{M}", "gu"), "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
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
    return !!trackKey(query.title) && !!trackKey(query.artist) && query.title.length <= 200 && query.artist.length <= 200 && Number.isFinite(query.duration) && query.duration >= 1 && query.duration <= 3600;
  }

  // extension/src/lyrics-provider.ts
  function matchLyrics(payload, song) {
    if (!Array.isArray(payload)) return { kind: "error" };
    const candidates = [];
    const title = trackKey(song.title);
    const artist = trackKey(song.artist);
    for (const row of payload.slice(0, 20)) {
      if (!row || typeof row !== "object" || typeof row.trackName !== "string" || typeof row.artistName !== "string" || typeof row.duration !== "number" || !Number.isFinite(row.duration)) continue;
      const difference = Math.abs(row.duration - song.duration);
      if (difference > 2 || trackKey(row.trackName) !== title || trackKey(row.artistName) !== artist) continue;
      const plain = typeof row.plainLyrics === "string" && row.plainLyrics.length <= 32e3 ? row.plainLyrics.trim() : "";
      const timed = typeof row.syncedLyrics === "string" && row.syncedLyrics.length <= 32e3 ? parseLrc(row.syncedLyrics) : [];
      const reliableTiming = timed.some((line) => line.text) && timed.length <= 1500 && timed.at(-1).time < song.duration + 2;
      if (row.instrumental === true) candidates.push({ difference, lyrics: { kind: "instrumental" } });
      else if (reliableTiming) candidates.push({ difference, lyrics: { kind: "synced", lines: timed } });
      else if (plain) candidates.push({ difference, lyrics: { kind: "plain", text: plain } });
    }
    candidates.sort((left, right) => left.difference - right.difference);
    const nearest = candidates[0];
    if (!nearest) return { kind: "missing" };
    const close = candidates.filter((candidate) => candidate.difference <= nearest.difference + 0.75);
    const selected = close.find((candidate) => candidate.lyrics.kind === "synced") ?? nearest;
    const signature = (result) => {
      if (result.kind === "instrumental") return "";
      return trackKey(result.kind === "plain" ? result.text : result.lines.map((line) => line.text).join(" "));
    };
    const selectedText = signature(selected.lyrics);
    for (const { lyrics, difference } of close) {
      if (Math.abs(difference - selected.difference) > 0.25) continue;
      if (lyrics.kind !== selected.lyrics.kind && lyrics.kind !== "instrumental" && selected.lyrics.kind !== "instrumental") continue;
      if (signature(lyrics) !== selectedText) return { kind: "ambiguous" };
      if (lyrics.kind === "synced" && selected.lyrics.kind === "synced") {
        const selectedLines = selected.lyrics.lines.filter((line) => line.text);
        const otherLines = lyrics.lines.filter((line) => line.text);
        if (otherLines.length !== selectedLines.length || otherLines.some((line, index) => Math.abs(line.time - selectedLines[index].time) > 2)) {
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
    search(song, retry = false) {
      if (!validSong(song)) return Promise.resolve({ kind: "invalid" });
      const key = JSON.stringify([trackKey(song.title), trackKey(song.artist), Math.round(song.duration * 10)]);
      const pending2 = this.requests.get(key);
      if (pending2) return pending2;
      if (this.requests.size >= 4) return Promise.resolve({ kind: "error" });
      const request = this.tail.then(async () => {
        this.state ??= this.storage?.get(storageKey).then((values) => values[storageKey]).catch(() => void 0).then((stored) => stored ?? this.empty()) ?? Promise.resolve(this.empty());
        const state = await this.state;
        const now = Date.now();
        state.cache = state.cache.filter((entry) => entry.expiry > now);
        const cached = state.cache.find((entry) => entry.key === key);
        if (cached && !retry) return cached.result;
        if (state.retryAt > now) return { kind: "limited", retryAt: state.retryAt };
        const delay = state.lastFinished + spacing - now;
        if (delay > 0) await pause(delay);
        const result = await this.fetchLyrics(song, state);
        state.lastFinished = Date.now();
        if (result.kind !== "limited" && result.kind !== "error") {
          const lifetime = result.kind === "synced" || result.kind === "plain" ? 30 * 6e4 : 5 * 6e4;
          state.cache = [
            { key, result, expiry: state.lastFinished + lifetime },
            ...state.cache.filter((entry) => entry.key !== key)
          ].slice(0, 12);
        }
        await this.storage?.set({ [storageKey]: state }).catch(() => void 0);
        return result;
      }).catch(() => ({ kind: "error" })).finally(() => this.requests.delete(key));
      this.tail = request;
      this.requests.set(key, request);
      return request;
    }
    empty() {
      return { cache: [], retryAt: 0, lastFinished: 0 };
    }
    async fetchLyrics(song, state) {
      const endpoint = new URL("https://lrclib.net/api/search");
      endpoint.searchParams.set("track_name", song.title.trim());
      endpoint.searchParams.set("artist_name", song.artist.trim());
      try {
        const response = await this.fetcher(endpoint, {
          headers: { "X-User-Agent": this.client, Accept: "application/json" },
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(8e3)
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
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (message.target !== "lyrics" || sender.url !== chrome.runtime.getURL("sidepanel.html")) return;
      const query = message.query;
      if (!query || typeof query.title !== "string" || typeof query.artist !== "string") return;
      void lookup.search(query, message.retry === true).then(reply);
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
    const endpoint = new URL("https://widget.songle.jp/api/v1/song/chord.json");
    endpoint.searchParams.set("url", `www.youtube.com/watch?v=${videoId}`);
    try {
      const response = await fetcher(endpoint, { signal: AbortSignal.timeout(4500), credentials: "omit" });
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
