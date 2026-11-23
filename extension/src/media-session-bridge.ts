import type { MediaSessionInfo } from './player-metadata';

// Chrome serializes this function when injecting it into the selected tab's page world.
export function installMediaSessionBridge(): void {
  const page = window as Window & { moodshiftMediaSessionBridge?: boolean };
  if (page.moodshiftMediaSessionBridge) return;
  page.moodshiftMediaSessionBridge = true;
  window.addEventListener('moodshift:read-media-session', () => {
    const session = navigator.mediaSession;
    const data = session?.metadata;
    window.dispatchEvent(new CustomEvent('moodshift:media-session', { detail: JSON.stringify({
      title: data?.title.slice(0, 250) ?? '', artist: data?.artist.slice(0, 250) ?? '', album: data?.album.slice(0, 200),
      state: session?.playbackState,
    }) }));
  });
}

export function readMediaSession(): MediaSessionInfo | undefined {
  let result: MediaSessionInfo | undefined;
  function receive(event: Event): void {
    const value = (event as CustomEvent<unknown>).detail;
    if (typeof value !== 'string' || value.length > 4096) return;
    try {
      const data = JSON.parse(value);
      if (typeof data?.title !== 'string' || typeof data?.artist !== 'string') return;
      const state = data.state === 'playing' || data.state === 'paused' ? data.state : undefined;
      const album = typeof data.album === 'string' ? data.album.slice(0, 200) : undefined;
      result = { title: data.title.slice(0, 250), artist: data.artist.slice(0, 250), album, state };
    } catch {
      // Ignore unreadable page responses.
    }
  }
  window.addEventListener('moodshift:media-session', receive);
  window.dispatchEvent(new Event('moodshift:read-media-session'));
  window.removeEventListener('moodshift:media-session', receive);
  const session = navigator.mediaSession;
  const data = session?.metadata;
  return result ?? (data ? { title: data.title, artist: data.artist, album: data.album, state: session.playbackState } : undefined);
}
