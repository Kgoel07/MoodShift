export const voiceMimeTypes = ['audio/webm', 'audio/ogg'] as const;
export const voiceMaxBytes = 96 * 1024;
export const voiceMaxSeconds = 8;
export type VoiceAudio = { mimeType: typeof voiceMimeTypes[number]; data: string };
