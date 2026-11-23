import { demoCodePattern, deployment, localStemWsUrl, usesCloudStems, type DeploymentConfig } from './shared/deployment';

export const demoCodeKey = 'moodshiftDemoAccessCode';
export const cloudAccessMessage = 'Online processing isn’t set up for this installation. Contact whoever provided MoodShift.';
export class CloudAccessError extends Error {}

export async function cloudDemoCode(config: DeploymentConfig = deployment): Promise<string | undefined> {
  if (config.mode !== 'production') return;
  const code = (await chrome.storage.local.get(demoCodeKey))[demoCodeKey];
  if (typeof code !== 'string' || !demoCodePattern.test(code)) {
    throw new CloudAccessError(cloudAccessMessage);
  }
  return code;
}

export async function apiRequest(path: '/api/interpret', body: unknown, signal: AbortSignal,
  config: DeploymentConfig = deployment): Promise<Response> {
  const code = await cloudDemoCode(config);
  const url = new URL(path, config.apiBaseUrl);
  if (code && url.protocol !== 'https:') throw new Error('Private demo codes require HTTPS.');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (code) headers.Authorization = `Bearer ${code}`;
  return fetch(url.href, {
    method: 'POST', headers, body: JSON.stringify(body), signal, credentials: 'omit', redirect: 'error',
  });
}

export function apiErrorDetail(response: Response): string {
  console.warn('MoodShift online processing returned an error', response.status);
  if (response.status === 401 || response.status === 403) return cloudAccessMessage;
  if (response.status === 429) return 'Too many requests right now. Try again in a moment.';
  if (response.status >= 500) return 'Online processing is unavailable right now. Try again shortly.';
  return 'Couldn’t apply that request. Try describing the sound again.';
}

export function stemStartMessage(sampleRate: number, sessionId: string, config: DeploymentConfig, code?: string) {
  if (usesCloudStems(config)) {
    if (!code || !demoCodePattern.test(code)) throw new Error('Cloud stems require a private demo code.');
    return { type: 'start', sampleRate, sessionId, token: code };
  }
  if (config.mode === 'production' && config.stemWsUrl !== localStemWsUrl) {
    throw new Error('Cloud stems require WSS.');
  }
  return { type: 'start', sampleRate, sessionId };
}
