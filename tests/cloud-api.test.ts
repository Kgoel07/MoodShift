import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { neutralEffects } from '../extension/src/shared/effects';
import { silentFeatures } from '../extension/src/shared/types';
import { accessFromEnv } from '../server/src/access';
import { createApp } from '../server/src/index';
import { createMemory } from '../server/src/memory';

const origin = 'chrome-extension://' + 'a'.repeat(32);
const otherOrigin = 'chrome-extension://' + 'b'.repeat(32);
const token = 'test-token-' + 'z'.repeat(32);
const owner = '48d6a9cd-bb63-4a3f-8036-1ca90c718c50';
const otherInstallation = '54c3a3ad-1228-443b-b625-084acf29a163';
const deployment = { MOODSHIFT_DEPLOYMENT: 'cloud-demo', ALLOWED_EXTENSION_ORIGINS: origin, DEMO_ACCESS_TOKEN: token };
const config = { apiKey: 'fake-gemini-key', model: 'test-model' };
const prompt = { prompt: 'More bass', currentEffects: neutralEffects, audioFeatures: silentFeatures };
const gemini = () => vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
  candidates: [{ finishReason: 'STOP', content: { parts: [{
    text: JSON.stringify({ mode: 'patch', patch: { bassDb: 2 }, summary: 'Added bass.', unsupported: [] }),
  }] } }],
}));

async function serve(app: ReturnType<typeof createApp>, run: (base: string) => Promise<void>) {
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    await run('http://127.0.0.1:' + (server.address() as AddressInfo).port);
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

function post(url: string, body: unknown, auth = token, browserOrigin = origin) {
  return fetch(url, {
    method: 'POST',
    headers: { Origin: browserOrigin, 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('cloud API deployment', () => {
  it('fails closed for missing or invalid deployment settings', () => {
    expect(() => accessFromEnv({}, 'cloud')).toThrow('MOODSHIFT_DEPLOYMENT');
    expect(() => accessFromEnv({ ...deployment, ALLOWED_EXTENSION_ORIGINS: '*' }, 'cloud')).toThrow('exact');
    expect(() => accessFromEnv({ ...deployment, DEMO_ACCESS_TOKEN: 'short' }, 'cloud')).toThrow('DEMO_ACCESS_TOKEN');
    expect(() => accessFromEnv({ ...deployment, MOODSHIFT_DEPLOYMENT: 'cloud-owner' }, 'cloud')).toThrow('CLOUD_MEMORY_INSTALLATION_ID');
    expect(accessFromEnv({ ALLOWED_EXTENSION_ORIGINS: origin + ', ' + otherOrigin }, 'local').origins)
      .toEqual(new Set([origin, otherOrigin]));
  });

  it('exports the production app without binding the local port', async () => {
    for (const [name, value] of Object.entries(deployment)) vi.stubEnv(name, value);
    vi.stubEnv('PORT', '12345');
    const { default: app } = await import('../index');
    await serve(app, async base => {
      expect((await fetch(base + '/health')).status).toBe(200);
      expect((await post(base + '/api/interpret', prompt, 'bad')).status).toBe(401);
      expect((await post(base + '/api/memory', { action: 'view', installationId: owner })).status).toBe(403);
    });
  });

  it('blocks wrong origins and credentials before parsing or spending quota on upstreams', async () => {
    const upstream = gemini();
    const sdk = vi.fn<typeof fetch>();
    await serve(createApp(config, upstream, createMemory('test-memory-key', sdk), accessFromEnv(deployment, 'cloud')), async base => {
      const endpoint = base + '/api/interpret';
      const options = await fetch(endpoint, { method: 'OPTIONS', headers: { Origin: origin } });
      expect(options.status).toBe(204);
      expect(options.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(options.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
      expect((await post(endpoint, prompt, token, otherOrigin)).status).toBe(403);
      expect((await post(endpoint, prompt, 'x'.repeat(43))).status).toBe(401);
      expect((await fetch(endpoint, { method: 'POST', body: 'invalid' })).status).toBe(401);
      expect((await post(base + '/api/memory', { action: 'clear', installationId: owner })).status).toBe(403);
      expect(upstream).not.toHaveBeenCalled();
      expect(sdk).not.toHaveBeenCalled();
      const response = await post(endpoint, { ...prompt, personalization: { enabled: true, installationId: owner } });
      expect(await response.json()).toMatchObject({ patch: { bassDb: 2 } });
      expect(sdk).not.toHaveBeenCalled();
      expect(await (await fetch(base + '/health')).text()).not.toMatch(/fake-gemini-key|test-token/);
    });
  });

  it('pins operator memory lookup and management to the configured installation', async () => {
    const sdk = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      profile: { static: [{ memory: 'Prefers bass.' }], dynamic: [] },
      documents: [{ content: 'Prefers bass.' }], pagination: { hasMore: false },
    }));
    const upstream = gemini();
    const policy = accessFromEnv({ ...deployment, MOODSHIFT_DEPLOYMENT: 'cloud-owner', CLOUD_MEMORY_INSTALLATION_ID: owner }, 'cloud');
    await serve(createApp(config, upstream, createMemory('test-memory-key', sdk), policy), async base => {
      for (const action of ['view', 'clear', 'remember']) {
        const body = { action, installationId: otherInstallation, ...(action === 'remember' ? { enabled: true, preference: 'Bass.' } : {}) };
        expect((await post(base + '/api/memory', body)).status).toBe(403);
      }
      expect((await post(base + '/api/interpret', { ...prompt, personalization: { enabled: true, installationId: otherInstallation } })).status).toBe(200);
      expect(sdk).not.toHaveBeenCalled();
      const reply = await post(base + '/api/memory', { action: 'view', installationId: owner });
      expect(await reply.json()).toEqual({ preferences: ['Prefers bass.'], hasMore: false });
      expect((await post(base + '/api/interpret', { ...prompt, personalization: { enabled: true, installationId: owner } })).status).toBe(200);
      expect(sdk).toHaveBeenCalledTimes(2);
    });
  });

  it('enforces a bounded authenticated per-instance quota before upstream requests', async () => {
    const upstream = gemini();
    await serve(createApp(config, upstream, undefined, accessFromEnv(deployment, 'cloud')), async base => {
      vi.spyOn(Date, 'now').mockReturnValue(0);
      try {
        for (let i = 0; i < 12; i++) expect((await post(base + '/api/interpret', prompt)).status).toBe(200);
        const limited = await post(base + '/api/interpret', prompt);
        expect(limited.status).toBe(429);
        expect(limited.headers.get('Retry-After')).toBe('60');
        expect(upstream).toHaveBeenCalledTimes(12);
        vi.mocked(Date.now).mockReturnValue(60_000);
        expect((await post(base + '/api/interpret', prompt)).status).toBe(200);
      } finally {
        vi.restoreAllMocks();
      }
    });
  });
});
