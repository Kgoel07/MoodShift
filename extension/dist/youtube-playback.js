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
  function titleText(value) {
    return value.replace(/\s*[-–—]\s*YouTube\s*$/i, "").replace(/\s*[[(](?:official\s+(?:music\s+video|audio|video|lyric(?:s)?\s+video)|music\s+video|lyric(?:s)?\s+video|lyrics|visuali[sz]er|hd|4k)[\])]\s*/gi, " ").replace(/\s+/g, " ").trim();
  }
  function identifySong(videoTitle, channel, media) {
    const cleaned = titleText(videoTitle);
    const cleanArtist = (value) => value.replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").trim();
    const channelArtist = cleanArtist(channel);
    const separator = cleaned.match(/\s+[-–—~]\s+/);
    const left = separator ? cleaned.slice(0, separator.index) : "";
    const right = separator ? cleaned.slice(separator.index + separator[0].length) : "";
    if (media?.artist.trim() && media.title.trim()) {
      const mediaTitle = titleText(media.title);
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
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== youtubePlaybackPort) return;
    let player;
    let navigating = false;
    let lastReport = "";
    let lastSample = -Infinity;
    function report(playback) {
      const payload = JSON.stringify(playback);
      if (lastReport !== payload) {
        lastReport = payload;
        port.postMessage(playback);
      }
    }
    function watchPlayback(event) {
      if (event?.type === "timeupdate" && performance.now() - lastSample < 180) return;
      lastSample = performance.now();
      const id = youtubeVideoId(new URL(location.href));
      const watch = document.querySelector("ytd-watch-flexy");
      const video = document.querySelector("#movie_player video.html5-main-video") ?? void 0;
      if (video !== player) {
        for (const name of mediaEvents) {
          player?.removeEventListener(name, watchPlayback);
          video?.addEventListener(name, watchPlayback);
        }
        player = video;
      }
      const title = watch?.querySelector("ytd-watch-metadata h1")?.textContent?.trim();
      if (!id || navigating || watch?.getAttribute("video-id") !== id || !title) {
        report(null);
        return;
      }
      const channel = watch.querySelector("#owner ytd-channel-name a")?.textContent?.trim() ?? "";
      const ad = Boolean(document.querySelector("#movie_player.ad-showing"));
      const metadata = ad ? void 0 : navigator.mediaSession?.metadata;
      const content = !ad && video && Number.isFinite(video.duration) && video.duration > 0 ? video : void 0;
      report({
        videoId: id,
        song: { ...identifySong(title, channel, metadata ?? void 0), duration: content?.duration ?? 0 },
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
    document.addEventListener("yt-navigate-start", navigationStart);
    document.addEventListener("yt-navigate-finish", navigationFinish);
    port.onDisconnect.addListener(() => {
      clearInterval(interval);
      document.removeEventListener("yt-navigate-start", navigationStart);
      document.removeEventListener("yt-navigate-finish", navigationFinish);
      for (const name of mediaEvents) player?.removeEventListener(name, watchPlayback);
    });
    watchPlayback();
  });
})();
