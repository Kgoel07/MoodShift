import { describe, expect, it, vi } from 'vitest';
import { LyricsSession } from '../extension/src/lyrics-session';
import { LyricsLookup, matchLyrics } from '../extension/src/lyrics-provider';
import { activeLyric, identifySong, parseLrc, youtubeVideoId, type YouTubePlayback } from '../extension/src/shared/lyrics';

const song = { title: 'Morning Signal', artist: 'Sample Artist', duration: 120 };
const playback: YouTubePlayback = { videoId: 'aaaaaaaaaaa', song, paused: false, position: 0, rate: 1 };
const record = {
  trackName: song.title, artistName: song.artist, duration: 120, instrumental: false,
  plainLyrics: 'First line\nSecond line',
  syncedLyrics: '[00:05.00] First line\n[00:10.00] Second line',
};

describe('YouTube metadata', () => {
  it.each([
    ['Sample Artist - Morning Signal (Official Audio)', 'Sample Artist'],
    ['Morning Signal - Sample Artist', 'Sample Artist - Topic'],
    ['Morning Signal (Official Music Video)', 'Sample ArtistVEVO'],
    ['Sample Artist ~ Morning Signal [Official Video] - YouTube', 'Sample Artist'],
  ])('identifies %s from the title and channel', (title, channel) => {
    expect(identifySong(title, channel)).toEqual({ title: song.title, artist: song.artist });
  });

  it('uses matching media-session metadata and ignores a stale artist', () => {
    expect(identifySong('Morning Signal (Official Music Video)', 'A label',
      { title: 'Morning Signal', artist: song.artist + ' - Topic' })).toEqual({ title: song.title, artist: song.artist });
    expect(identifySong('Morning Signal - Sample Artist', 'A label',
      { title: 'Morning Signal - Sample Artist', artist: song.artist })).toEqual({ title: song.title, artist: song.artist });
    expect(identifySong('Sample Artist - Morning Signal', song.artist,
      { title: 'A previous song', artist: 'A different artist' })).toEqual({ title: song.title, artist: song.artist });
  });

  it('watches top-level YouTube watch URLs with valid IDs', () => {
    expect(youtubeVideoId(new URL('https://www.youtube.com/watch?v=aaaaaaaaaaa&t=14'))).toBe('aaaaaaaaaaa');
    expect(youtubeVideoId(new URL('https://example.com/watch?v=aaaaaaaaaaa'))).toBeUndefined();
    expect(youtubeVideoId(new URL('https://www.youtube.com/results?v=aaaaaaaaaaa'))).toBeUndefined();
  });
});

describe('lyrics clock and playback session', () => {
  it('parses unsorted timestamps, duplicates, fractional seconds, LRC offset and blank breaks', () => {
    expect(parseLrc('\ufeff[ar:Sample]\r\n[00:07.5][00:05.325] First\r\n[00:05.325] Harmony\n[00:09]\n[offset:+1000]'))
      .toEqual([{ time: 4.325, text: 'First\nHarmony' }, { time: 6.5, text: 'First' }, { time: 8, text: '' }]);
    expect(parseLrc('[00:01] <00:01.50>first <00:02.0>second')).toEqual([{ time: 1, text: 'first second' }]);
    expect(parseLrc('[00:01]\nUntimed')).toEqual([]);
  });

  it('handles seeking, paused media position, playback rate, and a signed offset', () => {
    const lines = parseLrc(record.syncedLyrics);
    expect(activeLyric(lines, { ...playback, position: 4 }, 0)).toBe(-1);
    expect(activeLyric(lines, { ...playback, position: 11 }, 0)).toBe(1);
    expect(activeLyric(lines, { ...playback, position: 5, paused: true }, 0)).toBe(0);
    expect(activeLyric(lines, { ...playback, position: 11, rate: 2 }, 1)).toBe(0);
    expect(activeLyric(lines, { ...playback, position: 4 }, -1)).toBe(0);
  });

  it('invalidates late lyric responses after a metadata change, manual retry, navigation or source switch', () => {
    const session = new LyricsSession();
    session.setSource('capture-1');
    expect(session.receive('capture-1', playback)).toBe('changed');
    const original = session.invalidateLookup();
    expect(session.receive('capture-1', { ...playback, position: 10, paused: true, rate: 2 })).toBe('playback');
    expect(session.acceptsLookup(original)).toBe(true);
    expect(session.receive('capture-1', { ...playback, song: { ...song, artist: 'Corrected Artist' } })).toBe('changed');
    expect(session.acceptsLookup(original)).toBe(false);
    const corrected = session.invalidateLookup();
    const retry = session.invalidateLookup();
    expect(session.acceptsLookup(corrected)).toBe(false);
    expect(session.acceptsLookup(retry)).toBe(true);
    expect(session.receive('capture-1', { ...playback, videoId: 'bbbbbbbbbbb' })).toBe('changed');
    expect(session.acceptsLookup(retry)).toBe(false);
    const nextVideo = session.invalidateLookup();
    expect(session.receive('capture-1', {
      ...playback, videoId: 'bbbbbbbbbbb', song: { ...song, duration: 0 }, ad: true, paused: true,
    })).toBe('changed');
    expect(session.acceptsLookup(nextVideo)).toBe(false);
    session.setSource('capture-2');
    expect(session.receive('capture-1', playback)).toBe('ignored');
    expect(session.playback).toBeNull();
    expect(session.acceptsLookup(nextVideo)).toBe(false);
  });
});

