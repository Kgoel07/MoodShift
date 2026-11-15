import { demoCodePattern, deployment, localStemWsUrl, usesCloudStems, type DeploymentConfig } from './shared/deployment';

export const demoCodeKey = 'moodshiftDemoAccessCode';

export class DemoAccessRequired extends Error {
  constructor() { super('MoodShift could not connect. Check with whoever set up this installation.'); }
}

export async function cloudDemoCode(config: DeploymentConfig = deployment): Promise<string | undefined> {
  if (config.mode !== 'production') return;
  const code = (await chrome.storage.local.get(demoCodeKey))[demoCodeKey];
  if (typeof code !== 'string' || !demoCodePattern.test(code)) {
    throw new DemoAccessRequired();
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

export async function apiFeedback(response: Response, feature: 'effects' | 'preferences'): Promise<string> {
  const detail = await apiErrorDetail(response);
  console.warn('MoodShift request failed', detail);
  if (response.status === 401 && /access code/i.test(detail)) return new DemoAccessRequired().message;
  if (response.status === 429) return 'Too many requests. Try again in a moment.';
  if (response.status === 504) return 'That took too long. Try again.';
  if (feature === 'preferences') {
    return response.status === 403 ? 'Supermemory isn’t available here.' : 'Could not update Supermemory. Try again.';
  }
  if (response.status >= 500 || response.status === 401 || response.status === 403) {
    return 'Gemini unavailable. Presets and manual controls still work.';
  }
  return 'Could not apply your request. Try rephrasing it.';
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
