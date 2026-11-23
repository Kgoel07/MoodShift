import { applyPatch, effectKeys, effectSpecs, neutralEffects, presets, type AudioEffectState } from './effects.js';
import { defaultBands, eqPresets, eqRange, type EqBand } from './equalizer.js';
import { defaultReverb, changeReverb, reverbDuration, reverbPresets, type ReverbPatch, type ReverbSettings } from './reverb.js';
import { clampLyricsCorrection, lyricOffsetRange, type DisplaySettings } from './display-settings.js';
import { homeSectionKeys, homeSections } from './home-layout.js';
import { pitchRange } from './pitch.js';
import { changeTuning, defaultTuning, type TuningEdit, type TuningSettings } from './tuning.js';
import { stemModes, type MonitorMode, type StemMode } from './types.js';

export const controlActionLimit = 12;
export const controlPresetLimit = 30;
export const controlOperations = ['set', 'adjust', 'reset', 'remove'] as const;
type Operation = typeof controlOperations[number];
type Value = number | boolean | string;
export interface ControlAction { control: string; operation: Operation; value?: Value; frequency?: number; }
export interface ControlResult { actions: ControlAction[]; summary: string; unsupported: string[]; }
export interface ControlState {
  effects: AudioEffectState;
  tuning: TuningSettings;
  reverb: ReverbSettings;
  monitor: MonitorMode;
  stemMode: StemMode;
  display: DisplaySettings;
}
export interface ControlPresets {
  audio: readonly { name: string; audioSettings: AudioEffectState; tuning?: TuningSettings;
    reverb?: ReverbSettings; stemMode: StemMode; monitor: MonitorMode }[];
  eq: readonly { id: string; name: string; bands: EqBand[] }[];
}

type Range = { min: number; max: number };
type Parameter = { kind: 'number'; range: Range } | { kind: 'boolean' | 'name' | 'none' }
  | { kind: 'choice'; choices: readonly string[] };
type Plan = ControlState & { selectStem: boolean };
type Entry = { label: string; parameter: Parameter; operations: readonly Operation[]; atFrequency?: boolean;
  apply: (state: Plan, action: ControlAction, saved: ControlPresets) => void };

const clamp = (value: number, { min, max }: Range) => Math.min(max, Math.max(min, value));
const frequencyRange = { min: eqRange.minHz, max: eqRange.maxHz };
const gainRange = { min: eqRange.minGain, max: eqRange.maxGain };
const qRange = { min: eqRange.minQ, max: eqRange.maxQ };
const mixModes = ['original', 'modified', ...stemModes] as const;

function numberTarget(action: ControlAction, current: number, neutral: number, range: Range): number {
  if (action.operation === 'reset') return neutral;
  return clamp((action.operation === 'adjust' ? current : 0) + (action.value as number), range);
}

function numeric(label: string, range: Range, neutral: number, current: (state: Plan) => number,
  apply: (state: Plan, target: number, action: ControlAction) => void): Entry {
  return { label, parameter: { kind: 'number', range }, operations: ['set', 'adjust', 'reset'],
    apply: (state, action) => apply(state, numberTarget(action, current(state), neutral, range), action) };
}

function flag(label: string, apply: (state: Plan, checked: boolean) => void): Entry {
  return { label, parameter: { kind: 'boolean' }, operations: ['set'], apply: (state, action) => apply(state, action.value as boolean) };
}

function choice(label: string, choices: readonly string[], apply: (state: Plan, value: string) => void): Entry {
  return { label, parameter: { kind: 'choice', choices }, operations: ['set'], apply: (state, action) => apply(state, action.value as string) };
}

function named(label: string, apply: (state: Plan, value: string, saved: ControlPresets) => void): Entry {
  return { label, parameter: { kind: 'name' }, operations: ['set'], apply: (state, action, saved) => apply(state, action.value as string, saved) };
}

function reset(label: string, apply: (state: Plan) => void): Entry {
  return { label, parameter: { kind: 'none' }, operations: ['reset'], apply };
}

