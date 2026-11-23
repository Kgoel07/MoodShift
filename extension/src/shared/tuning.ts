import { defaultEqualizer, changeEq, validateEq, type EqEdit, type EqSettings } from './equalizer.js';
import { defaultPitch, pitchSettings, type PitchSettings, type PitchPlayback } from './pitch.js';

export const tuningKey = 'moodshiftTuning';
export const eqSpectrumPort = 'moodshift-eq-spectrum';
export interface TuningSettings { pitch: PitchSettings; eq: EqSettings; }
export type TuningEdit = { kind: 'pitch'; patch: Partial<PitchSettings> } | EqEdit;
export interface AudioTiming {
  sampleRate: number;
  stemSeconds: number;
  processingSeconds: number;
  playoutSeconds: number;
  pitch: PitchPlayback;
}

export function defaultTuning(): TuningSettings { return { pitch: { ...defaultPitch }, eq: defaultEqualizer() }; }

export function validateTuning(input: unknown): TuningSettings {
  const value = input as TuningSettings | null;
  if (!value) throw new Error('Invalid pitch and EQ settings.');
  return { pitch: pitchSettings(value.pitch), eq: validateEq(value.eq) };
}

export function readTuning(input: unknown): TuningSettings {
  const value = input as Partial<TuningSettings> | null;
  const defaults = defaultTuning();
  try { defaults.pitch = pitchSettings(value?.pitch); } catch { /* Recover just the invalid field. */ }
  try { defaults.eq = validateEq(value?.eq); } catch { /* Recover just the invalid field. */ }
  return defaults;
}

export function changeTuning(current: TuningSettings, edit: TuningEdit): TuningSettings {
  if (!edit || typeof edit !== 'object') throw new Error('Invalid pitch or EQ action.');
  if (edit.kind === 'pitch') return { ...current, pitch: pitchSettings({ ...current.pitch, ...edit.patch }) };
  const eq = changeEq(current.eq, edit);
  return eq === current.eq ? current : { ...current, eq };
}
