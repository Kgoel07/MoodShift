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

export async function apiRequest(path: '/api/interpret' | '/api/interpret/v2' | '/api/interpret/voice', body: unknown, signal: AbortSignal,
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

const apiErrors: Record<string, string> = {
  origin_denied: 'This browser’s extension ID is missing from the backend’s allowed origins.',
  gemini_not_configured: 'The backend is missing GEMINI_API_KEY. Set it and restart or redeploy the backend.',
  gemini_access: 'Google rejected the Gemini key or model. Check key access and GEMINI_MODEL on the backend.',
  gemini_quota: 'Gemini quota reached. Check the Google AI Studio project limits and try again later.',
  gemini_busy: 'The configured Gemini model is temporarily busy. Try again shortly.',
  gemini_request: 'Google rejected the request. Check that GEMINI_MODEL supports structured output and audio for voice commands.',
  gemini_network: 'The backend could not reach Gemini. Try again shortly.',
  gemini_timeout: 'Gemini timed out. Try again.',
  gemini_response: 'Gemini returned an unusable response. Try a shorter command.',
  gemini_upstream: 'Gemini returned a temporary service error. Try again shortly.',
};

export const olderBackendMessage = 'Pitch and other newer commands need an updated MoodShift backend. Redeploy the API from the current branch.';

export async function apiErrorDetail(response: Response, config = deployment): Promise<string> {
  const json = response.headers.get('Content-Type')?.includes('application/json');
  if (json) {
    const payload = await response.json().catch(() => null);
    if (typeof payload?.code === 'string' && Object.hasOwn(apiErrors, payload.code)) return apiErrors[payload.code];
  }
  if ((response.status === 401 || response.status === 403) && !json && config.mode === 'production') {
    return 'The API returned a sign-in or access page. Use the Vercel domain where /health opens without a login.';
  }
  if (response.status === 401) return cloudAccessMessage;
  if (response.status === 403) return apiErrors.origin_denied;
  if (response.status === 429) return 'Too many requests right now. Try again in a moment.';
  if (response.status === 504) return apiErrors.gemini_timeout;
  if (response.status === 413) return 'The recording is too large. Try a shorter command.';
  if (response.status === 503 && !json) return 'The API could not start. Check the Vercel deployment logs and environment variables.';
  if (response.status >= 500) return 'Online processing is unavailable right now. Try again shortly.';
  return 'Couldn’t apply that request. Try describing the sound again.';
}

export async function apiConnectionDetail(signal: AbortSignal, config = deployment): Promise<string> {
  try {
    const response = await fetch(new URL('/health', config.apiBaseUrl).href, {
      credentials: 'omit', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
    });
    if (config.mode === 'production' && (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403)) {
      return 'The API requires a browser login. Use the Vercel domain where /health opens without a login.';
    }
    if (response.ok) {
      const health = await response.json();
      if (health.aiConfigured === false) return apiErrors.gemini_not_configured;
      if (health.ok === true && !response.headers.has('X-MoodShift-Controls')) return olderBackendMessage;
      return 'The backend responds, but the command request failed. Check the extension origin allowlist and try again.';
    }
  } catch { signal.throwIfAborted(); }
  return config.mode === 'development'
    ? 'Gemini unavailable. Start the local MoodShift proxy with npm run dev:server.'
    : 'Gemini unavailable. Check the configured API URL and open /health on that domain.';
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
