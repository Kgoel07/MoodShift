import { effectSpecs } from './effects.js';

export const reverbPresets = {
  dreamy: { label: '🌙 Dreamy Reverb', amount: 0.28, duration: 2.4, preDelay: 0.012, toneHz: 3800 },
  hall: { label: '🏛️ Concert Hall', amount: 0.24, duration: 2.8, preDelay: 0.028, toneHz: 6500 },
  slowed: { label: '🌧️ Slowed + Reverb', amount: 0.34, duration: 3.4, preDelay: 0.018, toneHz: 2800 },
} as const;
export type ReverbPreset = keyof typeof reverbPresets;
export interface ReverbSettings { preset: ReverbPreset; duration: number; lastAmount: number; }
export type ReverbPatch = Partial<Pick<ReverbSettings, 'preset' | 'duration'>> & { enabled?: boolean; amount?: number };
export type ReverbSpeed = { state: 'idle' | 'active' | 'unavailable'; message?: string; rate?: number };
export interface ReverbState extends ReverbSettings { speed: ReverbSpeed; }
export const reverbDuration = { min: 0.4, max: 4, step: 0.1 } as const;
export const defaultReverb: Readonly<ReverbSettings> = Object.freeze({ preset: 'dreamy', duration: 2.4, lastAmount: 0.28 });

function bounded(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Reverb values must be finite numbers.');
  return Math.max(min, Math.min(max, value));
}
export function validateReverb(input: unknown): ReverbSettings {
  const value = input as ReverbSettings | null;
  if (!value || typeof value !== 'object' || !Object.hasOwn(reverbPresets, value.preset)
    || Object.keys(value).some(key => !['preset', 'duration', 'lastAmount'].includes(key))) throw new Error('Invalid reverb settings.');
  return { preset: value.preset, duration: Math.round(bounded(value.duration, reverbDuration.min, reverbDuration.max) * 10) / 10,
    lastAmount: bounded(value.lastAmount, 0, effectSpecs.reverbMix.max) };
}
export function changeReverb(current: ReverbSettings, mix: number, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid reverb change.');
  const patch = input as ReverbPatch;
  if (Object.keys(patch).some(key => !['preset', 'duration', 'enabled', 'amount'].includes(key))
    || (patch.enabled !== undefined && typeof patch.enabled !== 'boolean')) throw new Error('Invalid reverb change.');
  let settings = { ...current };
  if (patch.preset !== undefined) {
    if (!Object.hasOwn(reverbPresets, patch.preset)) throw new Error('Unknown reverb preset.');
    const preset = reverbPresets[patch.preset];
    settings = { preset: patch.preset, duration: preset.duration, lastAmount: preset.amount };
    mix = preset.amount;
  }
  if (patch.duration !== undefined) settings.duration = patch.duration;
  if (patch.amount !== undefined) {
    mix = bounded(patch.amount, 0, effectSpecs.reverbMix.max);
    if (mix > 0) settings.lastAmount = mix;
  }
  if (patch.enabled === false) mix = 0;
  if (patch.enabled === true && mix === 0) mix = settings.lastAmount || defaultReverb.lastAmount;
  return { settings: validateReverb(settings), mix };
}
