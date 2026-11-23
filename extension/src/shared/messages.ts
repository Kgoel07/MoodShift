import type { AudioFeatures, CaptureSession, CaptureStatus, MonitorMode, StemMode } from './types';
import type { EffectPatch } from './effects';
import type { ReverbPatch, ReverbSettings } from './reverb';
import type { SourcePlatform } from './track';
import type { TuningEdit, TuningSettings } from './tuning';

type EffectChange = { type: 'APPLY_EFFECTS'; sessionId: string; patch: EffectPatch; baseRevision?: number; reverb?: ReverbSettings; tuning?: TuningSettings };
type TuningChange = { type: 'SET_TUNING'; sessionId?: string; edit: TuningEdit };
type ReverbChange = { type: 'SET_REVERB'; sessionId: string; patch: ReverbPatch };
type MonitorChange = { type: 'SET_MONITOR'; sessionId: string; monitor: MonitorMode; baseRevision?: number };
type StemChange = { type: 'SET_STEM'; sessionId: string; mode: StemMode; baseRevision?: number };

export type WorkerCommand =
  | { type: 'GET_STATUS' }
  | { type: 'STOP'; sessionId: string }
  | EffectChange
  | TuningChange
  | ReverbChange
  | MonitorChange
  | StemChange;
export type AudioCommand =
  | { type: 'READ' }
  | { type: 'START'; session: CaptureSession; streamId: string; tuning?: TuningSettings }
  | { type: 'STOP'; sessionId: string }
  | { type: 'UPDATE_TAB'; sessionId: string; title?: string; muted?: boolean; platform?: SourcePlatform }
  | EffectChange
  | TuningChange
  | ReverbChange
  | MonitorChange
  | StemChange;

export type WorkerMessage = WorkerCommand & { target: 'worker' };
export type StemCodeRequest = { target: 'worker'; type: 'GET_STEM_CODE' };
export type StemCodeReply = { ok: true; code: string } | { ok: false; message: string };
export type AudioMessage = AudioCommand & { target: 'audio' };
export type StatusChanged = { target: 'panel'; type: 'STATUS_CHANGED' };
export type MeterUpdate = { sessionId: string; features: AudioFeatures };
export const meterChannel = 'moodshift-meter';
export type Reply = { ok: true; status: CaptureStatus } | { ok: false; message: string };

export function toAudio(command: AudioCommand): Promise<Reply> {
  return chrome.runtime.sendMessage({ ...command, target: 'audio' } satisfies AudioMessage);
}

export function toWorker(command: WorkerCommand): Promise<Reply> {
  return chrome.runtime.sendMessage({ ...command, target: 'worker' } satisfies WorkerMessage);
}

export function statusChanged(): void {
  void chrome.runtime.sendMessage({ target: 'panel', type: 'STATUS_CHANGED' } satisfies StatusChanged)
    .catch(() => undefined); // The panel can be closed.
}
