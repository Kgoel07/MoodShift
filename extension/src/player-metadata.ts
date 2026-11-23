import { normalizeSongTitle, trackKey, type SongPlayback } from './shared/lyrics';

type Metadata = { title: string; artist: string };
export type MediaSessionInfo = Metadata & { album?: string; state?: MediaSessionPlaybackState };

const text = (root: ParentNode, selector: string) => root.querySelector(selector)?.textContent?.trim() ?? '';

export function parsePlaybackTime(value: string): number | undefined {
  if (!/^\d{1,3}:[0-5]\d(?::[0-5]\d)?$/.test(value)) return;
  return value.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

export function mediaClock(media?: HTMLMediaElement) {
  if (!media || !Number.isFinite(media.duration) || media.duration <= 0) return;
  return { duration: media.duration, position: media.currentTime, paused: media.paused || media.ended, rate: media.playbackRate };
}

function musicRecording(doc: Document): Metadata | undefined {
  function read(value: unknown): Metadata | undefined {
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (!types.some(type => type === 'MusicRecording' || type === 'https://schema.org/MusicRecording')) return;
    const artist = Array.isArray(node.byArtist) ? node.byArtist[0] : node.byArtist;
    const name = artist && typeof artist === 'object' ? (artist as { name?: unknown }).name : artist;
    if (typeof node.name === 'string' && typeof name === 'string') return { title: node.name, artist: name };
  }
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).slice(0, 12)) {
    const raw = script.textContent;
    if (!raw || raw.length > 64_000) continue;
    try {
      const node = JSON.parse(raw);
      const nodes = Array.isArray(node) ? node : Array.isArray(node?.['@graph']) ? [node, ...node['@graph'].slice(0, 24)] : [node];
      for (const candidate of nodes.slice(0, 25)) {
        const recording = read(candidate);
        if (recording) return recording;
      }
    } catch {
      // A page can have invalid structured metadata alongside a usable player.
    }
  }
}

function complete(value?: Metadata | null): value is Metadata {
  return Boolean(value && trackKey(value.title) && trackKey(value.artist));
}

export function matchingAlbum(song: Metadata, metadata?: MediaSessionInfo | null): string | undefined {
  if (metadata?.album && trackKey(song.title) === trackKey(normalizeSongTitle(metadata.title))
    && trackKey(song.artist) === trackKey(metadata.artist)) return metadata.album.trim().slice(0, 200) || undefined;
}

export function readSongPlayback(doc: Document, url: URL, media?: HTMLMediaElement,
  metadata?: MediaSessionInfo | null): SongPlayback | null {
  let source: SongPlayback['source'] = 'browser';
  let song: Metadata | undefined;
  let positionText = '';
  let durationText = '';
  let paused: boolean | undefined;
  let trackLink: string | null | undefined;

  if (url.hostname === 'open.spotify.com') {
    const nowPlaying = doc.querySelector('[data-testid="now-playing-widget"], .now-playing');
    const title = nowPlaying?.querySelector('[data-testid="context-item-link"], a[href*="/track/"]');
    song = { title: title?.textContent?.trim() ?? '', artist: nowPlaying ? text(nowPlaying, 'a[href*="/artist/"]')
      || text(nowPlaying, '[data-testid="context-item-info-subtitles"]') : '' };
    trackLink = title?.getAttribute('href');
    positionText = text(doc, '[data-testid="playback-position"]');
    durationText = text(doc, '[data-testid="playback-duration"]');
    const control = doc.querySelector('[data-testid="control-button-playpause"]')?.getAttribute('aria-label');
    if (/^(?:play|pause)\b/i.test(control ?? '')) paused = /^play\b/i.test(control!);
    source = 'spotify';
  } else if (url.hostname === 'music.youtube.com') {
    const player = doc.querySelector('ytmusic-player-bar');
    if (player) {
      song = { title: text(player, '.title'), artist: text(player, '.byline').split('•')[0].trim() || text(player, '.byline a') };
      const time = text(player, '.time-info').split('/');
      positionText = time[0]?.trim();
      durationText = time[1]?.trim() ?? '';
      paused = player.hasAttribute('playing') ? false : undefined;
    }
    source = 'youtube-music';
  } else if (['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname)) {
    const link = doc.querySelector('.playbackSoundBadge__titleLink');
    song = { title: link?.textContent?.trim() ?? '', artist: text(doc, '.playbackSoundBadge__lightLink') };
    trackLink = link?.getAttribute('href');
    positionText = text(doc, '.playbackTimeline__timePassed [aria-hidden="true"], .playbackTimeline__timePassed');
    durationText = text(doc, '.playbackTimeline__duration [aria-hidden="true"], .playbackTimeline__duration');
    const button = doc.querySelector('.playControl');
    if (button) paused = !button.classList.contains('playing');
    source = 'soundcloud';
  }

  if (!complete(song)) {
    const recording = musicRecording(doc);
    const meta = (name: string) => doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute('content') ?? '';
    const explicitMusic = meta('og:type') === 'music.song' || recording || media?.tagName === 'AUDIO';
    const tagged = explicitMusic ? { title: meta('og:title') || doc.title, artist: meta('music:artist') || meta('artist') } : undefined;
    song = (explicitMusic || source !== 'browser') && complete(metadata) ? metadata
      : complete(recording) ? recording : complete(tagged) ? tagged : undefined;
    source = 'browser';
  }

  const duration = parsePlaybackTime(durationText);
  const position = parsePlaybackTime(positionText);
  const native = mediaClock(media);
  const playerClock = duration !== undefined && position !== undefined && duration > 0 && position <= duration + 1
    ? { duration, position: Math.min(position, duration), paused: paused ?? (metadata?.state !== 'playing'), rate: 1 } : undefined;
  const clock = native && (!playerClock || Math.abs(native.duration - playerClock.duration) <= 2)
    ? native : playerClock;
  if (!clock && !song) return null;

  const title = normalizeSongTitle(song?.title.slice(0, 250) ?? '').slice(0, 200);
  const artist = song?.artist.trim().slice(0, 200) ?? '';
  const identity = trackLink?.split(/[?#]/)[0].slice(0, 250) || (title && artist
    ? `${trackKey(title)}:${trackKey(artist)}` : url.pathname.slice(0, 250));
  const trackId = `${url.hostname}:${identity}`;
  return { trackId, source, song: { title, artist, duration: clock?.duration ?? 0, album: matchingAlbum({ title, artist }, metadata) },
    position: clock?.position ?? 0, paused: clock?.paused ?? true, rate: clock?.rate ?? 1 };
}
