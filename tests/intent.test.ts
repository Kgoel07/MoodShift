import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { applyPatch, neutralEffects } from '../extension/src/shared/effects';
import { silentFeatures } from '../extension/src/shared/types';
import { createApp } from '../server/src/index';
import { interpret } from '../server/src/interpret';

const config = { apiKey: 'test-key', model: 'gemini-3.1-flash-lite' };
const currentEffects = { ...neutralEffects, bassDb: 1, reverbMix: 0.30, trebleDb: -2 };
const request = { prompt: 'A little more bass, keep the reverb', currentEffects, audioFeatures: silentFeatures };
const relative = { mode: 'patch', patch: { bassDb: 3 }, summary: 'Added a little bass.', unsupported: [] };
const completion = (result: unknown) => Response.json({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(result) }] } }],
});

describe('Gemini HTTP adapter', () => {
  it('requests a structured relative patch with current effects and metrics, and preserves reverb', async () => {
    const upstream = vi.fn<typeof fetch>(async () => completion(relative));
    const result = await interpret(request, config, upstream);
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
    expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'test-key' });
    const payload = JSON.parse(String(init?.body));
    expect(payload.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      responseJsonSchema: { additionalProperties: false, required: ['mode', 'patch', 'summary', 'unsupported'] },
    });
    expect(JSON.parse(payload.contents[0].parts[0].text)).toEqual(request);
    expect(payload.systemInstruction.parts[0].text).toMatch(/absolute targets.*unmentioned parameters/s);
    expect(applyPatch(currentEffects, result.patch)).toEqual({ ...currentEffects, bassDb: 3 });
  });

  it('keeps unsupported-only and mixed intents distinct and supports reset', async () => {
    const unsupported = { mode: 'unsupported', patch: {}, summary: 'Playback speed is unavailable.', unsupported: ['Slow playback'] };
    const reset = { mode: 'reset', patch: {}, summary: 'Reset effects.', unsupported: [] };
    const mixed = { ...relative, unsupported: ['Remove vocals'] };
    for (const result of [unsupported, reset, mixed]) {
      expect(await interpret(request, config, async () => completion(result))).toEqual(result);
    }
  });

  it.each([401, 402, 403, 404, 429, 500])('maps upstream HTTP %i to a useful error without leaking details', async status => {
    await expect(interpret(request, config, async () => new Response('private upstream body', { status })))
      .rejects.toMatchObject({ status: status === 429 ? 429 : status === 500 ? 502 : 503 });
  });

  it('handles invalid envelopes and syntax as upstream failures', async () => {
    await expect(interpret(request, config, async () => new Response('<html>')))
      .rejects.toMatchObject({ status: 502 });
    await expect(interpret(request, config, async () => Response.json({ promptFeedback: { blockReason: 'SAFETY' } })))
      .rejects.toMatchObject({ status: 502 });
  });

  it('joins the final text parts and skips thought parts', async () => {
    const text = JSON.stringify(relative);
    const parts = [{ thought: true, text: 'Internal reasoning' }, { text: text.slice(0, 20) }, { text: text.slice(20) }];
    await expect(interpret(request, config, async () => Response.json({
      candidates: [{ finishReason: 'STOP', content: { parts } }],
    }))).resolves.toEqual(relative);
  });

  it.each(['MAX_TOKENS', 'SAFETY'])('rejects a candidate terminated with %s', async finishReason => {
    await expect(interpret(request, config, async () => Response.json({
      candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(relative) }] } }],
    }))).rejects.toMatchObject({ status: 502 });
  });

  it('enforces a 13-second provider deadline', async () => {
    const signal = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal.signal);
    try {
      const result = interpret(request, config, async (_url, init) => {
        signal.abort(new DOMException('Timeout', 'TimeoutError'));
        init?.signal?.throwIfAborted();
        throw new Error('Expected an aborted signal.');
      });
      await expect(result).rejects.toMatchObject({ status: 504 });
      expect(timeout).toHaveBeenCalledWith(13000);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe('Express proxy', () => {
  it('serves health and interpretation, bounds bodies, and rejects non-extension origins', async () => {
    const upstream = vi.fn<typeof fetch>(async () => completion(relative));
    const server = createApp(config, upstream).listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const endpoint = url + '/api/interpret';
      const origin = 'chrome-extension://' + 'a'.repeat(32);
      expect(await (await fetch(url + '/health')).json()).toEqual({ ok: true, aiConfigured: true, model: config.model });
      const preflight = await fetch(endpoint, { method: 'OPTIONS', headers: { Origin: origin } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      const post = (body: string, Origin = origin) => fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin }, body,
      });
      expect((await post(JSON.stringify(request), 'https://example.com')).status).toBe(403);
      expect((await post(JSON.stringify({ prompt: 'a'.repeat(9000) }))).status).toBe(413);
      expect((await post('{')).status).toBe(400);
      expect((await post(JSON.stringify({ ...request, prompt: ' '.repeat(3) }))).status).toBe(400);
      const response = await post(JSON.stringify(request));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(relative);
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('returns a recoverable error when the API key is absent', async () => {
    const upstream = vi.fn<typeof fetch>();
    await expect(interpret(request, { ...config, apiKey: '' }, upstream)).rejects.toMatchObject({ status: 503 });
    expect(upstream).not.toHaveBeenCalled();
  });
});
