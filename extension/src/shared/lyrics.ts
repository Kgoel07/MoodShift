export interface SongQuery {
  title: string;
  artist: string;
  duration: number;
  album?: string;
}

interface PlaybackClock {
  song: SongQuery;
  position: number;
  paused: boolean;
  rate: number;
  ad?: boolean;
  sampledAt?: number;
  captions?: CaptionCue[];
}

export interface YouTubePlayback extends PlaybackClock {
  videoId: string;
  source?: 'youtube';
}

export interface SongPlayback extends PlaybackClock {
  trackId: string;
  source: 'spotify' | 'youtube-music' | 'soundcloud' | 'browser';
}

export type PlayerPlayback = YouTubePlayback | SongPlayback;
export type CaptionCue = { time: number; end: number; text: string };

export function playbackKey(playback?: PlayerPlayback | null): string | undefined {
  if (!playback) return;
  return 'videoId' in playback ? playback.videoId : playback.trackId;
}

export const youtubePlaybackPort = 'moodshift-youtube-playback';

export interface LyricLine {
  time: number;
  text: string;
}

export type LyricsResult =
  | { kind: 'synced'; lines: LyricLine[] }
  | { kind: 'plain'; text: string }
  | { kind: 'missing' | 'instrumental' | 'invalid' | 'error' | 'ambiguous' }
  | { kind: 'limited'; retryAt: number };

export interface LyricsRequest {
  target: 'lyrics';
  query: SongQuery;
  retry?: boolean;
  requestId?: string;
}

export type LyricsCancel = { target: 'lyrics'; cancel: string };

export function trackKey(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function youtubeVideoId(url: URL): string | undefined {
  const id = url.searchParams.get('v');
  if (url.hostname === 'www.youtube.com' && url.pathname === '/watch' && id && /^[\w-]{11}$/.test(id)) return id;
}

export function normalizeSongTitle(value: string): string {
  return value.replace(/\s*[-–—|]\s*(?:YouTube(?: Music)?|Spotify|SoundCloud)\s*$/i, '')
    .replace(/\s*[[(](?:official\s+(?:music\s+video|audio|video|lyric(?:s)?\s+video)|music\s+video|lyric(?:s)?\s+video|lyrics|visuali[sz]er|hd|4k)[\])]\s*/gi, ' ')
    .replace(/\s+[-–—|]\s+(?:official\s+(?:music\s+video|video|audio)|(?:song\s+)?lyrics)\s*$/i, '')
    .replace(/\s+/g, ' ').trim();
}

export function identifySong(videoTitle: string, channel: string, media?: { title: string; artist: string }) {
  const cleaned = normalizeSongTitle(videoTitle);
  const cleanArtist = (value: string) => value.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  const channelArtist = cleanArtist(channel);
  const separator = cleaned.match(/\s+[-–—~]\s+/);
  const left = separator ? cleaned.slice(0, separator.index) : '';
  const right = separator ? cleaned.slice(separator.index! + separator[0].length) : '';
  // Prefer native metadata only when its title agrees with this video's title.
  if (media?.artist.trim() && media.title.trim()) {
    const mediaTitle = normalizeSongTitle(media.title);
    const artist = cleanArtist(media.artist);
    const key = trackKey(mediaTitle);
    if (key === trackKey(cleaned) && separator) {
      if (trackKey(artist) === trackKey(right)) return { title: left, artist };
      if (trackKey(artist) === trackKey(left)) return { title: right, artist };
    } else if ([cleaned, left, right].some(value => value && trackKey(value) === key)) {
      return { title: mediaTitle, artist };
    }
  }
  if (separator) {
    return trackKey(right) === trackKey(channelArtist)
      ? { title: left, artist: right }
      : { title: right, artist: left };
  }
  return { title: cleaned, artist: channelArtist };
}

export function parseLrc(text: string): LyricLine[] {
  const offset = Number(text.match(/^\s*\[offset:([+-]?\d+)\]\s*$/im)?.[1] ?? 0) / 1000;
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const entry = raw.trimStart();
    const tags = entry.match(/^(?:\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\])+/)?.[0];
    if (!tags) continue;
    const lyric = entry.slice(tags.length).replace(/<\d{1,3}:[0-5]\d(?:\.\d{1,3})?>/g, '').trim();
    for (const match of tags.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)) {
      const seconds = Number(match[1]) * 60 + Number(match[2]) + Number('0.' + (match[3] ?? '0'));
      lines.push({ time: Math.max(0, seconds - offset), text: lyric });
    }
  }
  if (!lines.some(line => line.text)) return [];
  // Keep simultaneous lines together and honor empty timestamps as section breaks.
  const merged: LyricLine[] = [];
  for (const line of lines.sort((a, b) => a.time - b.time)) {
    const last = merged.at(-1);
    if (last?.time !== line.time) merged.push(line);
    else if (line.text && line.text !== last.text) last.text = [last.text, line.text].filter(Boolean).join('\n');
  }
  return merged;
}

export function synchronizedPosition(playback: PlaybackClock, offset: number): number {
  return playback.position - offset * playback.rate;
}

export function activeLyric(lines: readonly LyricLine[], playback: PlaybackClock, offset: number): number {
  const position = synchronizedPosition(playback, offset);
  let start = 0;
  let end = lines.length;
  while (start < end) {
    const mid = (start + end) >>> 1;
    if (lines[mid].time <= position) start = mid + 1;
    else end = mid;
  }
  return start - 1;
}

export function validSong(query: SongQuery): boolean {
  return !!trackKey(query.title) && !!trackKey(query.artist) && query.title.length <= 200 && query.artist.length <= 200
    && (query.album === undefined || (typeof query.album === 'string' && query.album.length <= 200))
    && Number.isFinite(query.duration) && query.duration >= 1 && query.duration <= 3600;
}
