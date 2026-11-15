import { demoCodePattern, deployment, localStemWsUrl, usesCloudStems, type DeploymentConfig } from './shared/deployment';

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

export async function apiErrorDetail(response: Response, config = deployment): Promise<string> {
  const body = await response.json().catch(() => undefined);
  if (typeof body?.error === 'string') return body.error.slice(0, 240);
  if (config.mode === 'development') return `Check the local proxy (HTTP ${response.status}).`;
  if (response.status === 401 && body?.protection != null) {
    return 'Vercel Deployment Protection blocked the request. Use the production domain where /health works without a Vercel login.';
  }
  return `Cloud API returned HTTP ${response.status}. Check /health on the configured production domain.`;
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
