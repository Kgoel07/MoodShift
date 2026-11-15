export const demoCodePattern = /^[A-Za-z0-9_-]{32,128}$/;
export const localStemWsUrl = 'ws://127.0.0.1:8788';
export type DeploymentConfig = {
  mode: 'development' | 'production';
  apiBaseUrl: string;
  stemWsUrl: string;
  stemDelaySeconds: number;
};

const dnsName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function endpoint(raw: string, name: string, protocol: string, local: boolean, forStems: boolean): URL {
  const invalid = new Error(`${name} must be a ${protocol} endpoint on ${local ? '127.0.0.1' : 'a specific public DNS hostname'}.`);
  let url: URL;
  try { url = new URL(raw); } catch { throw invalid; }
  if (raw !== raw.trim() || !raw.startsWith(protocol + '//') || url.protocol !== protocol
    || url.username || url.password || /[\s?#\\@]/.test(raw)
    || (url.pathname !== '/' && !(forStems && !local && url.pathname === '/stem'))) throw invalid;
  if (raw !== url.origin && raw !== url.href) throw invalid;
  if (local) {
    if (url.hostname !== '127.0.0.1' || (forStems ? Number(url.port) < 1024 : url.port !== '8787')) throw invalid;
  } else if (url.port || !dnsName.test(url.hostname) || /\.(local|localhost|internal)$/.test(url.hostname)) {
    throw invalid;
  }
  return url;
}

export function deploymentFromEnv(mode: string, env: Record<string, string | undefined>): DeploymentConfig {
  if (mode !== 'development' && mode !== 'production') throw new Error('Build mode must be development or production.');
  const local = mode === 'development';
  const api = endpoint(env.API_BASE_URL ?? (local ? 'http://127.0.0.1:8787' : ''),
    'API_BASE_URL', local ? 'http:' : 'https:', local, false);
  const stemUrl = env.STEM_WS_URL ?? (local ? localStemWsUrl : '');
  const localStem = local || stemUrl === localStemWsUrl || stemUrl === localStemWsUrl + '/';
  const stems = endpoint(stemUrl, 'STEM_WS_URL', localStem ? 'ws:' : 'wss:', localStem, true);
  const delay = env.STEM_DELAY_SECONDS === undefined ? (local ? 2.8 : 4.5) : Number(env.STEM_DELAY_SECONDS);
  if (!Number.isFinite(delay) || delay < 2.8 || delay > 8 || Math.round(delay * 10) / 10 !== delay) {
    throw new Error('STEM_DELAY_SECONDS must be 2.8 to 8.0 seconds in tenths.');
  }
  return {
    mode, apiBaseUrl: api.origin, stemWsUrl: stems.origin + (stems.pathname === '/' ? '' : stems.pathname),
    stemDelaySeconds: delay,
  };
}

declare const __MOODSHIFT_DEPLOYMENT__: DeploymentConfig;
export const deployment = typeof __MOODSHIFT_DEPLOYMENT__ === 'undefined'
  ? deploymentFromEnv('development', {}) : __MOODSHIFT_DEPLOYMENT__;

export function usesCloudStems(config = deployment): boolean {
  return config.stemWsUrl.startsWith('wss://');
}
