import { clampPatch, effectKeys, type AudioEffectState, type EffectPatch } from './effects.js';
import type { ReverbState } from './reverb';
import type { SourcePlatform } from './track';

export interface SourceTab {
  tabId: number;
  title: string;
  muted: boolean;
  platform?: SourcePlatform;
}

export interface CaptureSession extends SourceTab {
  id: string;
}

export type CaptureStatus =
  | { phase: 'ready' }
  | { phase: 'starting'; source: SourceTab }
  | {
      phase: 'capturing';
      session: CaptureSession;
      effects: AudioEffectState;
      reverb?: ReverbState;
      revision: number;
      monitor: MonitorMode;
      stem: StemStatus;
      features: AudioFeatures;
      outputPaused: boolean;
    }
  | { phase: 'error'; message: string };

export type MonitorMode = 'original' | 'modified';
export const stemModes = ['full', 'instrumental', 'vocals'] as const;
export type StemMode = typeof stemModes[number];
export type StemStatus =
  | { phase: 'idle'; mode: 'full' }
  | { phase: 'loading' | 'buffering' | 'active'; mode: Exclude<StemMode, 'full'> }
  | { phase: 'unavailable'; mode: 'full'; message: string };

export interface AudioFeatures {
  rms: number;
  bassEnergy: number;
  midEnergy: number;
  trebleEnergy: number;
  brightness: number;
  isSilent: boolean;
}

export const silentFeatures: Readonly<AudioFeatures> = Object.freeze({
  rms: 0, bassEnergy: 0, midEnergy: 0, trebleEnergy: 0, brightness: 0, isSilent: true,
});

export interface Interpretation {
  mode: 'patch' | 'reset' | 'unsupported';
  patch: EffectPatch;
  summary: string;
  unsupported: string[];
  stemMode?: StemMode;
}

export function directStemIntent(prompt: string): StemMode | 'unsupported' | undefined {
  const phrase = prompt.trim().toLowerCase().replace(/[.!?]+$/, '')
    .replaceAll('-only', ' only')
    .replace(/^please\s+/, '').replace(/^(?:just\s+)?(?:play|give me)\s+/, '').replace(/^(?:just|only)\s+/, '')
    .replace(/^the\s+/, '');
  if (/^(?:instrumental(?: only)?|remove (?:the )?vocals)$/.test(phrase)) return 'instrumental';
  if (/^(?:vocals(?: only)?|isolate (?:the )?vocals)$/.test(phrase)) return 'vocals';
  if (/^(?:back to (?:the )?)?full (?:mix|song)$/.test(phrase)) return 'full';
  if (/^(?:underlying )?(?:beat|drums|bass)(?: only)?$/.test(phrase)) return 'unsupported';
}

function plainText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid interpretation text.');
  const text = value.replace(/[\p{Cc}\p{Cf}<>]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Empty interpretation text.');
  return text;
}

export function parseInterpretation(input: unknown, current: AudioEffectState): Interpretation {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid interpretation response.');
  }
  const { mode, patch: rawPatch, summary, unsupported, stemMode } = input as Record<string, unknown>;
  if (Object.keys(input).some(key => !['mode', 'patch', 'summary', 'unsupported', 'stemMode'].includes(key))
    || (mode !== 'patch' && mode !== 'reset' && mode !== 'unsupported')) {
    throw new Error('Invalid interpretation mode or fields.');
  }
  if (stemMode !== undefined && (mode === 'unsupported' || !stemModes.includes(stemMode as StemMode))) {
    throw new Error('Invalid stem request.');
  }
  if (!Array.isArray(unsupported) || unsupported.length > 5) throw new Error('Invalid unsupported operations.');
  const notices = unsupported.map(item => plainText(item, 100));
  const validated = clampPatch(rawPatch);
  if (mode !== 'patch' && Object.keys(validated).length) throw new Error('Unexpected patch for this mode.');
  if (mode === 'unsupported' && notices.length === 0) throw new Error('Missing unsupported operation.');
  const patch: EffectPatch = {};
  for (const key of effectKeys) {
    const value = validated[key];
    if (value !== undefined && value !== current[key]) patch[key] = value;
  }
  const result: Interpretation = { mode, patch, summary: plainText(summary, 240), unsupported: notices };
  if (stemMode !== undefined) result.stemMode = stemMode as StemMode;
  return result;
}

