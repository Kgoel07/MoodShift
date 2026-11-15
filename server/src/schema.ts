import { z } from 'zod';
import { clampEffects, effectKeys, effectSpecs, type EffectKey } from '../../extension/src/shared/effects.js';
import { parseInterpretation, stemModes } from '../../extension/src/shared/types.js';
import { installationId } from './memory.js';

const effectNumbers = Object.fromEntries(effectKeys.map(key => [key, z.number()])) as Record<EffectKey, z.ZodNumber>;
const patchSchema = z.strictObject(effectNumbers).partial();
const normalized = z.number().min(0).max(1);
const features = z.strictObject({
  rms: normalized,
  bassEnergy: normalized,
  midEnergy: normalized,
  trebleEnergy: normalized,
  brightness: normalized,
  isSilent: z.boolean(),
});

export const requestSchema = z.strictObject({
  prompt: z.string().max(500).trim().min(1),
  currentEffects: z.strictObject(effectNumbers).transform(clampEffects),
  audioFeatures: features,
  personalization: z.strictObject({ installationId, enabled: z.literal(true) }).optional(),
});

const textSchema = z.strictObject({
  mode: z.enum(['patch', 'reset', 'unsupported']),
  patch: patchSchema,
  summary: z.string().min(1).max(240),
  unsupported: z.array(z.string().min(1).max(100)).max(5),
  stemMode: z.enum(stemModes).optional(),
});

export const completionSchema = z.object({
  candidates: z.array(z.object({
    finishReason: z.literal('STOP'),
    content: z.object({
      parts: z.array(z.object({
        text: z.string().max(4096).optional(),
        thought: z.boolean().optional(),
      })).min(1),
    }),
  })).min(1),
});

const responseSchema = z.strictObject({
  mode: textSchema.shape.mode,
  patch: z.strictObject(Object.fromEntries(effectKeys.map(key => {
    const { min, max } = effectSpecs[key];
    return [key, z.number().min(min).max(max)];
  })) as Record<EffectKey, z.ZodNumber>).partial(),
  summary: z.string(),
  unsupported: z.array(z.string()).max(5),
  stemMode: textSchema.shape.stemMode,
});

const { $schema: _dialect, ...modelJsonSchema } = z.toJSONSchema(responseSchema);
export { modelJsonSchema };
export type InterpretRequest = Omit<z.output<typeof requestSchema>, 'personalization'>;

export function parseModelContent(content: string, current: InterpretRequest['currentEffects']) {
  if (!content || content.length > 4096) throw new Error('Invalid model content length.');
  return parseInterpretation(textSchema.parse(JSON.parse(content)), current);
}
