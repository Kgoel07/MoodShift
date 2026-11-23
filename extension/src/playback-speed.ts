import type { ReverbSpeed } from './shared/reverb';

/** A short renewable lease prevents an extension reload/crash leaving a changed rate. */
export class PlaybackSpeedLease {
  private owned?: { owner: string; player: HTMLMediaElement; original: number; applied: number };
  private blocked?: string;
  private timer?: ReturnType<typeof setTimeout>;
  set(owner: string, enabled: boolean, player?: HTMLMediaElement): ReverbSpeed {
    if (!enabled) { this.release(owner); if (this.blocked === owner) this.blocked = undefined; return { state: 'idle' }; }
    if (this.blocked === owner) return { state: 'unavailable', message: 'Playback speed changed in the player. Reverb remains active.' };
    if (this.owned && (this.owned.owner !== owner || this.owned.player !== player)) this.release();
    if (!player || !Number.isFinite(player.duration) || player.duration <= 0) {
      this.release(); return { state: 'unavailable', message: 'Reverb active. Slowing is unavailable for this playback.' };
    }
    if (this.owned && Math.abs(player.playbackRate - this.owned.applied) > 0.001) {
      this.blocked = owner; this.release();
      return { state: 'unavailable', message: 'Playback speed changed in the player. Reverb remains active.' };
    }
    if (!this.owned) {
      const original = player.playbackRate;
      if (!Number.isFinite(original) || original < 0.5 || original > 2) return { state: 'unavailable', message: 'Reverb active. Use a player speed between 0.5× and 2× to enable slowing.' };
      this.owned = { owner, player, original, applied: original * 0.85 };
      try {
        player.playbackRate = this.owned.applied;
        if (Math.abs(player.playbackRate - this.owned.applied) > 0.001) throw new Error('Player rejected rate.');
      }
      catch { this.release(); return { state: 'unavailable', message: 'Reverb active. The player refused speed control.' }; }
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.release(), 7000);
    return { state: 'active', rate: player.playbackRate };
  }
  release(owner?: string): void {
    if (owner && this.owned?.owner !== owner) return;
    clearTimeout(this.timer);
    const owned = this.owned; this.owned = undefined;
    if (owned && Math.abs(owned.player.playbackRate - owned.applied) < 0.001) {
      try { owned.player.playbackRate = owned.original; } catch { /* The document may already be gone. */ }
    }
  }
}
