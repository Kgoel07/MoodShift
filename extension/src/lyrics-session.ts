import type { YouTubePlayback } from './shared/lyrics';

export class LyricsSession {
  private source?: string;
  private revision = 0;
  playback: YouTubePlayback | null = null;

  setSource(source?: string): void {
    this.source = source;
    this.playback = null;
    this.revision++;
  }

  receive(source: string, snapshot: YouTubePlayback | null): 'ignored' | 'changed' | 'playback' {
    if (source !== this.source) return 'ignored';
    const previous = this.playback;
    const changed = previous?.videoId !== snapshot?.videoId || previous?.song.title !== snapshot?.song.title
      || previous?.song.artist !== snapshot?.song.artist || previous?.ad !== snapshot?.ad
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
