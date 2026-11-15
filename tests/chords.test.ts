import { describe, expect, it, vi } from 'vitest';
import { ChordSession, fetchSongle } from '../extension/src/chords-provider';
import { chordPosition, guitarFrets, normalizeSongle, pianoNotes, type ChordResult } from '../extension/src/shared/chords';
import type { YouTubePlayback } from '../extension/src/shared/lyrics';

const sample = {
  chords: [
    { start: 0, duration: 12139, name: 'N' },
    { start: 12139, duration: 3201, name: 'Eb' },
    { start: 15339, duration: 3200, name: 'Eb/Ab' },
  ],
};
const found = normalizeSongle(sample);
if (found.kind !== 'found') throw new Error('Invalid test fixture.');
const playback = (position: number, rate = 1): YouTubePlayback => ({
  videoId: 'PqJNc9KVIZE', song: { title: 'Example', artist: 'Artist', duration: 272 }, position, rate, paused: true,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Songle chord timeline', () => {
  it('normalizes milliseconds, no-chord spans, overlapping rounding and provider attribution', () => {
    expect(found.events).toEqual([
      { startTime: 12.139, endTime: 15.339, chord: 'Eb', source: 'songle' },
      { startTime: 15.339, endTime: 18.539, chord: 'Eb/Ab', source: 'songle' },
    ]);
    expect(normalizeSongle({ chords: [sample.chords[0]] })).toEqual({ kind: 'empty' });
  });

  it.each([{}, { chords: [{ start: 100, duration: NaN, name: 'C' }] },
    { chords: [{ start: 0, duration: 500, name: '<img>' }] },
    { chords: [sample.chords[2], sample.chords[1]] }])('rejects malformed progression %j', body => {
    expect(normalizeSongle(body)).toEqual({ kind: 'invalid' });
  });

  it('updates immediately on seeks and respects pause, rate, offset, boundaries, ads, and gaps', () => {
    const current = (time: number, rate = 1, offset = 0) => chordPosition(found.events, playback(time, rate), offset);
    expect(current(12)).toEqual({ current: -1, next: 0 });
    expect(current(12.139)).toEqual({ current: 0, next: 1 });
    expect(current(16)).toEqual({ current: 1, next: -1 });
    expect(current(16, 2, 0.5)).toEqual({ current: 0, next: 1 });
    expect(current(12, 1, -0.2)).toEqual({ current: 0, next: 1 });
    expect(current(18.539)).toEqual({ current: -1, next: -1 });
    expect(chordPosition(found.events, { ...playback(13), ad: true }, 0)).toEqual({ current: -1, next: -1 });
  });

  it('queries the matching YouTube ID and handles missing, outage, and unreadable responses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(sample))
      .mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response('broken'));
    const id = playback(0).videoId;
    expect(await fetchSongle(id, fetcher)).toEqual(found);
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('url')).toBe(`www.youtube.com/watch?v=${id}`);
    expect(await fetchSongle(id, fetcher)).toEqual({ kind: 'missing' });
    expect(await fetchSongle(id, fetcher)).toEqual({ kind: 'unavailable' });
    expect(await fetchSongle(id, fetcher)).toEqual({ kind: 'invalid' });
  });

  it('waits through ads and ignores stale replies when switching or leaving a video', async () => {
    const first = deferred<ChordResult>();
    const second = deferred<ChordResult>();
    const provider = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const session = new ChordSession(provider, vi.fn());
    session.setPlayback({ ...playback(0), ad: true });
    expect(provider).not.toHaveBeenCalled();
    session.setPlayback(playback(1));
    session.setPlayback(playback(2));
    session.setPlayback({ ...playback(0), videoId: 'AEBld6I_AKs' });
    expect(provider).toHaveBeenCalledTimes(2);
    second.resolve({ kind: 'missing' });
    await second.promise;
    first.resolve(found);
    await first.promise;
    expect(session.result).toEqual({ kind: 'missing' });
    session.setPlayback(null);
    expect(session.result).toBeUndefined();
  });

  it('builds deterministic diagrams for common chords and recognizes unsupported voicings', () => {
    expect(pianoNotes('C')).toEqual(['C', 'E', 'G']);
    expect(pianoNotes('Am')).toEqual(['A', 'C', 'E']);
    expect(pianoNotes('B♭sus4')).toEqual(['A♯', 'D♯', 'F']);
    expect(pianoNotes('AbM7')).toEqual(['G♯', 'C', 'D♯', 'G']);
    expect(pianoNotes('Eb/Ab')?.[0]).toBe('G♯');
    expect(pianoNotes('Am13')).toBeUndefined();
    expect(guitarFrets('A#')).toEqual(guitarFrets('Bb'));
    expect(guitarFrets('C')).toEqual([-1, 3, 2, 0, 1, 0]);
    expect(guitarFrets('Eb/Ab')).toBeUndefined();
  });
});