describe('LRCLIB matching', () => {
  it('prefers synchronized lyrics from a verified recording', () => {
    expect(matchLyrics([
      { ...record, duration: 148 },
      { ...record, duration: 119.8, syncedLyrics: null },
      { ...record, duration: 120.5 },
      { ...record, artistName: 'An unrelated artist' },
    ], song)).toEqual({ kind: 'synced', lines: parseLrc(record.syncedLyrics) });
  });

  it('shows plain lyrics if timing is absent or invalid', () => {
    expect(matchLyrics([{ ...record, syncedLyrics: 'invalid' }], song)).toEqual({
      kind: 'plain', text: record.plainLyrics,
    });
  });

  it('rejects wrong recordings and separates missing and instrumental results', () => {
    expect(matchLyrics([{ ...record, duration: 129 }, { ...record, trackName: 'Morning Signal (Live)' }, null], song))
      .toEqual({ kind: 'missing' });
    expect(matchLyrics([{ ...record, instrumental: true, plainLyrics: null, syncedLyrics: null }], song))
      .toEqual({ kind: 'instrumental' });
    expect(matchLyrics(null, song)).toEqual({ kind: 'error' });
  });

  it('flags equally plausible recordings with conflicting lyrics or timing', () => {
    expect(matchLyrics([record, { ...record, syncedLyrics: '[00:05] Unrelated words' }], song)).toEqual({ kind: 'ambiguous' });
    expect(matchLyrics([record, { ...record, syncedLyrics: '[00:10] First line\n[00:15] Second line' }], song))
      .toEqual({ kind: 'ambiguous' });
  });

  it('prefers a distinctly closer duration when releases have different timings', () => {
    expect(matchLyrics([record, { ...record, duration: 120.45, syncedLyrics: '[00:12] Different words' }], song))
      .toEqual({ kind: 'synced', lines: parseLrc(record.syncedLyrics) });
  });

  it('prefers the player album and prioritizes the original recording within a close duration match', () => {
    const original = { ...record, albumName: 'Original Recording', duration: 120.2 };
    const deluxe = { ...record, albumName: 'Anniversary Deluxe', syncedLyrics: '[00:05] Deluxe opening' };
    expect(matchLyrics([deluxe, original], song)).toEqual({ kind: 'synced', lines: parseLrc(original.syncedLyrics) });
    expect(matchLyrics([deluxe, original], { ...song, album: deluxe.albumName }))
      .toEqual({ kind: 'synced', lines: parseLrc(deluxe.syncedLyrics) });
  });
});

describe('LRCLIB requests', () => {
  it('identifies the client, deduplicates concurrent searches, and reuses a recent match', async () => {
    const http = vi.fn<typeof fetch>(async () => Response.json([record]));
    const lookup = new LyricsLookup(http, 'MoodShift/test (https://github.com/Kgoel07/MoodShift)');
    const first = lookup.search(song);
    expect(lookup.search(song)).toBe(first);
    await expect(first).resolves.toMatchObject({ kind: 'synced' });
    await expect(lookup.search(song)).resolves.toMatchObject({ kind: 'synced' });
    expect(http).toHaveBeenCalledTimes(1);
    const [url, options] = http.mock.calls[0];
    expect(String(url)).toBe('https://lrclib.net/api/search?track_name=Morning+Signal&artist_name=Sample+Artist');
    expect(options?.headers).toMatchObject({ 'X-User-Agent': expect.stringContaining('MoodShift/test') });
  });

  it('honors Retry-After before any retry or new query', async () => {
    const http = vi.fn<typeof fetch>(async () => new Response('Rate limit', { status: 429, headers: { 'Retry-After': '4' } }));
    const lookup = new LyricsLookup(http, 'MoodShift/test');
    const start = Date.now();
    const result = await lookup.search(song);
    expect(result.kind).toBe('limited');
    if (result.kind === 'limited') expect(result.retryAt).toBeGreaterThanOrEqual(start + 4000);
    expect(await lookup.search({ ...song, title: 'Another song' }, true)).toEqual(result);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each([
    [async () => new Response(null, { status: 404 }), 'missing'],
    [async () => new Response('Not JSON'), 'error'],
    [async () => { throw new Error('No connection'); }, 'error'],
  ])('handles missing lyrics and network or response errors', async (http, kind) => {
    await expect(new LyricsLookup(http, 'MoodShift/test').search(song)).resolves.toEqual({ kind });
  });

  it('does not call the API if the song title, artist, or duration is unusable', async () => {
    const http = vi.fn<typeof fetch>();
    const lookup = new LyricsLookup(http, 'MoodShift/test');
    for (const invalid of [{ ...song, title: ' ' }, { ...song, artist: '' }, { ...song, duration: Infinity }]) {
      await expect(lookup.search(invalid)).resolves.toEqual({ kind: 'invalid' });
    }
    expect(http).not.toHaveBeenCalled();
  });
});
