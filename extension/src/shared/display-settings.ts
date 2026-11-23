import { homeLayoutKey, readHomeLayout, type HomeSection } from './home-layout.js';

export const lyricsOffsetKey = 'lyricsManualCorrectionV2';
const previousOffsetKey = 'lyricsManualCorrection';
const sidepanelOffsetKey = 'lyricsOffset';
export const displayOptionsKey = 'moodshiftDisplayOptions';
export const displayKeys = [homeLayoutKey, lyricsOffsetKey, previousOffsetKey, sidepanelOffsetKey, displayOptionsKey];
export const lyricsTimingCalibration = -1.2;
export const lyricOffsetRange = { min: -10, max: 10 } as const;

export interface DisplaySettings {
  home: Record<HomeSection, boolean>;
  lyricsOffset: number;
  lyricsFollow: boolean;
  lyricsOpen: boolean;
  chordsOpen: boolean;
}

export function clampLyricsCorrection(value: number): number {
  return Math.round(Math.max(lyricOffsetRange.min, Math.min(lyricOffsetRange.max, Number.isFinite(value) ? value : 0)) * 10) / 10;
}

export function restoreLyricsCorrection(saved: unknown, previous: unknown): number {
  if (typeof saved === 'number' && Number.isFinite(saved)) return clampLyricsCorrection(saved);
  if (typeof previous !== 'number' || !Number.isFinite(previous) || previous === 0) return 0;
  return clampLyricsCorrection(previous - lyricsTimingCalibration);
}

export function readDisplay(values: Record<string, unknown>): DisplaySettings {
  const options = values[displayOptionsKey] as Partial<DisplaySettings> | undefined;
  return {
    home: readHomeLayout(values[homeLayoutKey]),
    lyricsOffset: restoreLyricsCorrection(values[lyricsOffsetKey], values[sidepanelOffsetKey] ?? values[previousOffsetKey]),
    lyricsFollow: options?.lyricsFollow !== false,
    lyricsOpen: options?.lyricsOpen !== false,
    chordsOpen: options?.chordsOpen === true,
  };
}

export function storeDisplay(settings: DisplaySettings, previous: DisplaySettings): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (settings.home !== previous.home) patch[homeLayoutKey] = settings.home;
  if (settings.lyricsOffset !== previous.lyricsOffset) patch[lyricsOffsetKey] = settings.lyricsOffset;
  const { lyricsFollow, lyricsOpen, chordsOpen } = settings;
  if (lyricsFollow !== previous.lyricsFollow || lyricsOpen !== previous.lyricsOpen || chordsOpen !== previous.chordsOpen) {
    patch[displayOptionsKey] = { lyricsFollow, lyricsOpen, chordsOpen };
  }
  return patch;
}
