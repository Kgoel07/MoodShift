import { expect, it, vi } from 'vitest';
import { captionTrack, canUseCaptions, currentCaptions, nearbyCaptions } from '../extension/src/player-captions';
import { readSongPlayback } from '../extension/src/player-metadata';
import { playoutDelay, calibratedLyricsPosition, PlaybackTimeline } from '../extension/src/playout-timing';
import { restoreLyricsCorrection } from '../extension/src/shared/display-settings';
import { LyricsSession } from '../extension/src/lyrics-session';
import { LyricsLookup, matchLyrics } from '../extension/src/lyrics-provider';
import { normalizeSongTitle, type SongPlayback } from '../extension/src/shared/lyrics';

type NodeFixture = { textContent?: string; attrs?: Record<string, string>; children?: Record<string, unknown> };
function node({ textContent = '', attrs = {}, children = {} }: NodeFixture) {
  return { textContent, getAttribute: (attr: string) => attrs[attr] ?? null, hasAttribute: (attr: string) => attr in attrs,
    querySelector: (selector: string) => children[selector] ?? null };
}
function documentWith(children: Record<string, unknown> = {}): Document {
  return { ...node({ children }), title: 'Landing page', querySelectorAll: () => [] } as unknown as Document;
}
const media = { tagName: 'AUDIO', duration: 240, currentTime: 80, playbackRate: 1, paused: false } as HTMLMediaElement;

it('extracts Spotify title, artist and progress from the now-playing widget and follows track changes', () => {
  const session = new LyricsSession();
  session.setSource('capture');
  for (const [id, title, position] of [['abc', 'Track A (Official Audio)', '0:20'], ['def', 'Track B (Live)', '0:02']]) {
    const doc = documentWith({
      '[data-testid="now-playing-widget"], .now-playing': node({ children: {
        '[data-testid="context-item-link"], a[href*="/track/"]': node({ textContent: title, attrs: { href: `/track/${id}` } }),
        'a[href*="/artist/"]': node({ textContent: 'Artist' }),
      } }),
      '[data-testid="playback-position"]': node({ textContent: position }),
      '[data-testid="playback-duration"]': node({ textContent: '4:00' }),
      '[data-testid="control-button-playpause"]': node({ attrs: { 'aria-label': 'Pause' } }),
    });
    const result = readSongPlayback(doc, new URL('https://open.spotify.com/playlist/list'));
    expect(result).toMatchObject({ source: 'spotify', trackId: `open.spotify.com:/track/${id}`, paused: false,
      position: Number(position.slice(-2)), song: { title: normalizeSongTitle(title), artist: 'Artist', duration: 240 } });
    const before = session.invalidateLookup();
    expect(session.receive('capture', result)).toBe('changed');
    expect(session.acceptsLookup(before)).toBe(false);
  }
});

it('uses YouTube Music current-player metadata instead of the route title', () => {
  const doc = documentWith({ 'ytmusic-player-bar': node({ children: {
    '.title': node({ textContent: 'Current Track [Lyrics]' }),
    '.byline': node({ textContent: 'Artist • Album • 2020' }),
    '.time-info': node({ textContent: '0:15 / 3:12' }),
  }, attrs: { playing: '' } }) });
  expect(readSongPlayback(doc, new URL('https://music.youtube.com/playlist?list=abc'))).toMatchObject({
    source: 'youtube-music', position: 15, paused: false, song: { title: 'Current Track', artist: 'Artist', duration: 192 },
  });
});

it('uses SoundCloud player metadata and limits generic metadata to plausible music', () => {
  const doc = documentWith({
    '.playbackSoundBadge__titleLink': node({ textContent: 'Other Track (Remix)', attrs: { href: '/artist/track' } }),
    '.playbackSoundBadge__lightLink': node({ textContent: 'Other Artist' }),
  });
  expect(readSongPlayback(doc, new URL('https://soundcloud.com/discover'), media)).toMatchObject({
    source: 'soundcloud', song: { title: 'Other Track (Remix)', artist: 'Other Artist', duration: 240 }, position: 80,
  });
  const generic = new URL('https://example.com/player');
  const metadata = { title: 'Track (Cover) | SoundCloud', artist: 'Artist', album: 'Acoustic Sessions' };
  expect(readSongPlayback(documentWith(), generic, media, metadata)).toMatchObject({
    source: 'browser', song: { title: 'Track (Cover)', artist: 'Artist', album: 'Acoustic Sessions' },
  });
  expect(readSongPlayback(documentWith(), generic, { ...media, tagName: 'VIDEO' } as HTMLMediaElement, metadata)?.song.title).toBe('');
});

