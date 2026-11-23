import { z } from 'zod';
import { clampEffects, effectKeys, effectSpecs, type EffectKey } from '../../extension/src/shared/effects.js';
import { parseInterpretation, stemModes } from '../../extension/src/shared/types.js';
import { preferenceContextLimit, preferenceLimit, preferenceTextPattern } from '../../extension/src/shared/preferences.js';
import { controlActionLimit, controlIds, controlOperations, controlPresetLimit, parseControlResult } from '../../extension/src/shared/controls.js';
import { homeSectionKeys } from '../../extension/src/shared/home-layout.js';
import { lyricOffsetRange } from '../../extension/src/shared/display-settings.js';
import { validateReverb } from '../../extension/src/shared/reverb.js';
import { validateTuning } from '../../extension/src/shared/tuning.js';
import { voiceMaxBytes, voiceMimeTypes } from '../../extension/src/shared/voice-audio.js';

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
  localPreferences: z.array(z.string().trim().max(preferenceLimit).regex(preferenceTextPattern)).max(preferenceContextLimit).optional(),
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
export type InterpretRequest = Omit<z.output<typeof requestSchema>, 'localPreferences'>;

function settings<T>(validate: (input: unknown) => T) {
  return z.unknown().transform((input, ctx) => {
    try { return validate(input); }
    catch { ctx.addIssue({ code: 'custom', message: 'Invalid audio settings.' }); return z.NEVER; }
  });
}

const names = z.array(z.string().trim().min(1).max(64).regex(/^[^\u0000-\u001f\u007f]+$/)).max(controlPresetLimit);
export const controlRequestSchema = requestSchema.extend({
  controls: z.strictObject({
    tuning: settings(validateTuning),
    reverb: settings(validateReverb),
    monitor: z.enum(['original', 'modified']),
    stemMode: z.enum(stemModes),
    display: z.strictObject({
      home: z.strictObject(Object.fromEntries(homeSectionKeys.map(key => [key, z.boolean()])) as Record<typeof homeSectionKeys[number], z.ZodBoolean>),
      lyricsOffset: z.number().min(lyricOffsetRange.min).max(lyricOffsetRange.max),
      lyricsFollow: z.boolean(), lyricsOpen: z.boolean(), chordsOpen: z.boolean(),
    }),
    savedEq: names, savedAudio: names,
    youtubeWatch: z.boolean(),
  }),
});
export type ControlRequest = Omit<z.output<typeof controlRequestSchema>, 'localPreferences'>;
export const voiceRequestSchema = controlRequestSchema.omit({ prompt: true }).extend({
  audio: z.strictObject({
    mimeType: z.enum(voiceMimeTypes),
    data: z.string().min(8).max(4 * Math.ceil(voiceMaxBytes / 3)).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }).refine(({ mimeType, data }) => {
    const bytes = Buffer.from(data, 'base64');
    const signature = mimeType === 'audio/webm' ? '1a45dfa3' : '4f676753';
    return bytes.length <= voiceMaxBytes && bytes.subarray(0, 4).toString('hex') === signature && bytes.toString('base64') === data;
  }, 'Invalid voice recording.'),
});
export type VoiceRequest = Omit<z.output<typeof voiceRequestSchema>, 'localPreferences'>;

export const controlModelJsonSchema = {
  type: 'object', additionalProperties: false, required: ['actions', 'summary', 'unsupported'],
  properties: {
    actions: { type: 'array', maxItems: controlActionLimit, items: {
      type: 'object', additionalProperties: false, required: ['control', 'operation'],
      properties: {
        control: { type: 'string', enum: controlIds },
        operation: { type: 'string', enum: controlOperations },
        value: { anyOf: [{ type: 'number' }, { type: 'boolean' }, { type: 'string' }] },
        frequency: { type: 'number' },
      },
    } },
    summary: { type: 'string' },
    unsupported: { type: 'array', maxItems: 5, items: { type: 'string' } },
  },
};

export function parseControlContent(content: string) {
  if (!content || content.length > 4096) throw new Error('Invalid model content length.');
  return parseControlResult(JSON.parse(content));
}

export const voiceModelJsonSchema = {
  ...controlModelJsonSchema,
  required: [...controlModelJsonSchema.required, 'transcript'],
  properties: { ...controlModelJsonSchema.properties, transcript: { type: 'string' } },
};

export function parseVoiceContent(content: string) {
  if (!content || content.length > 4096) throw new Error('Invalid model content length.');
  const { transcript, ...plan } = JSON.parse(content);
  const result = parseControlResult(plan);
  if (typeof transcript !== 'string' || transcript.length > 500 || (!transcript.trim() && result.actions.length)) {
    throw new Error('Invalid transcript.');
  }
  return { ...result, transcript: transcript.trim() };
}

export function parseModelContent(content: string, current: InterpretRequest['currentEffects']) {
  if (!content || content.length > 4096) throw new Error('Invalid model content length.');
  return parseInterpretation(textSchema.parse(JSON.parse(content)), current);
}
