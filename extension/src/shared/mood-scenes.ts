import { effectKeys, neutralEffects, type AudioEffectState, type EffectPatch } from './effects';
import type { CaptureStatus } from './types';

export interface MoodScene {
  id: string;
  name: string;
  emoji: string;
  subtitle: string;
  effects: Readonly<AudioEffectState>;
  stemMode: 'full' | 'instrumental';
}

const mix = (patch: EffectPatch) => Object.freeze({ ...neutralEffects, ...patch });

export const moodScenes: readonly MoodScene[] = [
  { id: 'midnight-drive', name: 'Midnight Drive', emoji: '🌙', subtitle: 'Deep & atmospheric',
    effects: mix({ bassDb: 4.3, trebleDb: -2.4, reverbMix: 0.17, outputGainDb: -1.5 }), stemMode: 'full' },
  { id: 'deep-focus', name: 'Deep Focus', emoji: '📚', subtitle: 'Calm & balanced',
    effects: mix({ bassDb: 0.3, trebleDb: -1.4, reverbMix: 0.02 }), stemMode: 'full' },
  { id: 'karaoke-night', name: 'Karaoke Night', emoji: '🎤', subtitle: 'Your turn to sing',
    effects: mix({ bassDb: -0.7, trebleDb: 1, highpassHz: 45, outputGainDb: -0.5 }), stemMode: 'instrumental' },
  { id: 'energy-rush', name: 'Energy Rush', emoji: '⚡', subtitle: 'Punchy & powerful',
    effects: mix({ bassDb: 4, trebleDb: 3, highpassHz: 30, reverbMix: 0.02, outputGainDb: -2 }), stemMode: 'full' },
  { id: 'rainy-evening', name: 'Rainy Evening', emoji: '🌧️', subtitle: 'Warm & mellow',
    effects: mix({ bassDb: 1.8, trebleDb: -3.3, reverbMix: 0.27, outputGainDb: -0.8 }), stemMode: 'full' },
  { id: 'cloud-nine', name: 'Cloud Nine', emoji: '☁️', subtitle: 'Dreamy & spacious',
    effects: mix({ bassDb: -0.6, trebleDb: -2.3, reverbMix: 0.4, outputGainDb: -1 }), stemMode: 'full' },
];

export function activeMoodScene(status: CaptureStatus, pendingEdits: EffectPatch): MoodScene | undefined {
  if (status.phase !== 'capturing' || status.monitor !== 'modified') return;
  return moodScenes.find(scene => status.stem.mode === scene.stemMode
    && (scene.stemMode === 'full' || status.stem.phase === 'active')
    && effectKeys.every(key => (pendingEdits[key] ?? status.effects[key]) === scene.effects[key]));
}
