import { playbackKey, type PlayerPlayback } from './shared/lyrics';

export class LyricsSession {
  private source?: string;
  private revision = 0;
  playback: PlayerPlayback | null = null;

  setSource(source?: string): void {
    this.source = source;
    this.playback = null;
    this.revision++;
  }

  receive(source: string, snapshot: PlayerPlayback | null): 'ignored' | 'changed' | 'playback' {
    if (source !== this.source) return 'ignored';
    const previous = this.playback;
    const changed = playbackKey(previous) !== playbackKey(snapshot) || previous?.song.title !== snapshot?.song.title
      || previous?.song.artist !== snapshot?.song.artist || previous?.song.album !== snapshot?.song.album || previous?.ad !== snapshot?.ad
      || Math.round((previous?.song.duration ?? 0) * 10) !== Math.round((snapshot?.song.duration ?? 0) * 10);
    this.playback = snapshot;
    if (changed) this.revision++;
    return changed ? 'changed' : 'playback';
  }

  invalidateLookup(): number {
    return ++this.revision;
  }

  acceptsLookup(revision: number): boolean {
    return this.playback !== null && this.revision === revision;
  }
}
