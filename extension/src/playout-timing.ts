import { playbackKey, synchronizedPosition, type PlayerPlayback } from './shared/lyrics';
import type { AudioTiming, MonitorMode, StemStatus } from './shared/types';

const positive = (value?: number) => value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;

export const lyricsTimingCalibration = -1.2;

export function clampLyricsCorrection(value: number): number {
  return Math.max(-10, Math.min(10, Number.isFinite(value) ? value : 0));
}

export function restoreLyricsCorrection(saved: unknown, previous: unknown): number {
  if (typeof saved === 'number' && Number.isFinite(saved)) return clampLyricsCorrection(saved);
  if (typeof previous !== 'number' || !Number.isFinite(previous) || previous === 0) return 0;
  // Older nonzero values already included the device's timing adjustment.
  return clampLyricsCorrection(Math.round((previous - lyricsTimingCalibration) * 10) / 10);
}

export function calibratedLyricsPosition(playback: PlayerPlayback, position: number, correction: number): number {
  if (position < 0) return position;
  return synchronizedPosition({ ...playback, position }, lyricsTimingCalibration + correction);
}

export function audioTiming(monitor: MonitorMode, phase: StemStatus['phase'], running: boolean,
  contextLatency: number, deviceLatency?: number, playedStemSeconds?: number): AudioTiming {
  if (!running) return { seconds: 0, stemSeconds: 0 };
  const stemSeconds = monitor === 'modified' && phase === 'active' ? positive(playedStemSeconds) : 0;
  return { seconds: stemSeconds + positive(contextLatency) + positive(deviceLatency), stemSeconds };
}

type Sample = Pick<PlayerPlayback, 'position' | 'rate' | 'paused'> & { time: number };

export class PlaybackTimeline {
  private key?: string;
  private samples: Sample[] = [];
  private changedTrack = false;

  reset(): void {
    this.key = undefined;
    this.samples = [];
    this.changedTrack = false;
  }

  sample(playback: PlayerPlayback, now: number): void {
    const key = playbackKey(playback);
    if (key !== this.key) {
      this.changedTrack = this.key !== undefined;
      this.key = key;
      this.samples = [];
    }
    const time = playback.sampledAt ?? now;
    if (time <= (this.samples.at(-1)?.time ?? -Infinity)) return;
    this.samples.push({ time, position: playback.position, rate: playback.rate, paused: playback.paused });
    if (this.samples.length > 180) this.samples.shift();
  }

  position(playback: PlayerPlayback, now: number, delaySeconds: number): number {
    const target = now - delaySeconds * 1000;
    const first = this.samples[0];
    if (!first || target < first.time) {
      if (first && this.changedTrack) return -1;
      if (playback.paused) return playback.position;
      return playback.position - (delaySeconds - ((now - (playback.sampledAt ?? now)) / 1000)) * playback.rate;
    }
    let index = this.samples.length - 1;
    while (this.samples[index].time > target) index--;
    const point = this.samples[index];
    if (point.paused) return point.position;
    const next = this.samples[index + 1];
    if (next && next.position === point.position) return point.position;
    // Use the last known clock before playout. Never interpolate across a seek or rate change.
    const elapsed = Math.min((target - point.time) / 1000, 0.65);
    return Math.min(playback.song.duration || Infinity, point.position + elapsed * point.rate);
  }
}
