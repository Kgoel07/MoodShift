import { identifySong, youtubePlaybackPort, youtubeVideoId, type PlayerPlayback } from './shared/lyrics';
import { readMediaSession } from './media-session-bridge';
import { matchingAlbum, readSongPlayback } from './player-metadata';
import { PlaybackSpeedLease } from './playback-speed';
import { captionTrack, nearbyCaptions } from './player-captions';

const mediaEvents = ['timeupdate', 'play', 'pause', 'playing', 'seeking', 'seeked', 'ratechange',
  'durationchange', 'loadedmetadata', 'emptied', 'ended'] as const;

const world = globalThis as typeof globalThis & { moodshiftWatchingPlayback?: boolean };
if (!world.moodshiftWatchingPlayback) {
  world.moodshiftWatchingPlayback = true;
  const reverbSpeed = new PlaybackSpeedLease();
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (location.hostname !== 'www.youtube.com' || message?.type !== 'REVERB_PLAYBACK' || sender.id !== chrome.runtime.id) return;
    if (typeof message.owner !== 'string' || message.owner.length > 120 || typeof message.enabled !== 'boolean') return;
    const player = document.querySelector('#movie_player.ad-showing') ? undefined
      : document.querySelector<HTMLVideoElement>('#movie_player video.html5-main-video') ?? undefined;
    reply(reverbSpeed.set(message.owner, message.enabled, player));
  });
  document.addEventListener('yt-navigate-start', () => reverbSpeed.release());
  window.addEventListener('pagehide', () => reverbSpeed.release());
  chrome.runtime.onConnect.addListener(watch);
}

function watch(port: chrome.runtime.Port): void {
  if (port.name !== youtubePlaybackPort) return;

  let player: HTMLMediaElement | undefined;
  let navigating = false;
  let captionsEnabled = false;
  let hiddenTrack: TextTrack | undefined;
  let lastReport = '';
  let lastSample = -Infinity;

  function releaseTrack(): void {
    if (hiddenTrack?.mode === 'hidden') hiddenTrack.mode = 'disabled';
    hiddenTrack = undefined;
  }

  function report(playback: PlayerPlayback | null): void {
    const track = playback && !playback.ad && captionsEnabled && player ? captionTrack(player.textTracks) : undefined;
    if (track !== hiddenTrack) releaseTrack();
    if (track?.mode === 'disabled') {
      track.mode = 'hidden';
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

  function watchPlayback(event?: Event): void {
    if (event?.type === 'timeupdate' && performance.now() - lastSample < 180) return;
    lastSample = performance.now();
    const url = new URL(location.href);
    const id = youtubeVideoId(url);
    const youtube = url.hostname === 'www.youtube.com';
    const watch = youtube ? document.querySelector('ytd-watch-flexy') : null;
    const media = youtube ? [] : Array.from(document.querySelectorAll<HTMLMediaElement>('audio, video'));
    const video = youtube ? document.querySelector<HTMLVideoElement>('#movie_player video.html5-main-video') ?? undefined
      : media.find(element => !element.paused && !element.ended && Number.isFinite(element.duration))
        ?? media.find(element => Number.isFinite(element.duration) && element.duration > 0);
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
    const title = watch?.querySelector('ytd-watch-metadata h1')?.textContent?.trim();
    if (!id || navigating || watch?.getAttribute('video-id') !== id || !title) {
      report(null);
      return;
    }

    const channel = watch.querySelector('#owner ytd-channel-name a')?.textContent?.trim() ?? '';
    const ad = Boolean(document.querySelector('#movie_player.ad-showing'));
    const metadata = ad ? undefined : readMediaSession();
    const song = identifySong(title, channel, metadata);
    const content = !ad && video && Number.isFinite(video.duration) && video.duration > 0 ? video : undefined;
    report({
      videoId: id,
      song: { ...song, album: matchingAlbum(song, metadata), duration: content?.duration ?? 0 },
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
  port.onMessage.addListener((message: { type?: string; enabled?: boolean }) => {
    if (message?.type !== 'captions' || typeof message.enabled !== 'boolean') return;
    captionsEnabled = message.enabled;
    watchPlayback();
  });
  document.addEventListener('yt-navigate-start', navigationStart);
  document.addEventListener('yt-navigate-finish', navigationFinish);
  port.onDisconnect.addListener(() => {
    releaseTrack();
    clearInterval(interval);
    document.removeEventListener('yt-navigate-start', navigationStart);
    document.removeEventListener('yt-navigate-finish', navigationFinish);
    for (const name of mediaEvents) player?.removeEventListener(name, watchPlayback);
  });
  watchPlayback();
}
