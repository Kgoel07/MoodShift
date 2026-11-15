export const effectSpecs = {
  bassDb: { label: 'Bass shelf', min: -12, max: 8, neutral: 0, step: 0.1, unit: 'dB' },
  trebleDb: { label: 'Treble shelf', min: -12, max: 8, neutral: 0, step: 0.1, unit: 'dB' },
  highpassHz: { label: 'High-pass', min: 20, max: 1500, neutral: 20, step: 1, unit: 'Hz' },
  lowpassHz: { label: 'Low-pass', min: 600, max: 20000, neutral: 20000, step: 1, unit: 'Hz' },
  reverbMix: { label: 'Reverb', min: 0, max: 0.55, neutral: 0, step: 0.01, unit: '%' },
  delayMs: { label: 'Echo time', min: 0, max: 500, neutral: 0, step: 1, unit: 'ms' },
  delayMix: { label: 'Echo mix', min: 0, max: 0.35, neutral: 0, step: 0.01, unit: '%' },
  delayFeedback: { label: 'Echo feedback', min: 0, max: 0.4, neutral: 0, step: 0.01, unit: '%' },
  distortion: { label: 'Distortion', min: 0, max: 0.5, neutral: 0, step: 0.01, unit: '%' },
  outputGainDb: { label: 'Output gain', min: -12, max: 3, neutral: 0, step: 0.1, unit: 'dB' },
} as const;

export type EffectKey = keyof typeof effectSpecs;
export type AudioEffectState = Record<EffectKey, number>;
export type EffectPatch = Partial<AudioEffectState>;
export const effectKeys = Object.keys(effectSpecs) as EffectKey[];

export const neutralEffects: Readonly<AudioEffectState> = Object.freeze(
  Object.fromEntries(effectKeys.map(key => [key, effectSpecs[key].neutral])) as AudioEffectState,
);

export function clampPatch(input: unknown): EffectPatch {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Expected an object of effect values.');
  }
  const patch: EffectPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(effectSpecs, key)) throw new Error('Unknown effect parameter.');
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Effect values must be finite numbers.');
    const effect = key as EffectKey;
    const { min, max } = effectSpecs[effect];
    patch[effect] = Math.max(min, Math.min(max, value));
  }
  return patch;
}

export function applyPatch(current: Readonly<AudioEffectState>, patch: unknown): AudioEffectState {
  return { ...current, ...clampPatch(patch) };
}

export function clampEffects(input: unknown): AudioEffectState {
  const patch = clampPatch(input);
  if (Object.keys(patch).length !== effectKeys.length) throw new Error('Expected all effect parameters.');
  return applyPatch(neutralEffects, patch);
}
