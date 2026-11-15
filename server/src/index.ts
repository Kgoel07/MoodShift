import express, { type ErrorRequestHandler } from 'express';
import { interpret, ProxyError, type ModelConfig } from './interpret';
import { requestSchema } from './schema';
import { MemoryError, memoryRequest, type Memory } from './memory';
import { demoGuard, extensionOrigin, type AccessPolicy } from './access';

export function createApp(config: ModelConfig, fetcher: typeof fetch = fetch, memory?: Memory,
  policy: AccessPolicy = { mode: 'local' }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.vary('Origin');
    const origin = req.get('Origin');
    if (origin !== undefined && (!extensionOrigin.test(origin) || (policy.origins && !policy.origins.has(origin)))) {
      res.status(403).json({ error: 'This browser origin is not allowed.' });
      return;
    }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', policy.mode === 'local' ? 'Content-Type' : 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(origin ? 204 : 403);
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, aiConfigured: Boolean(config.apiKey), model: config.model });
  });
  if (policy.mode !== 'local') app.use('/api', demoGuard(policy.token));

  app.post('/api/interpret', express.json({ limit: '8kb', inflate: false }), async (req, res) => {
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Send application/json.' });
      return;
    }
    const request = requestSchema.safeParse(req.body);
    if (!request.success) {
      res.status(400).json({ error: 'Provide a 1–500 character prompt, all effect values, and bounded audio features.' });
      return;
    }
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const { personalization, ...audioRequest } = request.data;
      const memoryAllowed = policy.mode === 'local'
        || (policy.mode === 'cloud-owner' && personalization?.installationId === policy.installationId);
      const preferences = config.apiKey && memoryAllowed && personalization?.enabled
        ? await memory?.context(personalization.installationId, controller.signal) : undefined;
      if (controller.signal.aborted) return;
      const result = await interpret(audioRequest, config, fetcher, controller.signal, preferences);
      if (!controller.signal.aborted) res.json(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ProxyError) res.status(error.status).json({ error: error.message });
      else res.status(500).json({ error: 'The local proxy could not interpret the request.' });
    }
  });

  app.post('/api/memory', (req, res, next) => {
    if (policy.mode === 'cloud-demo') {
      res.status(403).json({ error: 'Personalization is available only on the local or single-operator backend.' });
      return;
    }
    next();
  }, express.json({ limit: '2kb', inflate: false }), async (req, res) => {
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Send application/json.' });
      return;
    }
    const request = memoryRequest.safeParse(req.body);
    if (!request.success) {
      res.status(400).json({ error: 'Provide a valid installation ID and preference action. A preference must be a single line.' });
      return;
    }
    if (policy.mode === 'cloud-owner' && request.data.installationId !== policy.installationId) {
      res.status(403).json({ error: 'This installation cannot access cloud preferences.' });
      return;
    }
    if (!memory) {
      res.status(503).json({ error: policy.mode === 'local'
        ? 'Set SUPERMEMORY_API_KEY in server/.env and restart the proxy.'
        : 'Supermemory is not configured on this backend.' });
      return;
    }
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const result = await memory.manage(request.data, controller.signal);
      if (!controller.signal.aborted) res.json(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof MemoryError) res.status(error.status).json({ error: error.message });
      else res.status(500).json({ error: 'The proxy could not complete the preference action.' });
    }
  });

  const inputErrors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error.status === 413 ? 413 : error.status === 415 ? 415 : 400;
    res.status(status).json({ error: status === 413 ? 'Request body is too large.' : 'Send an uncompressed JSON body.' });
  };
  app.use(inputErrors);
  return app;
}