function tune(state: Plan, edit: TuningEdit): void { state.tuning = changeTuning(state.tuning, edit); }
function reverb(state: Plan, patch: ReverbPatch): void {
  const next = changeReverb(state.reverb, state.effects.reverbMix, patch);
  state.reverb = next.settings;
  state.effects = applyPatch(state.effects, { reverbMix: next.mix });
}

function setMix(state: Plan, mode: string): void {
  if (mode === 'original' || mode === 'modified') state.monitor = mode;
  else {
    state.monitor = 'modified';
    state.stemMode = mode as StemMode;
    state.selectStem = true;
  }
}

function setBand(state: Plan, id: string, patch: Partial<Omit<EqBand, 'id'>>): void {
  tune(state, { kind: 'eq-band', id, patch });
}

function frequencyEdit(label: string, property: 'gain' | 'q' | 'frequency', range: Range, fallback: number): Entry {
  return { label, atFrequency: true, parameter: { kind: 'number', range },
    operations: property === 'frequency' ? ['set'] : ['set', 'adjust', 'reset'],
    apply(state, action) {
      const frequency = Math.round(clamp(action.frequency!, frequencyRange));
      const band = state.tuning.eq.bands.find(item => item.frequency === frequency);
      const target = numberTarget(action, band?.[property] ?? fallback, fallback, range);
      if (band) setBand(state, band.id, { [property]: target });
      else if (property === 'gain' && target !== 0) {
        tune(state, { kind: 'eq-add', point: { id: `point:${crypto.randomUUID()}`, frequency, gain: target, q: 1 } });
      } else if (action.operation !== 'reset') throw new Error(`Add a gain adjustment at ${frequency} Hz before editing that EQ point.`);
      if (property === 'gain' && target !== 0 && !state.tuning.eq.enabled) tune(state, { kind: 'eq-enabled', enabled: true });
    },
  };
}

function findPreset<T extends { name: string }>(rows: readonly T[], name: string): T {
  const preset = rows.find(row => row.name.toLowerCase() === name.toLowerCase());
  if (!preset) throw new Error('That saved preset is no longer available.');
  return preset;
}

const displayControls: Record<string, Entry> = {
  'lyrics.offset': numeric('Lyric and Songle chord timing offset (seconds, positive delays the display)', lyricOffsetRange, 0,
    state => state.display.lyricsOffset, (state, value) => { state.display = { ...state.display, lyricsOffset: clampLyricsCorrection(value) }; }),
  'lyrics.follow': flag('Follow synchronized lyrics as the song plays', (state, value) => { state.display = { ...state.display, lyricsFollow: value }; }),
  'lyrics.open': flag('Expand or collapse the Lyrics section', (state, value) => { state.display = { ...state.display, lyricsOpen: value }; }),
  'chords.open': flag('Expand or collapse Chords in Settings', (state, value) => { state.display = { ...state.display, chordsOpen: value }; }),
  ...Object.fromEntries(homeSectionKeys.map(key => [`home.${key}`, flag(`Show ${homeSections[key].label} on Home`, (state, value) => {
    if (state.display.home[key] !== value) state.display = { ...state.display, home: { ...state.display.home, [key]: value } };
  })])),
};

