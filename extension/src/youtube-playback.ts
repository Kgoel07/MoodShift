import { identifySong, youtubePlaybackPort, youtubeVideoId, type YouTubePlayback } from './shared/lyrics';

const mediaEvents = ['timeupdate', 'play', 'pause', 'playing', 'seeking', 'seeked', 'ratechange',
  'durationchange', 'loadedmetadata', 'emptied', 'ended'] as const;

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== youtubePlaybackPort) return;

  let player: HTMLVideoElement | undefined;
  let navigating = false;
  let lastReport = '';
  let lastSample = -Infinity;

  function report(playback: YouTubePlayback | null): void {
    const payload = JSON.stringify(playback);
    if (lastReport !== payload) {
      lastReport = payload;
      port.postMessage(playback);
    }
  }

  function watchPlayback(event?: Event): void {
    if (event?.type === 'timeupdate' && performance.now() - lastSample < 180) return;
    lastSample = performance.now();
    const id = youtubeVideoId(new URL(location.href));
    const watch = document.querySelector('ytd-watch-flexy');
    const video = document.querySelector<HTMLVideoElement>('#movie_player video.html5-main-video') ?? undefined;
    if (video !== player) {
      for (const name of mediaEvents) {
        player?.removeEventListener(name, watchPlayback);
        video?.addEventListener(name, watchPlayback);
      }
      player = video;
    }
    const title = watch?.querySelector('ytd-watch-metadata h1')?.textContent?.trim();
    if (!id || navigating || watch?.getAttribute('video-id') !== id || !title) {
      report(null);
      return;
    }

    const channel = watch.querySelector('#owner ytd-channel-name a')?.textContent?.trim() ?? '';
    const ad = Boolean(document.querySelector('#movie_player.ad-showing'));
    const metadata = ad ? undefined : navigator.mediaSession?.metadata;
    const content = !ad && video && Number.isFinite(video.duration) && video.duration > 0 ? video : undefined;
    report({
      videoId: id,
      song: { ...identifySong(title, channel, metadata ?? undefined), duration: content?.duration ?? 0 },
      position: content?.currentTime ?? 0,
      paused: !content || content.paused || content.ended,
      rate: content?.playbackRate ?? 1,
      ad,
    });
  }

  function navigationStart(): void {
    navigating = true;
    report(null);
  }

  function navigationFinish(): void {
    navigating = false;
    watchPlayback();
  }

  const interval = setInterval(watchPlayback, 350);
  document.addEventListener('yt-navigate-start', navigationStart);
  document.addEventListener('yt-navigate-finish', navigationFinish);
  port.onDisconnect.addListener(() => {
    clearInterval(interval);
    document.removeEventListener('yt-navigate-start', navigationStart);
    document.removeEventListener('yt-navigate-finish', navigationFinish);
    for (const name of mediaEvents) player?.removeEventListener(name, watchPlayback);
  });
  watchPlayback();
});
