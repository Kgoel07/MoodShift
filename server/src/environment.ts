import { accessFromEnv } from './access.js';
import { createApp } from './index.js';
import { createMemory } from './memory.js';

export function appFromEnv(env: NodeJS.ProcessEnv, target: 'local' | 'cloud') {
  const policy = accessFromEnv(env, target);
  const model = env.GEMINI_MODEL?.trim() || 'gemini-3.1-flash-lite';
  const apiKey = env.GEMINI_API_KEY?.trim() || '';
  const memory = policy.mode === 'cloud-demo' ? undefined : createMemory(env.SUPERMEMORY_API_KEY);
  return createApp({ apiKey, model }, fetch, memory, policy);
}
