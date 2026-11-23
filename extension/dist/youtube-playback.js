"use strict";
(() => {
  // extension/src/shared/lyrics.ts
  var youtubePlaybackPort = "moodshift-youtube-playback";
  function trackKey(value) {
    return value.normalize("NFKD").toLowerCase().replace(new RegExp("\\p{M}", "gu"), "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }
  function youtubeVideoId(url) {
    const id = url.searchParams.get("v");
    if (url.hostname === "www.youtube.com" && url.pathname === "/watch" && id && /^[\w-]{11}$/.test(id)) return id;
  }
  function normalizeSongTitle(value) {
    return value.replace(/\s*[-–—|]\s*(?:YouTube(?: Music)?|Spotify|SoundCloud)\s*$/i, "").replace(/\s*[[(](?:official\s+(?:music\s+video|audio|video|lyric(?:s)?\s+video)|music\s+video|lyric(?:s)?\s+video|lyrics|visuali[sz]er|hd|4k)[\])]\s*/gi, " ").replace(/\s+[-–—|]\s+(?:official\s+(?:music\s+video|video|audio)|(?:song\s+)?lyrics)\s*$/i, "").replace(/\s+/g, " ").trim();
  }
  function identifySong(videoTitle, channel, media) {
    const cleaned = normalizeSongTitle(videoTitle);
    const cleanArtist = (value) => value.replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").trim();
    const channelArtist = cleanArtist(channel);
    const separator = cleaned.match(/\s+[-–—~]\s+/);
    const left = separator ? cleaned.slice(0, separator.index) : "";
    const right = separator ? cleaned.slice(separator.index + separator[0].length) : "";
    if (media?.artist.trim() && media.title.trim()) {
      const mediaTitle = normalizeSongTitle(media.title);
      const artist = cleanArtist(media.artist);
      const key = trackKey(mediaTitle);
      if (key === trackKey(cleaned) && separator) {
        if (trackKey(artist) === trackKey(right)) return { title: left, artist };
        if (trackKey(artist) === trackKey(left)) return { title: right, artist };
      } else if ([cleaned, left, right].some((value) => value && trackKey(value) === key)) {
        return { title: mediaTitle, artist };
      }
    }
    if (separator) {
      return trackKey(right) === trackKey(channelArtist) ? { title: left, artist: right } : { title: right, artist: left };
    }
    return { title: cleaned, artist: channelArtist };
  }

  // extension/src/media-session-bridge.ts
  function readMediaSession() {
    let result;
    function receive(event) {
      const value = event.detail;
      if (typeof value !== "string" || value.length > 4096) return;
      try {
        const data2 = JSON.parse(value);
        if (typeof data2?.title !== "string" || typeof data2?.artist !== "string") return;
        const state = data2.state === "playing" || data2.state === "paused" ? data2.state : void 0;
        const album = typeof data2.album === "string" ? data2.album.slice(0, 200) : void 0;
        result = { title: data2.title.slice(0, 250), artist: data2.artist.slice(0, 250), album, state };
      } catch {
      }
    }
    window.addEventListener("moodshift:media-session", receive);
    window.dispatchEvent(new Event("moodshift:read-media-session"));
    window.removeEventListener("moodshift:media-session", receive);
    const session = navigator.mediaSession;
    const data = session?.metadata;
    return result ?? (data ? { title: data.title, artist: data.artist, album: data.album, state: session.playbackState } : void 0);
  }

  // extension/src/player-metadata.ts
  var text = (root, selector) => root.querySelector(selector)?.textContent?.trim() ?? "";
  function parsePlaybackTime(value) {
    if (!/^\d{1,3}:[0-5]\d(?::[0-5]\d)?$/.test(value)) return;
    return value.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0);
  }
  function mediaClock(media) {
    if (!media || !Number.isFinite(media.duration) || media.duration <= 0) return;
    return { duration: media.duration, position: media.currentTime, paused: media.paused || media.ended, rate: media.playbackRate };
  }
  function musicRecording(doc) {
    function read(value) {
      if (!value || typeof value !== "object") return;
      const node = value;
      const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
      if (!types.some((type) => type === "MusicRecording" || type === "https://schema.org/MusicRecording")) return;
      const artist = Array.isArray(node.byArtist) ? node.byArtist[0] : node.byArtist;
      const name = artist && typeof artist === "object" ? artist.name : artist;
      if (typeof node.name === "string" && typeof name === "string") return { title: node.name, artist: name };
    }
    for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).slice(0, 12)) {
      const raw = script.textContent;
      if (!raw || raw.length > 64e3) continue;
      try {
        const node = JSON.parse(raw);
        const nodes = Array.isArray(node) ? node : Array.isArray(node?.["@graph"]) ? [node, ...node["@graph"].slice(0, 24)] : [node];
        for (const candidate of nodes.slice(0, 25)) {
          const recording = read(candidate);
          if (recording) return recording;
        }
      } catch {
      }
    }
  }
  function complete(value) {
    return Boolean(value && trackKey(value.title) && trackKey(value.artist));
  }
  function matchingAlbum(song, metadata) {
    if (metadata?.album && trackKey(song.title) === trackKey(normalizeSongTitle(metadata.title)) && trackKey(song.artist) === trackKey(metadata.artist)) return metadata.album.trim().slice(0, 200) || void 0;
  }
  function readSongPlayback(doc, url, media, metadata) {
    let source = "browser";
    let song;
    let positionText = "";
    let durationText = "";
    let paused;
    let trackLink;
    if (url.hostname === "open.spotify.com") {
      const nowPlaying = doc.querySelector('[data-testid="now-playing-widget"], .now-playing');
      const title2 = nowPlaying?.querySelector('[data-testid="context-item-link"], a[href*="/track/"]');
      song = { title: title2?.textContent?.trim() ?? "", artist: nowPlaying ? text(nowPlaying, 'a[href*="/artist/"]') || text(nowPlaying, '[data-testid="context-item-info-subtitles"]') : "" };
      trackLink = title2?.getAttribute("href");
      positionText = text(doc, '[data-testid="playback-position"]');
      durationText = text(doc, '[data-testid="playback-duration"]');
      const control = doc.querySelector('[data-testid="control-button-playpause"]')?.getAttribute("aria-label");
      if (/^(?:play|pause)\b/i.test(control ?? "")) paused = /^play\b/i.test(control);
      source = "spotify";
    } else if (url.hostname === "music.youtube.com") {
      const player = doc.querySelector("ytmusic-player-bar");
      if (player) {
        song = { title: text(player, ".title"), artist: text(player, ".byline").split("\u2022")[0].trim() || text(player, ".byline a") };
        const time = text(player, ".time-info").split("/");
        positionText = time[0]?.trim();
        durationText = time[1]?.trim() ?? "";
        paused = player.hasAttribute("playing") ? false : void 0;
      }
      source = "youtube-music";
    } else if (["soundcloud.com", "www.soundcloud.com"].includes(url.hostname)) {
      const link = doc.querySelector(".playbackSoundBadge__titleLink");
      song = { title: link?.textContent?.trim() ?? "", artist: text(doc, ".playbackSoundBadge__lightLink") };
      trackLink = link?.getAttribute("href");
      positionText = text(doc, '.playbackTimeline__timePassed [aria-hidden="true"], .playbackTimeline__timePassed');
      durationText = text(doc, '.playbackTimeline__duration [aria-hidden="true"], .playbackTimeline__duration');
      const button = doc.querySelector(".playControl");
      if (button) paused = !button.classList.contains("playing");
      source = "soundcloud";
    }
    if (!complete(song)) {
      const recording = musicRecording(doc);
      const meta = (name) => doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content") ?? "";
      const explicitMusic = meta("og:type") === "music.song" || recording || media?.tagName === "AUDIO";
      const tagged = explicitMusic ? { title: meta("og:title") || doc.title, artist: meta("music:artist") || meta("artist") } : void 0;
      song = (explicitMusic || source !== "browser") && complete(metadata) ? metadata : complete(recording) ? recording : complete(tagged) ? tagged : void 0;
      source = "browser";
    }
    const duration = parsePlaybackTime(durationText);
    const position = parsePlaybackTime(positionText);
    const native = mediaClock(media);
    const playerClock = duration !== void 0 && position !== void 0 && duration > 0 && position <= duration + 1 ? { duration, position: Math.min(position, duration), paused: paused ?? metadata?.state !== "playing", rate: 1 } : void 0;
    const clock = native && (!playerClock || Math.abs(native.duration - playerClock.duration) <= 2) ? native : playerClock;
    if (!clock && !song) return null;
    const title = normalizeSongTitle(song?.title.slice(0, 250) ?? "").slice(0, 200);
    const artist = song?.artist.trim().slice(0, 200) ?? "";
    const identity = trackLink?.split(/[?#]/)[0].slice(0, 250) || (title && artist ? `${trackKey(title)}:${trackKey(artist)}` : url.pathname.slice(0, 250));
    const trackId = `${url.hostname}:${identity}`;
    return {
      trackId,
      source,
      song: { title, artist, duration: clock?.duration ?? 0, album: matchingAlbum({ title, artist }, metadata) },
      position: clock?.position ?? 0,
      paused: clock?.paused ?? true,
      rate: clock?.rate ?? 1
    };
  }

  // extension/src/playback-speed.ts
  var PlaybackSpeedLease = class {
    set(owner, enabled, player) {
      if (!enabled) {
        this.release(owner);
        if (this.blocked === owner) this.blocked = void 0;
        return { state: "idle" };
      }
      if (this.blocked === owner) return { state: "unavailable", message: "Playback speed changed in the player. Reverb remains active." };
      if (this.owned && (this.owned.owner !== owner || this.owned.player !== player)) this.release();
      if (!player || !Number.isFinite(player.duration) || player.duration <= 0) {
        this.release();
        return { state: "unavailable", message: "Reverb active. Slowing is unavailable for this playback." };
      }
      if (this.owned && Math.abs(player.playbackRate - this.owned.applied) > 1e-3) {
        this.blocked = owner;
        this.release();
        return { state: "unavailable", message: "Playback speed changed in the player. Reverb remains active." };
      }
      if (!this.owned) {
        const original = player.playbackRate;
        if (!Number.isFinite(original) || original < 0.5 || original > 2) return { state: "unavailable", message: "Reverb active. Use a player speed between 0.5\xD7 and 2\xD7 to enable slowing." };
        this.owned = { owner, player, original, applied: original * 0.85 };
        try {
          player.playbackRate = this.owned.applied;
          if (Math.abs(player.playbackRate - this.owned.applied) > 1e-3) throw new Error("Player rejected rate.");
        } catch {
          this.release();
          return { state: "unavailable", message: "Reverb active. The player refused speed control." };
        }
      }
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.release(), 7e3);
      return { state: "active", rate: player.playbackRate };
    }
    release(owner) {
      if (owner && this.owned?.owner !== owner) return;
      clearTimeout(this.timer);
      const owned = this.owned;
      this.owned = void 0;
      if (owned && Math.abs(owned.player.playbackRate - owned.applied) < 1e-3) {
        try {
          owned.player.playbackRate = owned.original;
        } catch {
        }
      }
    }
  };

  // extension/src/player-captions.ts
  function captionTrack(tracks) {
    const readable = Array.from(tracks).filter((track) => track.kind === "captions" || track.kind === "subtitles");
    return readable.find((track) => track.mode === "showing") ?? readable.find((track) => track.mode === "hidden") ?? readable[0];
  }
  function nearbyCaptions(cues, position) {
    if (!cues) return [];
    const from = Math.max(0, position - 40);
    let first = 0;
    let last = cues.length;
    while (first < last) {
      const mid = first + last >>> 1;
      if (cues[mid].startTime < from) first = mid + 1;
      else last = mid;
    }
    const result = [];
    for (let index = Math.max(0, first - 1); index < cues.length && index < first + 80; index++) {
      const cue = cues[index];
      if (cue.startTime > position + 6) break;
      if (!Number.isFinite(cue.startTime) || !Number.isFinite(cue.endTime) || cue.endTime <= Math.max(from, cue.startTime) || typeof cue.text !== "string") continue;
      const text2 = cue.text.slice(0, 1e3).replace(/<[^>]*>/g, "").trim();
      if (text2) result.push({ time: cue.startTime, end: cue.endTime, text: text2 });
    }
    return result;
  }

  // extension/src/youtube-playback.ts
  var mediaEvents = [
    "timeupdate",
    "play",
    "pause",
    "playing",
    "seeking",
    "seeked",
    "ratechange",
    "durationchange",
    "loadedmetadata",
    "emptied",
    "ended"
  ];
  var world = globalThis;
  if (!world.moodshiftWatchingPlayback) {
    world.moodshiftWatchingPlayback = true;
    const reverbSpeed = new PlaybackSpeedLease();
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (location.hostname !== "www.youtube.com" || message?.type !== "REVERB_PLAYBACK" || sender.id !== chrome.runtime.id) return;
      if (typeof message.owner !== "string" || message.owner.length > 120 || typeof message.enabled !== "boolean") return;
      const player = document.querySelector("#movie_player.ad-showing") ? void 0 : document.querySelector("#movie_player video.html5-main-video") ?? void 0;
      reply(reverbSpeed.set(message.owner, message.enabled, player));
    });
    document.addEventListener("yt-navigate-start", () => reverbSpeed.release());
    window.addEventListener("pagehide", () => reverbSpeed.release());
    chrome.runtime.onConnect.addListener(watch);
  }
  function watch(port) {
    if (port.name !== youtubePlaybackPort) return;
    let player;
    let navigating = false;
    let captionsEnabled = false;
    let hiddenTrack;
    let lastReport = "";
    let lastSample = -Infinity;
    function releaseTrack() {
      if (hiddenTrack?.mode === "hidden") hiddenTrack.mode = "disabled";
      hiddenTrack = void 0;
    }
    function report(playback) {
      const track = playback && !playback.ad && captionsEnabled && player ? captionTrack(player.textTracks) : void 0;
      if (track !== hiddenTrack) releaseTrack();
      if (track?.mode === "disabled") {
        track.mode = "hidden";
        hiddenTrack = track;
      }
      if (playback) {
        playback.sampledAt = performance.timeOrigin + performance.now();
        if (track) playback.captions = nearbyCaptions(track.cues, playback.position);
      }
      const payload = JSON.stringify(playback);
      if (lastReport !== payload) {
        lastReport = payload;
        port.postMessage(playback);
      }
    }
    function watchPlayback(event) {
      if (event?.type === "timeupdate" && performance.now() - lastSample < 180) return;
      lastSample = performance.now();
      const url = new URL(location.href);
      const id = youtubeVideoId(url);
      const youtube = url.hostname === "www.youtube.com";
      const watch2 = youtube ? document.querySelector("ytd-watch-flexy") : null;
      const media = youtube ? [] : Array.from(document.querySelectorAll("audio, video"));
      const video = youtube ? document.querySelector("#movie_player video.html5-main-video") ?? void 0 : media.find((element) => !element.paused && !element.ended && Number.isFinite(element.duration)) ?? media.find((element) => Number.isFinite(element.duration) && element.duration > 0);
      if (video !== player) {
        releaseTrack();
        for (const name of mediaEvents) {
          player?.removeEventListener(name, watchPlayback);
          video?.addEventListener(name, watchPlayback);
        }
        player = video;
      }
      if (!youtube) {
        report(readSongPlayback(document, url, player, readMediaSession()));
        return;
      }
      const title = watch2?.querySelector("ytd-watch-metadata h1")?.textContent?.trim();
      if (!id || navigating || watch2?.getAttribute("video-id") !== id || !title) {
        report(null);
        return;
      }
      const channel = watch2.querySelector("#owner ytd-channel-name a")?.textContent?.trim() ?? "";
      const ad = Boolean(document.querySelector("#movie_player.ad-showing"));
      const metadata = ad ? void 0 : readMediaSession();
      const song = identifySong(title, channel, metadata);
      const content = !ad && video && Number.isFinite(video.duration) && video.duration > 0 ? video : void 0;
      report({
        videoId: id,
        song: { ...song, album: matchingAlbum(song, metadata), duration: content?.duration ?? 0 },
        position: content?.currentTime ?? 0,
        paused: !content || content.paused || content.ended,
        rate: content?.playbackRate ?? 1,
        ad
      });
    }
    function navigationStart() {
      navigating = true;
      report(null);
    }
    function navigationFinish() {
      navigating = false;
      watchPlayback();
    }
    const interval = setInterval(watchPlayback, 350);
    port.onMessage.addListener((message) => {
      if (message?.type !== "captions" || typeof message.enabled !== "boolean") return;
      captionsEnabled = message.enabled;
      watchPlayback();
    });
    document.addEventListener("yt-navigate-start", navigationStart);
    document.addEventListener("yt-navigate-finish", navigationFinish);
    port.onDisconnect.addListener(() => {
      releaseTrack();
      clearInterval(interval);
      document.removeEventListener("yt-navigate-start", navigationStart);
      document.removeEventListener("yt-navigate-finish", navigationFinish);
      for (const name of mediaEvents) player?.removeEventListener(name, watchPlayback);
    });
    watchPlayback();
  }
})();
