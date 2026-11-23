import { loadEqPresets } from './eq-presets';
import { listPresets } from './saved-presets';
import { displayKeys, readDisplay, type DisplaySettings } from './shared/display-settings';
import { defaultReverb } from './shared/reverb';
import { defaultTuning } from './shared/tuning';
import type { CaptureStatus } from './shared/types';
import type { ControlPresets, ControlState } from './shared/controls';

export type Capture = Extract<CaptureStatus, { phase: 'capturing' }>;

export function controlState(capture: Capture, display: DisplaySettings): ControlState {
  const { preset, duration, lastAmount } = capture.reverb ?? defaultReverb;
  return { effects: capture.effects, tuning: capture.tuning ?? defaultTuning(), reverb: { preset, duration, lastAmount },
    monitor: capture.monitor, stemMode: capture.stem.mode, display };
}

export async function loadDisplay(): Promise<DisplaySettings> {
  return readDisplay(await chrome.storage.local.get(displayKeys));
}

export async function loadControlPresets(): Promise<ControlPresets> {
  const [audio, eq] = await Promise.all([listPresets().then(result => result.presets).catch(() => []), loadEqPresets().catch(() => [])]);
  return { audio, eq };
}
