export const eqRange = { minHz: 20, maxHz: 20_000, minGain: -12, maxGain: 12, minQ: 0.3, maxQ: 12 } as const;
export const defaultBands = [
  { id: 'sub', frequency: 60, name: 'Sub Bass' },
  { id: 'bass', frequency: 170, name: 'Bass' },
  { id: 'low-mid', frequency: 400, name: 'Low Mids' },
  { id: 'mid', frequency: 1000, name: 'Mids' },
  { id: 'high-mid', frequency: 3000, name: 'High Mids' },
  { id: 'treble', frequency: 10_000, name: 'Treble' },
] as const;
export const customBandLimit = 12;
const baseIds = new Set<string>(defaultBands.map(band => band.id));
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const customBand = new RegExp(`^point:${uuid}$`);
export const customEqPreset = new RegExp(`^eq:${uuid}$`);

export interface EqBand { id: string; frequency: number; gain: number; q: number; }
export interface EqSettings { enabled: boolean; preset: string | null; bands: EqBand[]; }
export type EqEdit =
  | { kind: 'eq-enabled'; enabled: boolean }
  | { kind: 'eq-band'; id: string; patch: Partial<Omit<EqBand, 'id'>> }
  | { kind: 'eq-add'; point: EqBand }
  | { kind: 'eq-remove'; id: string }
  | { kind: 'eq-reset' }
  | { kind: 'eq-preset'; preset: string; bands?: EqBand[] }
  | { kind: 'eq-forget'; preset: string };

export const eqPresets = {
  balanced: { name: 'Balanced', gains: [0, 0, 0, 0, 0, 0] },
  bass: { name: 'Bass Boost', gains: [5, 4, 1, -1, 0, 0] },
  vocal: { name: 'Vocal Clarity', gains: [-3, -2, -1, 2, 4, 1] },
  warm: { name: 'Warm', gains: [1, 3, 2, 0, -2, -2] },
  bright: { name: 'Bright', gains: [-1, -1, -1, 0, 3, 5] },
} as const;

export function isDefaultBand(id: string): boolean { return baseIds.has(id); }

export function builtInBands(id: keyof typeof eqPresets): EqBand[] {
  return defaultBands.map(({ id: bandId, frequency }, i) => ({ id: bandId, frequency, gain: eqPresets[id].gains[i], q: 1 }));
}

export function defaultEqualizer(): EqSettings { return { enabled: true, preset: 'balanced', bands: builtInBands('balanced') }; }

function limit(value: number, min: number, max: number, digits: number): number {
  if (!Number.isFinite(value)) throw new Error('Enter a valid frequency, gain, or bandwidth.');
  return Number(Math.min(max, Math.max(min, value)).toFixed(digits));
}

function sanitizeBand(input: EqBand): EqBand {
  if (!input || typeof input.id !== 'string' || (!isDefaultBand(input.id) && !customBand.test(input.id))) {
    throw new Error('This EQ point is invalid.');
  }
  const { minHz, maxHz, minGain, maxGain, minQ, maxQ } = eqRange;
  return { id: input.id, frequency: limit(input.frequency, minHz, maxHz, 0),
    gain: limit(input.gain, minGain, maxGain, 1), q: limit(input.q, minQ, maxQ, 2) };
}

export function validateBands(input: unknown): EqBand[] {
  if (!Array.isArray(input) || input.length < defaultBands.length || input.length > defaultBands.length + customBandLimit) {
    throw new Error('This EQ has an invalid number of bands.');
  }
  const bands = input.map(sanitizeBand);
  const byId = new Map(bands.map(band => [band.id, band]));
  if (byId.size !== bands.length || defaultBands.some(band => !byId.has(band.id))) {
    throw new Error('This EQ is missing a default band or has duplicate points.');
  }
  return [...defaultBands.map(band => byId.get(band.id)!), ...bands.filter(band => !isDefaultBand(band.id))];
}

export function validateEq(input: unknown): EqSettings {
  const eq = input as EqSettings | null;
  if (!eq || typeof eq.enabled !== 'boolean' || (eq.preset !== null && (typeof eq.preset !== 'string'
    || (!Object.hasOwn(eqPresets, eq.preset) && !customEqPreset.test(eq.preset))))) throw new Error('Invalid equalizer settings.');
  return { enabled: eq.enabled, preset: eq.preset, bands: validateBands(eq.bands) };
}

export function changeEq(current: EqSettings, edit: EqEdit): EqSettings {
  switch (edit.kind) {
    case 'eq-enabled': return validateEq({ ...current, enabled: edit.enabled });
    case 'eq-reset': return { ...defaultEqualizer(), enabled: current.enabled };
    case 'eq-preset': {
      const bands = Object.hasOwn(eqPresets, edit.preset) ? builtInBands(edit.preset as keyof typeof eqPresets) : edit.bands;
      return validateEq({ enabled: true, preset: edit.preset, bands });
    }
    case 'eq-forget': return current.preset === edit.preset ? { ...current, preset: null } : current;
    case 'eq-band': {
      const previous = current.bands.find(band => band.id === edit.id);
      if (!previous) throw new Error('That EQ point is no longer available.');
      const next = sanitizeBand({ ...previous, ...edit.patch, id: previous.id });
      if (next.frequency === previous.frequency && next.gain === previous.gain && next.q === previous.q) return current;
      return { ...current, preset: null, bands: current.bands.map(band => band === previous ? next : band) };
    }
    case 'eq-add': {
      const point = sanitizeBand(edit.point);
      if (isDefaultBand(point.id)) throw new Error('Choose a new EQ point.');
      if (current.bands.some(band => band.id === point.id)) return current;
      return validateEq({ ...current, preset: null, bands: [...current.bands, point] });
    }
    case 'eq-remove':
      if (isDefaultBand(edit.id)) throw new Error('The six default bands can be reset in the equalizer.');
      return { ...current, preset: null, bands: current.bands.filter(band => band.id !== edit.id) };
    default: throw new Error('Unknown equalizer action.');
  }
}
