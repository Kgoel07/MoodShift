import { synchronizedPosition, type YouTubePlayback } from './lyrics';

export interface ChordEvent {
  startTime: number;
  endTime: number;
  chord: string;
  source: 'songle' | 'manual' | 'ai' | 'live';
}

export const liveChordPort = 'moodshift-live-chords:';
export type LiveChordSample = { chord: string | null; capturedAt: number; outputDelay: number };

export class LiveChordTimeline {
  events: ChordEvent[] = [];
  private previous?: string | null;

  clear(): void {
    this.previous = undefined;
    this.events = [];
  }

  update({ chord, capturedAt }: LiveChordSample): void {
    if (this.previous === chord) return;
    this.previous = chord;
    const recent = this.events.slice(-23);
    const last = recent.at(-1);
    if (last?.endTime === Infinity) recent[recent.length - 1] = { ...last, endTime: capturedAt };
    if (chord) recent.push({ startTime: capturedAt, endTime: Infinity, chord, source: 'live' });
    this.events = recent;
  }
}

export type ChordResult =
  | { kind: 'found'; events: ChordEvent[] }
  | { kind: 'missing' | 'empty' | 'unavailable' | 'invalid' };

export const validChordVideo = (id: unknown): id is string =>
  typeof id === 'string' && /^[\w-]{11}$/.test(id);

export function normalizeSongle(body: unknown): ChordResult {
  const rows = (body as { chords?: unknown } | null)?.chords;
  if (!Array.isArray(rows) || rows.length > 5000) return { kind: 'invalid' };
  const events: ChordEvent[] = [];
  let previous = -1;
  for (const row of rows) {
    const { start, duration, name } = row ?? {};
    if (!Number.isSafeInteger(start) || start < 0 || start <= previous
      || !Number.isSafeInteger(duration) || duration <= 0 || !Number.isSafeInteger(start + duration)
      || typeof name !== 'string' || !/^(?:N|[A-G][#b♯♭]?[\w#b♯♭/()+°ø-]{0,23})$/.test(name)) {
      return { kind: 'invalid' };
    }
    previous = start;
    // Songle's rounded timestamps can overlap by a millisecond.
    const prev = events.at(-1);
    if (prev) prev.endTime = Math.min(prev.endTime, start / 1000);
    if (name !== 'N') {
      events.push({ startTime: start / 1000, endTime: (start + duration) / 1000, chord: name, source: 'songle' });
    }
  }
  return events.length ? { kind: 'found', events } : { kind: 'empty' };
}

export function chordPosition(events: readonly ChordEvent[], playback: YouTubePlayback, offset: number) {
  if (playback.ad) return { current: -1, next: -1 };
  return chordPositionAt(events, synchronizedPosition(playback, offset));
}

export function chordPositionAt(events: readonly ChordEvent[], time: number) {
  let start = 0;
  let end = events.length;
  while (start < end) {
    const mid = (start + end) >>> 1;
    if (events[mid].startTime <= time) start = mid + 1;
    else end = mid;
  }
  return {
    current: start > 0 && time < events[start - 1].endTime ? start - 1 : -1,
    next: start < events.length ? start : -1,
  };
}

const notes = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const naturalNotes: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const intervals: Record<string, number[]> = {
  '': [0, 4, 7], maj: [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
  mM7: [0, 3, 7, 11], sus2: [0, 2, 7], sus4: [0, 5, 7],
};

function pitch(name: string): number {
  return (naturalNotes[name[0]] + (name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0) + 12) % 12;
}

export function pianoNotes(chord: string): string[] | undefined {
  const match = /^([A-G][#b]?)([\w]*)(?:\/([A-G][#b]?))?$/.exec(chord.replaceAll('♯', '#').replaceAll('♭', 'b'));
  if (!match || !Object.hasOwn(intervals, match[2])) return;
  const root = pitch(match[1]);
  const pitches = intervals[match[2]].map(interval => (root + interval) % 12);
  const bass = match[3] && pitch(match[3]);
  if (typeof bass === 'number') return [bass, ...pitches.filter(note => note !== bass)].map(note => notes[note]);
  return pitches.map(note => notes[note]);
}

// Standard EADGBE tuning, from lowest to highest string. -1 means muted.
const fingerings: Record<string, number[]> = {
  C: [-1, 3, 2, 0, 1, 0], D: [-1, -1, 0, 2, 3, 2], E: [0, 2, 2, 1, 0, 0],
  F: [1, 3, 3, 2, 1, 1], G: [3, 2, 0, 0, 0, 3], A: [-1, 0, 2, 2, 2, 0],
  B: [-1, 2, 4, 4, 4, 2], Am: [-1, 0, 2, 2, 1, 0], Em: [0, 2, 2, 0, 0, 0],
  Dm: [-1, -1, 0, 2, 3, 1], Bm: [-1, 2, 4, 4, 3, 2], 'F#m': [2, 4, 4, 2, 2, 2],
  Bb: [-1, 1, 3, 3, 3, 1], Eb: [-1, -1, 1, 3, 4, 3], Gm: [3, 5, 5, 3, 3, 3],
  G7: [3, 2, 0, 0, 0, 1], E7: [0, 2, 0, 1, 0, 0], A7: [-1, 0, 2, 0, 2, 0],
  Am7: [-1, 0, 2, 0, 1, 0], Cmaj7: [-1, 3, 2, 0, 0, 0], Dsus4: [-1, -1, 0, 2, 3, 3],
};
const guitarAliases: Record<string, string> = { 'A#': 'Bb', 'D#': 'Eb', Gbm: 'F#m', CM7: 'Cmaj7' };

export function guitarFrets(chord: string): readonly number[] | undefined {
  const name = chord.replaceAll('♯', '#').replaceAll('♭', 'b');
  const key = Object.hasOwn(guitarAliases, name) ? guitarAliases[name] : name;
  return Object.hasOwn(fingerings, key) ? fingerings[key] : undefined;
}
