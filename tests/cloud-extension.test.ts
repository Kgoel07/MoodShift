import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiErrorDetail, apiRequest, demoCodeKey, stemStartMessage } from '../extension/src/api-client';
import { deploymentFromEnv, usesCloudStems } from '../extension/src/shared/deployment';

const env = { API_BASE_URL: 'https://moodshift.example.com', STEM_WS_URL: 'wss://stems.example.com/stem' };
const local = deploymentFromEnv('development', {});
const cloud = deploymentFromEnv('production', env);
const hybrid = deploymentFromEnv('production', { ...env, STEM_WS_URL: local.stemWsUrl });
const code = 'test-code-' + 'z'.repeat(32);

afterEach(() => vi.unstubAllGlobals());

describe('extension deployment settings', () => {
  it('uses fixed local defaults and validates secure remote URLs and buffer bounds', () => {
    expect(local).toEqual({
      mode: 'development', apiBaseUrl: 'http://127.0.0.1:8787', stemWsUrl: 'ws://127.0.0.1:8788', stemDelaySeconds: 2.8,
    });
    expect(cloud).toMatchObject({ stemDelaySeconds: 4.5, stemWsUrl: env.STEM_WS_URL });
    expect(() => deploymentFromEnv('production', {})).toThrow('API_BASE_URL');
    expect(() => deploymentFromEnv('preview', env)).toThrow('Build mode');
    for (const bad of ['http://moodshift.example.com', 'https://127.0.0.1', 'https://x.internal',
      'https://moodshift.example.com/extra', 'https://moodshift.example.com/x/..',
      'https://user@moodshift.example.com', 'https://moodshift.example.com?key=1',
      'https://moodshift.example.com:9443']) {
      expect(() => deploymentFromEnv('production', { ...env, API_BASE_URL: bad })).toThrow('API_BASE_URL');
    }
    expect(() => deploymentFromEnv('production', { ...env, STEM_WS_URL: 'ws://stems.example.com' })).toThrow('STEM_WS_URL');
    expect(() => deploymentFromEnv('development', { STEM_WS_URL: 'ws://stems.example.com' })).toThrow('STEM_WS_URL');
    for (const bad of ['NaN', '2.7', '8.1', '4.59']) {
      expect(() => deploymentFromEnv('production', { ...env, STEM_DELAY_SECONDS: bad })).toThrow('STEM_DELAY_SECONDS');
    }
    expect(deploymentFromEnv('production', { ...env, STEM_DELAY_SECONDS: '8.0' }).stemDelaySeconds).toBe(8);
  });

  it('reads demo authentication only for cloud requests and sends it only over HTTPS', async () => {
    const read = vi.fn().mockResolvedValue({ [demoCodeKey]: code });
    vi.stubGlobal('chrome', { storage: { local: { get: read } } });
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    const signal = new AbortController().signal;
    await apiRequest('/api/interpret', {}, signal, local);
    expect(read).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBeUndefined();
    await apiRequest('/api/interpret', {}, signal, hybrid);
    expect(fetcher.mock.calls[1]).toEqual(['https://moodshift.example.com/api/interpret',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + code }, redirect: 'error' })]);
    await expect(apiRequest('/api/interpret', {}, signal, { ...cloud, apiBaseUrl: local.apiBaseUrl })).rejects.toThrow('HTTPS');
    read.mockResolvedValue({});
    await expect(apiRequest('/api/interpret', {}, signal, cloud)).rejects.toThrow('Online processing');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the legacy start message and only includes a valid cloud code on WSS', () => {
    expect(stemStartMessage(48000, 'abc', local, code)).toEqual({ type: 'start', sampleRate: 48000, sessionId: 'abc' });
    expect(stemStartMessage(48000, 'abc', hybrid, code)).toEqual({ type: 'start', sampleRate: 48000, sessionId: 'abc' });
    expect(stemStartMessage(48000, 'abc', cloud, code)).toMatchObject({ token: code });
    expect(() => stemStartMessage(48000, 'abc', cloud)).toThrow();
    expect(() => stemStartMessage(48000, 'abc', { ...cloud, stemWsUrl: 'ws://stems.example.com' }, code)).toThrow();
  });

  it('allows the fixed loopback stem helper alongside a production HTTPS API', () => {
    expect(hybrid).toMatchObject({ apiBaseUrl: env.API_BASE_URL, stemWsUrl: local.stemWsUrl });
    expect(usesCloudStems(hybrid)).toBe(false);
    expect(usesCloudStems(cloud)).toBe(true);
    for (const stemUrl of ['ws://127.0.0.1:8789', 'ws://localhost:8788', 'ws://127.0.0.1:8788/stem']) {
      expect(() => deploymentFromEnv('production', { ...env, STEM_WS_URL: stemUrl })).toThrow('STEM_WS_URL');
    }
  });

  it('uses plain language for access, rate and service errors', () => {
    const unauthorized = Response.json({ error: 'Internal diagnostic' }, { status: 401 });
    expect(apiErrorDetail(unauthorized)).toContain('Contact whoever provided MoodShift');
    expect(apiErrorDetail(new Response(null, { status: 429 }))).toContain('Try again in a moment');
    expect(apiErrorDetail(new Response(null, { status: 502 }))).toContain('unavailable right now');
  });
});
