import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { installationIdPattern } from '../../extension/src/shared/preferences.js';

export const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;
const tokenFormat = /^[A-Za-z0-9_-]{32,128}$/;
type OriginPolicy = { origins: ReadonlySet<string> };
export type AccessPolicy =
  | { mode: 'local'; origins?: ReadonlySet<string> }
  | (OriginPolicy & { mode: 'cloud-demo'; token: string })
  | (OriginPolicy & { mode: 'cloud-owner'; token: string; installationId: string });

export function accessFromEnv(env: NodeJS.ProcessEnv, target: 'local' | 'cloud'): AccessPolicy {
  const supplied = env.ALLOWED_EXTENSION_ORIGINS?.trim();
  const origins = supplied ? new Set(supplied.split(',').map(origin => origin.trim())) : undefined;
  if (origins && [...origins].some(origin => !extensionOrigin.test(origin))) {
    throw new Error('ALLOWED_EXTENSION_ORIGINS must contain exact Chrome extension origins.');
  }
  if (target === 'local') return { mode: 'local', origins };
  const mode = env.MOODSHIFT_DEPLOYMENT;
  const token = env.DEMO_ACCESS_TOKEN ?? '';
  if (!origins?.size || !tokenFormat.test(token) || (mode !== 'cloud-demo' && mode !== 'cloud-owner')) {
    throw new Error('Set MOODSHIFT_DEPLOYMENT, ALLOWED_EXTENSION_ORIGINS and a 32–128 character URL-safe DEMO_ACCESS_TOKEN.');
  }
  if (mode === 'cloud-demo') return { mode, origins, token };
  const installationId = env.CLOUD_MEMORY_INSTALLATION_ID?.trim().toLowerCase();
  if (!installationId || !installationIdPattern.test(installationId)) {
    throw new Error('Set CLOUD_MEMORY_INSTALLATION_ID to the operator installation UUID.');
  }
  return { mode, origins, token, installationId };
}

const digest = (value: string) => createHash('sha256').update(value).digest();

export function demoGuard(token: string): RequestHandler {
  const expected = digest(token);
  const minute = { size: 60_000, limit: 12, bucket: -1, count: 0 };
  const day = { size: 86_400_000, limit: 250, bucket: -1, count: 0 };
  return (req, res, next) => {
    const supplied = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(req.get('Authorization') ?? '')?.[1];
    if (!supplied || !timingSafeEqual(digest(supplied), expected)) {
      res.status(401).json({ error: 'Enter the private demo access code in MoodShift settings.' });
      return;
    }
    const time = Date.now();
    for (const quota of [minute, day]) {
      const bucket = Math.floor(time / quota.size);
      if (bucket !== quota.bucket) {
        quota.bucket = bucket;
        quota.count = 0;
      }
      if (quota.count >= quota.limit) {
        res.set('Retry-After', String(Math.ceil(((bucket + 1) * quota.size - time) / 1000)));
        res.status(429).json({ error: 'The private demo request quota is exhausted. Try again later.' });
        return;
      }
    }
    minute.count++;
    day.count++;
    next();
  };
}