const registry: Record<string, Entry> = {
  'audio.reset': reset('Reset all audio effects, pitch, EQ, reverb and source mix to normal', state => {
    state.effects = { ...neutralEffects };
    state.tuning = defaultTuning();
    state.reverb = { ...defaultReverb };
    setMix(state, 'full');
  }),
  mix: choice('Select Original, Modified, Full Mix, Vocals only, or Instrumental without vocals', mixModes, setMix),
  ...Object.fromEntries(effectKeys.filter(key => key !== 'reverbMix').map(key => {
    const spec = effectSpecs[key];
    return [key, numeric(`${spec.label} (${spec.unit === '%' ? 'fraction from 0 to 1' : spec.unit})`, spec, spec.neutral,
      state => state.effects[key], (state, value) => { state.effects = applyPatch(state.effects, { [key]: value }); })];
  })),
  'pitch.enabled': flag('Enable or bypass pitch while retaining the value', (state, enabled) => tune(state, { kind: 'pitch', patch: { enabled } })),
  'pitch.semitones': numeric('Independent pitch in semitones. Preserve playback speed', pitchRange, 0, state => state.tuning.pitch.semitones,
    (state, semitones, action) => tune(state, { kind: 'pitch', patch: action.operation === 'reset' ? { semitones } : { semitones, enabled: true } })),
  'eq.enabled': flag('Enable or bypass the equalizer', (state, enabled) => tune(state, { kind: 'eq-enabled', enabled })),
  ...Object.fromEntries(defaultBands.map(band => [`eq.${band.id}`, numeric(`Equalizer ${band.name} gain (dB, default band ${band.frequency} Hz)`,
    gainRange, 0, state => state.tuning.eq.bands.find(point => point.id === band.id)!.gain,
    (state, gain) => {
      setBand(state, band.id, { gain });
      if (gain !== 0 && !state.tuning.eq.enabled) tune(state, { kind: 'eq-enabled', enabled: true });
    })])),
  'eq.frequency': frequencyEdit('Equalizer gain (dB) at a specific frequency. Can create a custom point', 'gain', gainRange, 0),
  'eq.bandwidth': frequencyEdit('Bandwidth Q for an existing EQ point at the specified frequency. Higher Q is narrower', 'q', qRange, 1),
  'eq.move': frequencyEdit('Move an existing EQ point from frequency to value in Hz', 'frequency', frequencyRange, 0),
  'eq.remove': { label: 'Remove a custom EQ point at the specified frequency', parameter: { kind: 'none' },
    operations: ['remove'], atFrequency: true, apply(state, action) {
      const point = state.tuning.eq.bands.find(band => band.frequency === Math.round(action.frequency!) && band.id.startsWith('point:'));
      if (!point) throw new Error('There is no custom EQ point at that frequency.');
      tune(state, { kind: 'eq-remove', id: point.id });
    } },
  'eq.reset': reset('Reset to the six flat EQ bands and clear custom points', state => tune(state, { kind: 'eq-reset' })),
  'eq.preset': choice(`Built-in EQ preset ${Object.entries(eqPresets).map(([id, preset]) => `${id} (${preset.name})`).join(', ')}`,
    Object.keys(eqPresets), (state, preset) => tune(state, { kind: 'eq-preset', preset })),
  'eq.saved': named('Apply an existing saved EQ preset by exact name', (state, name, saved) => {
    const preset = findPreset(saved.eq, name);
    tune(state, { kind: 'eq-preset', preset: preset.id, bands: preset.bands });
  }),
  'reverb.enabled': flag('Enable or disable reverb while remembering its amount', (state, enabled) => reverb(state, { enabled })),
  'reverb.preset': choice(`Reverb preset ${Object.entries(reverbPresets).map(([id, preset]) => `${id} (${preset.label})`).join(', ')}. Slowed changes speed on YouTube watch pages`,
    Object.keys(reverbPresets), (state, preset) => reverb(state, { preset: preset as keyof typeof reverbPresets })),
  'reverb.amount': numeric('Wet reverb mix as a fraction, for example 0.25 is 25%', effectSpecs.reverbMix, 0,
    state => state.effects.reverbMix, (state, amount) => reverb(state, { amount })),
  'reverb.duration': numeric('Reverb tail duration in seconds', reverbDuration, defaultReverb.duration,
    state => state.reverb.duration, (state, duration) => reverb(state, { duration })),
  preset: choice('Built-in audio preset', Object.keys(presets), (state, name) => {
    const effects = presets[name as keyof typeof presets];
    reverb(state, { amount: effects.reverbMix });
    state.effects = { ...effects };
  }),
  'preset.saved': named('Apply an existing My Presets mix by exact name', (state, name, saved) => {
    const preset = findPreset(saved.audio, name);
    state.effects = { ...preset.audioSettings };
    if (preset.reverb) state.reverb = preset.reverb;
    if (preset.tuning) state.tuning = preset.tuning;
    state.monitor = preset.monitor;
    state.stemMode = preset.stemMode;
    state.selectStem = true;
  }),
  ...displayControls,
};