it('prefers lyrics over page captions and drops timed captions after their cue ends', () => {
  const cues = [{ startTime: 4, endTime: 7, text: '<v singer>First' }, { startTime: 12, endTime: 13, text: 'Second' }];
  const result = nearbyCaptions(cues as unknown as TextTrackCueList, 9);
  expect(currentCaptions(result, 5)).toBe('First');
  expect(currentCaptions(result, 7)).toBe('');
  expect(currentCaptions(result, 12)).toBe('Second');
  expect(nearbyCaptions(null, 0)).toEqual([]);
  const showing = { kind: 'subtitles', mode: 'showing' };
  expect(captionTrack([{ kind: 'chapters', mode: 'showing' }, { kind: 'captions', mode: 'disabled' }, showing] as TextTrack[])).toBe(showing);
  expect(canUseCaptions({ kind: 'missing' })).toBe(true);
  expect(canUseCaptions({ kind: 'plain', text: 'Line' })).toBe(false);
  expect(canUseCaptions({ kind: 'synced', lines: [] })).toBe(false);
});

it('requires the same recording version and prefers timed lyrics before a captions fallback', () => {
  const query = { title: 'Track (Remix) – Lyrics', artist: 'Artist', duration: 120 };
  const record = { trackName: 'Track (Remix) [Official Audio]', artistName: 'Artist', duration: 120, plainLyrics: 'A line' };
  expect(matchLyrics([{ ...record, trackName: 'Track (Live)' }], query)).toEqual({ kind: 'missing' });
  expect(matchLyrics([record], query)).toEqual({ kind: 'plain', text: 'A line' });
  expect(matchLyrics([record, { ...record, syncedLyrics: '[00:06] A line' }], query)).toMatchObject({ kind: 'synced' });
});

it('aborts a stale network lookup and accepts the next song', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })))
    .mockResolvedValueOnce(Response.json([]));
  const lookup = new LyricsLookup(fetcher, 'MoodShift/tests');
  const controller = new AbortController();
  const first = lookup.search({ title: 'Old Track', artist: 'Artist', duration: 240 }, false, controller.signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  controller.abort();
  const second = lookup.search({ title: 'New Track', artist: 'Artist', duration: 240 });
  await expect(first).resolves.toEqual({ kind: 'error' });
  await expect(second).resolves.toEqual({ kind: 'missing' });
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
});

it('combines real processing delay and device latencies only while playing', () => {
  expect(playoutDelay(true, 2.9, 0.01, 0.04)).toBeCloseTo(2.95);
  expect(playoutDelay(true, 0.1, 0.01)).toBeCloseTo(0.11);
  expect(playoutDelay(true, 0, 0.01, 0.04)).toBeCloseTo(0.05);
  expect(playoutDelay(false, 2.9, 0.01, 0.04)).toBe(0);
});

it('uses historical positions as buffers change and drains on pause without interpolating across a seek', () => {
  const clock = new PlaybackTimeline();
  const track: SongPlayback = { trackId: 'a', source: 'spotify', song: { title: 'A', artist: 'Artist', duration: 240 },
    position: 76, rate: 1, paused: false };
  for (let second = 0; second <= 4; second++) clock.sample({ ...track, position: 76 + second }, second * 1000);
  const paused = { ...track, position: 80, paused: true };
  clock.sample(paused, 4250);
  expect(clock.position(paused, 4000, 4)).toBe(76);
  expect(clock.position(paused, 5250, 4)).toBe(77.25);
  expect(clock.position(paused, 5250, 2)).toBe(79.25);
  expect(clock.position(paused, 8500, 4)).toBe(80);
  const seek = { ...paused, position: 126, rate: 2, paused: false };
  clock.sample(seek, 9000);
  expect(clock.position(seek, 10000, 2)).toBe(80);
  expect(clock.position(seek, 11000, 2)).toBe(126);
  expect(clock.position(seek, 11250, 2)).toBe(126.5);
  const next = { ...track, trackId: 'b', position: 0 };
  clock.sample(next, 12000);
  expect(clock.position(next, 13000, 2)).toBe(-1);
  expect(clock.position(next, 14000, 2)).toBe(0);
});

it('advances live and stem lyrics by the same calibration and migrates older corrections once', () => {
  const playback: SongPlayback = { trackId: 'track', source: 'spotify', song: { title: 'A', artist: 'Artist', duration: 240 },
    position: 80, rate: 1, paused: true };
  const correction = restoreLyricsCorrection(undefined, -1.2);
  expect(correction).toBe(0);
  expect(calibratedLyricsPosition(playback, 80, correction)).toBeCloseTo(81.2);
  expect(calibratedLyricsPosition(playback, 76, correction)).toBeCloseTo(77.2);
  expect(calibratedLyricsPosition(playback, -1, correction)).toBe(-1);
  expect(restoreLyricsCorrection(undefined, 0)).toBe(0);
  expect(restoreLyricsCorrection(undefined, -0.7)).toBe(0.5);
  expect(restoreLyricsCorrection(0, -0.7)).toBe(0);
  expect(calibratedLyricsPosition({ ...playback, rate: 2 }, 76, 0.5)).toBeCloseTo(77.4);
});
