import { playbackKey, synchronizedPosition, type PlayerPlayback } from './shared/lyrics';
import { lyricsTimingCalibration } from './shared/display-settings';

const positive = (value?: number) => value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;

export function calibratedLyricsPosition(playback: PlayerPlayback, position: number, correction: number): number {
  if (position < 0) return position;
  return synchronizedPosition({ ...playback, position }, lyricsTimingCalibration + correction);
}

export function playoutDelay(running: boolean, processingSeconds: number, contextLatency: number, deviceLatency?: number): number {
  return running ? positive(processingSeconds) + positive(contextLatency) + positive(deviceLatency) : 0;
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