export const controlIds = Object.keys(registry);
export const controlDescriptions = Object.entries(registry).map(([control, { label, parameter, operations, atFrequency }]) => ({
  control, label, parameter, operations, ...(atFrequency ? { frequencyHz: frequencyRange } : {}),
}));
export const isDisplayControl = (control: string) => Object.hasOwn(displayControls, control);

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid MoodShift control response.');
  return input as Record<string, unknown>;
}

function cleanText(input: unknown, max: number): string {
  if (typeof input !== 'string' || !input.trim() || input.length > max || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new Error('Invalid MoodShift control text.');
  }
  return input.trim();
}

export function parseControlActions(input: unknown): ControlAction[] {
  if (!Array.isArray(input) || input.length > controlActionLimit) throw new Error('Invalid number of changes.');
  return input.map(raw => {
    const { control, operation, frequency, value, ...extra } = record(raw);
    if (Object.keys(extra).length || typeof control !== 'string' || !Object.hasOwn(registry, control)) throw new Error('Unknown audio control.');
    const entry = registry[control];
    if (!entry.operations.includes(operation as Operation)) throw new Error('That operation is unavailable for this control.');
    if (entry.atFrequency ? typeof frequency !== 'number' || !Number.isFinite(frequency)
      || frequency < frequencyRange.min || frequency > frequencyRange.max : frequency !== undefined) throw new Error('Invalid EQ point frequency.');
    const parameter = entry.parameter;
    if (operation === 'reset' || operation === 'remove') {
      if (value !== undefined) throw new Error('A reset or remove action takes no value.');
    } else if (parameter.kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 100_000) throw new Error('Invalid numeric setting.');
    } else if (parameter.kind === 'boolean') {
      if (typeof value !== 'boolean') throw new Error('Invalid toggle setting.');
    } else if (parameter.kind === 'choice') {
      if (typeof value !== 'string' || !parameter.choices.includes(value)) throw new Error('Unknown setting choice.');
    } else if (parameter.kind === 'name') {
      cleanText(value, 64);
    }
    return { control, operation: operation as Operation, ...(frequency === undefined ? {} : { frequency: frequency as number }),
      ...(value === undefined ? {} : { value: typeof value === 'string' ? value.trim() : value as Value }) };
  });
}

export function parseControlResult(input: unknown): ControlResult {
  const { actions, summary, unsupported, ...extra } = record(input);
  if (Object.keys(extra).length || !Array.isArray(unsupported) || unsupported.length > 5) throw new Error('Invalid MoodShift response.');
  return { actions: parseControlActions(actions), summary: cleanText(summary, 240), unsupported: unsupported.map(text => cleanText(text, 120)) };
}

export function applyControls(current: ControlState, input: unknown, saved: ControlPresets): Plan {
  const plan: Plan = { ...current, selectStem: false };
  for (const action of parseControlActions(input)) registry[action.control].apply(plan, action, saved);
  return plan;
}

export function changeDisplay(current: DisplaySettings, input: unknown): DisplaySettings {
  const [action] = parseControlActions([input]);
  if (!isDisplayControl(action.control)) throw new Error('Unknown display option.');
  // Display actions only read and update the display slice of the same registry.
  const plan: Plan = { display: current, effects: { ...neutralEffects }, tuning: defaultTuning(), reverb: { ...defaultReverb },
    monitor: 'modified', stemMode: 'full', selectStem: false };
  registry[action.control].apply(plan, action, { audio: [], eq: [] });
  return plan.display;
}
