export interface PitchSettings {
  enabled: boolean;
  semitones: number;
}

export const pitchRange = { min: -6, max: 6, step: 0.1 } as const;
export const defaultPitch: Readonly<PitchSettings> = { enabled: false, semitones: 0 };
export type PitchPlayback = { phase: 'bypass' | 'starting' | 'active' | 'unavailable'; latencySeconds: number };

export function pitchSettings(input: unknown): PitchSettings {
  const pitch = input as PitchSettings | null;
  if (!pitch || typeof pitch.enabled !== 'boolean' || !Number.isFinite(pitch.semitones)) {
    throw new Error('Choose a valid pitch setting.');
  }
  const { min, max } = pitchRange;
  return { enabled: pitch.enabled, semitones: Math.round(Math.max(min, Math.min(max, pitch.semitones)) * 10) / 10 || 0 };
}
