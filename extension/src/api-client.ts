import { demoCodePattern, deployment, type DeploymentConfig } from './shared/deployment';

export const demoCodeKey = 'moodshiftDemoAccessCode';

export async function cloudDemoCode(config: DeploymentConfig = deployment): Promise<string | undefined> {
  if (config.mode !== 'production') return;
  const code = (await chrome.storage.local.get(demoCodeKey))[demoCodeKey];
  if (typeof code !== 'string' || !demoCodePattern.test(code)) {
    throw new Error('Enter the private demo access code in MoodShift settings.');
  }
  return code;
}

export async function apiRequest(path: '/api/interpret' | '/api/memory', body: unknown, signal: AbortSignal,
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

export function stemStartMessage(sampleRate: number, sessionId: string, config: DeploymentConfig, code?: string) {
  if (config.mode === 'production') {
    if (new URL(config.stemWsUrl).protocol !== 'wss:' || !code || !demoCodePattern.test(code)) {
      throw new Error('Cloud stems require WSS and a private demo code.');
    }
    return { type: 'start', sampleRate, sessionId, token: code };
  }
  return { type: 'start', sampleRate, sessionId };
}
