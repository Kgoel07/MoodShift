import { describe, expect, it } from 'vitest';
import { neutralEffects } from '../extension/src/shared/effects';
import { parseInterpretation, silentFeatures } from '../extension/src/shared/types';
import { modelJsonSchema, parseModelContent, requestSchema } from '../server/src/schema';

const request = { prompt: 'A little more bass', currentEffects: neutralEffects, audioFeatures: silentFeatures };
const result = { mode: 'patch', patch: { bassDb: 44, reverbMix: 0 }, summary: 'More bass.', unsupported: [] };

describe('interpretation validation', () => {
  it('clamps complete input state and bounds features and prompt', () => {
    expect(requestSchema.parse({ ...request, currentEffects: { ...neutralEffects, bassDb: 14 } }).currentEffects.bassDb).toBe(8);
    expect(requestSchema.safeParse({ ...request, prompt: ' '.repeat(501) + 'bass' }).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, prompt: ' ' }).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, audioFeatures: { ...silentFeatures, rms: 1.01 } }).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, currentEffects: { bassDb: 0 } }).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, audioFeatures: { ...silentFeatures, samples: [] } }).success).toBe(false);
  });

  it('clamps server and extension independently, strips unchanged fields, and sanitizes display text', () => {
    const content = JSON.stringify({ ...result, summary: ' More\n bass.\u202e ' });
    expect(parseModelContent(content, neutralEffects)).toEqual({ ...result, patch: { bassDb: 8 } });
    expect(parseInterpretation(result, neutralEffects)).toEqual({ ...result, patch: { bassDb: 8 } });
    expect(modelJsonSchema).toMatchObject({
      additionalProperties: false,
      properties: { patch: { additionalProperties: false, properties: { bassDb: { minimum: -12, maximum: 8 } } } },
    });
  });

  it.each([
    'not JSON',
    '{"mode":"patch","patch":{"bassDb":1e999},"summary":"Bass","unsupported":[]}',
    JSON.stringify({ ...result, patch: { tempo: 0.5 } }),
    JSON.stringify({ ...result, patch: { bassDb: '4' } }),
    JSON.stringify({ ...result, patch: { bassDb: null } }),
    JSON.stringify({ ...result, mode: 'unsupported' }),
    JSON.stringify({ ...result, mode: 'unsupported', patch: {} }),
    JSON.stringify({ ...result, mode: 'reset' }),
    JSON.stringify({ ...result, summary: 'x'.repeat(241) }),
  ])('rejects malformed or unsafe model content %#', content => {
    expect(() => parseModelContent(content, neutralEffects)).toThrow();
  });
});
