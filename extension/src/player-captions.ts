import type { CaptionCue, LyricsResult } from './shared/lyrics';

export function captionTrack(tracks: ArrayLike<TextTrack>): TextTrack | undefined {
  const readable = Array.from(tracks).filter(track => track.kind === 'captions' || track.kind === 'subtitles');
  return readable.find(track => track.mode === 'showing') ?? readable.find(track => track.mode === 'hidden') ?? readable[0];
}

export function nearbyCaptions(cues: TextTrackCueList | null, position: number): CaptionCue[] {
  if (!cues) return [];
  // TextTrackCueList is ordered by start time. Read only the nearby playout window.
  const from = Math.max(0, position - 40);
  let first = 0;
  let last = cues.length;
  while (first < last) {
    const mid = (first + last) >>> 1;
    if (cues[mid].startTime < from) first = mid + 1;
    else last = mid;
  }
  const result: CaptionCue[] = [];
  for (let index = Math.max(0, first - 1); index < cues.length && index < first + 80; index++) {
    const cue = cues[index] as VTTCue;
    if (cue.startTime > position + 6) break;
    if (!Number.isFinite(cue.startTime) || !Number.isFinite(cue.endTime) || cue.endTime <= Math.max(from, cue.startTime)
      || typeof cue.text !== 'string') continue;
    const text = cue.text.slice(0, 1000).replace(/<[^>]*>/g, '').trim();
    if (text) result.push({ time: cue.startTime, end: cue.endTime, text });
  }
  return result;
}

export function currentCaptions(cues: readonly CaptionCue[], position: number): string {
  return cues.filter(cue => cue.time <= position && position < cue.end).map(cue => cue.text).join('\n');
}

export function canUseCaptions(result: LyricsResult): boolean {
  return result.kind !== 'synced' && result.kind !== 'plain';
}
