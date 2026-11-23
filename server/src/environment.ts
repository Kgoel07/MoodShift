import { accessFromEnv } from './access.js';
import { createApp } from './index.js';

export function appFromEnv(env: NodeJS.ProcessEnv, target: 'local' | 'cloud') {
  const policy = accessFromEnv(env, target);
  const model = env.GEMINI_MODEL?.trim() || 'gemini-3.1-flash-lite';
  const apiKey = env.GEMINI_API_KEY?.trim() || '';
  return createApp({ apiKey, model }, fetch, policy);
}
