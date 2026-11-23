import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { interpret, interpretControls, interpretVoice, ProxyError, type ModelConfig } from './interpret.js';
import { controlRequestSchema, requestSchema, voiceRequestSchema } from './schema.js';
import { demoGuard, extensionOrigin, type AccessPolicy } from './access.js';

export function createApp(config: ModelConfig, fetcher: typeof fetch = fetch,
  policy: AccessPolicy = { mode: 'local' }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.vary('Origin');
    const origin = req.get('Origin');
    if (origin !== undefined && (!extensionOrigin.test(origin) || (policy.origins && !policy.origins.has(origin)))) {
      res.status(403).json({ error: 'This browser origin is not allowed.', code: 'origin_denied' });
      return;
    }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', policy.mode === 'local' ? 'Content-Type' : 'Content-Type, Authorization');
      res.set('Access-Control-Expose-Headers', 'X-MoodShift-Controls, X-MoodShift-Voice');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(origin ? 204 : 403);
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.set('X-MoodShift-Controls', '2');
    res.set('X-MoodShift-Voice', '1');
    res.json({ ok: true, aiConfigured: Boolean(config.apiKey), model: config.model });
  });
  if (policy.mode !== 'local') app.use('/api', demoGuard(policy.token));

  const handleInterpretation = <T extends { localPreferences?: string[] }>(schema: ZodType<T>,
    run: (request: Omit<T, 'localPreferences'>, config: ModelConfig, fetcher: typeof fetch,
      signal: AbortSignal, preferences: string[]) => Promise<unknown>): RequestHandler => async (req, res) => {
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Send application/json.' });
      return;
    }
    const request = schema.safeParse(req.body);
    if (!request.success) {
      res.status(400).json({ error: 'Provide a valid command and current audio settings.', code: 'invalid_command' });
      return;
    }
    if (policy.mode !== 'local' && !config.apiKey) {
      res.status(503).json({ error: 'Gemini is not configured on this cloud backend.', code: 'gemini_not_configured' });
      return;
    }
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const { localPreferences = [], ...audioRequest } = request.data;
      const preferences = [...new Set(localPreferences)];
      const result = await run(audioRequest, config, fetcher, controller.signal, preferences);
      if (!controller.signal.aborted) res.json(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ProxyError) res.status(error.status).json({ error: error.message, code: error.code });
      else res.status(500).json({ error: 'The MoodShift proxy could not interpret the request.' });
    }
  };
  app.post('/api/interpret', express.json({ limit: '8kb', inflate: false }), handleInterpretation(requestSchema, interpret));
  app.post('/api/interpret/v2', express.json({ limit: '12kb', inflate: false }), handleInterpretation(controlRequestSchema, interpretControls));
  app.post('/api/interpret/voice', express.json({ limit: '144kb', inflate: false }), handleInterpretation(voiceRequestSchema, interpretVoice));

  const inputErrors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error.status === 413 ? 413 : error.status === 415 ? 415 : 400;
    res.status(status).json({ error: status === 413 ? 'Request body is too large.' : 'Send an uncompressed JSON body.' });
  };
  app.use(inputErrors);
  return app;
}
