import { platforms, trackTitle, youtubeArtwork, type SourcePlatform } from './shared/track';
import type { CaptureStatus } from './shared/types';
import type { PlayerPlayback } from './shared/lyrics';

const marks: Record<SourcePlatform, string> = {
  youtube: '<rect x="2" y="5" width="20" height="14" rx="4" fill="currentColor"/><path d="m10 9 6 3-6 3z" fill="var(--panel)"/>',
  spotify: '<circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M6 9c4-1 8-.6 12 1.5M7 12.5c3.5-.7 6.5-.4 10 1M8 16c3-.6 5-.3 7 .7" fill="none" stroke="var(--panel)" stroke-width="1.5" stroke-linecap="round"/>',
  soundcloud: '<path d="M10 17V8a5.5 5.5 0 0 1 9 3.5 2.8 2.8 0 1 1 1 5.5z" fill="currentColor"/><path d="M2 14v2m3-4v5m3-7v7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  tab: '<path d="M9 17V6l10-2v11M9 9l10-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><ellipse cx="6" cy="17" rx="3.5" ry="2.5" fill="currentColor"/><ellipse cx="16" cy="15" rx="3.5" ry="2.5" fill="currentColor"/>',
};

export function mountNowPlaying() {
  const title = document.querySelector<HTMLElement>('#status')!;
  const artist = document.querySelector<HTMLElement>('#track-artist')!;
  const source = document.querySelector<HTMLElement>('#track-platform')!;
  const artwork = document.querySelector<HTMLImageElement>('#song-artwork')!;
  const frame = document.querySelector<HTMLElement>('#track-art')!;
  const icon = document.querySelector<HTMLElement>('#platform-icon')!;
  let status: CaptureStatus = { phase: 'ready' };
  let playback: PlayerPlayback | null = null;
  let imageUrl: string | undefined;
  let platform: SourcePlatform | undefined;

  artwork.addEventListener('load', () => { artwork.hidden = !imageUrl || artwork.currentSrc !== imageUrl; });
  artwork.addEventListener('error', () => { artwork.hidden = true; });

  function render(): void {
    const session = status.phase === 'capturing' ? status.session : undefined;
    const current = session?.platform ?? 'tab';
    frame.parentElement!.dataset.phase = status.phase;
    if (current !== platform) {
      platform = current;
      frame.dataset.platform = current;
      icon.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22">${marks[current]}</svg>`;
    }
    const song = session && !playback?.ad ? playback?.song : undefined;
    const nextImage = song?.title && playback && 'videoId' in playback ? youtubeArtwork(playback.videoId) : undefined;
    if (nextImage !== imageUrl) {
      imageUrl = nextImage;
      artwork.hidden = true;
      if (nextImage) artwork.src = nextImage;
      else artwork.removeAttribute('src');
    }
    const setText = (element: HTMLElement, value: string) => {
      if (element.textContent !== value) element.textContent = value;
    };
    setText(source, session ? platforms[current] : 'Now playing');
    setText(title, session ? song?.title || trackTitle(session.title, current)
      : status.phase === 'starting' ? 'Connecting to this tab…' : status.phase === 'error' ? 'Couldn’t connect to this tab' : 'Choose a playing tab');
    setText(artist, session ? song?.artist ?? '' : status.phase === 'error' ? status.message
      : status.phase === 'starting' ? status.source.title : 'Click the MoodShift icon on the tab.');
    title.title = title.textContent ?? '';
    artist.title = artist.textContent ?? '';
    artist.hidden = !artist.textContent;
  }
  return {
    setStatus(next: CaptureStatus) {
      const previous = status.phase === 'capturing' ? status.session : undefined;
      const session = next.phase === 'capturing' ? next.session : undefined;
      if (previous?.id !== session?.id || previous?.title !== session?.title || previous?.platform !== session?.platform) playback = null;
      status = next;
      render();
    },
    setPlayback(next: PlayerPlayback | null) { playback = next; render(); },
  };
}
