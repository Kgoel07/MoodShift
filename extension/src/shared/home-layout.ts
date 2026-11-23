export const homeSections = {
  lyrics: { label: 'Lyrics', visible: true },
  stems: { label: 'Stems', visible: true },
  reverb: { label: 'Reverb', visible: false },
  controls: { label: 'Audio controls', visible: false },
  presets: { label: 'My Presets', visible: false },
} as const;

export type HomeSection = keyof typeof homeSections;
export const homeSectionKeys = Object.keys(homeSections) as HomeSection[];
export const homeLayoutKey = 'moodshiftHomeLayout';

export function readHomeLayout(input: unknown): Record<HomeSection, boolean> {
  const saved = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  return Object.fromEntries(homeSectionKeys.map(key => [key,
    Object.hasOwn(saved, key) && typeof saved[key] === 'boolean' ? saved[key] : homeSections[key].visible,
  ])) as Record<HomeSection, boolean>;
}

export function rangeFill(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max - min) || max <= min) return 0;
  return Math.max(0, Math.min(100, (value - min) / (max - min) * 100));
}
