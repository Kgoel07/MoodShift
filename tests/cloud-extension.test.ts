import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiErrorDetail, apiFeedback, apiRequest, demoCodeKey, stemStartMessage } from '../extension/src/api-client';
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
    await apiRequest('/api/memory', {}, signal, hybrid);
    expect(fetcher.mock.calls[1]).toEqual(['https://moodshift.example.com/api/memory',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + code }, redirect: 'error' })]);
    await expect(apiRequest('/api/memory', {}, signal, { ...cloud, apiBaseUrl: local.apiBaseUrl })).rejects.toThrow('HTTPS');
    read.mockResolvedValue({});
    await expect(apiRequest('/api/interpret', {}, signal, cloud)).rejects.toThrow('could not connect');
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

  it('distinguishes Vercel deployment protection from a MoodShift access-code error', async () => {
    const protectedReply = Response.json({ protection: {}, error: { code: '401' } }, { status: 401 });
    expect(await apiErrorDetail(protectedReply, cloud)).toMatch(/Vercel Deployment Protection.*production domain/);
    const demoReply = Response.json({ error: 'Enter the private demo access code.' }, { status: 401 });
    expect(await apiErrorDetail(demoReply, cloud)).toBe('Enter the private demo access code.');
    expect(await apiErrorDetail(new Response('<html>', { status: 502 }), cloud)).toMatch(/Cloud API returned HTTP 502/);
    expect(await apiErrorDetail(new Response('<html>', { status: 502 }), local)).toMatch(/Check the local proxy/);
  });

  it('keeps technical API failures in the console and shows plain guidance in the panel', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const failure = Response.json({ error: 'Start the local proxy with npm run dev:server.' }, { status: 503 });
      expect(await apiFeedback(failure, 'effects')).toBe('Gemini unavailable. Presets and manual controls still work.');
      expect(warn).toHaveBeenCalledWith('MoodShift request failed', 'Start the local proxy with npm run dev:server.');
      const unauthorized = Response.json({ error: 'Enter the private demo access code.' }, { status: 401 });
      expect(await apiFeedback(unauthorized, 'effects')).toBe('MoodShift could not connect. Check with whoever set up this installation.');
      const shared = Response.json({ error: 'This backend has no owner configured.' }, { status: 403 });
      expect(await apiFeedback(shared, 'preferences')).toBe('Supermemory isn’t available here.');
    } finally {
      warn.mockRestore();
    }
  });
});
