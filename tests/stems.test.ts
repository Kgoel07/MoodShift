import { describe, expect, it } from 'vitest';
import { applyPatch, neutralEffects } from '../extension/src/shared/effects';
import { directStemIntent, parseInterpretation } from '../extension/src/shared/types';
import { modelJsonSchema, parseModelContent } from '../server/src/schema';

describe('stem interpretation', () => {
  it.each([
    ['just play instrumental', 'instrumental'],
    ['vocals only', 'vocals'],
    ['back to full song', 'full'],
    ['just play the beat', 'unsupported'],
    ['beat-only', 'unsupported'],
    ['underlying beat', 'unsupported'],
    ['remove vocals and add more reverb', undefined],
    ['make the bass warmer', undefined],
  ])('recognizes direct or unsupported requests for %s', (prompt, expected) => {
    expect(directStemIntent(prompt)).toBe(expected);
  });

  it('preserves the separate stem mode and unrelated effects in a mixed Gemini result', () => {
    const current = { ...neutralEffects, bassDb: 3, reverbMix: 0.1 };
    const mixed = { mode: 'patch', patch: { reverbMix: 0.25 }, stemMode: 'instrumental', summary: 'Instrumental, with more reverb.', unsupported: [] };
    const parsed = parseModelContent(JSON.stringify(mixed), current);
    expect(parseInterpretation(parsed, current)).toEqual(mixed);
    expect(applyPatch(current, parsed.patch)).toEqual({ ...current, reverbMix: 0.25 });
    expect(modelJsonSchema).toMatchObject({
      properties: { stemMode: { enum: ['full', 'instrumental', 'vocals'] } },
    });
    for (const stemMode of ['beat', 'drums', null]) {
      expect(() => parseModelContent(JSON.stringify({ ...mixed, stemMode }), current)).toThrow();
    }
    expect(() => parseInterpretation({ ...mixed, mode: 'unsupported', patch: {} }, current)).toThrow();
  });
});
