import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express, { type ErrorRequestHandler } from 'express';
import { interpret, ProxyError, type ModelConfig } from './interpret';
import { requestSchema } from './schema';

const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;

export function createApp(config: ModelConfig, fetcher: typeof fetch = fetch) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.vary('Origin');
    const origin = req.get('Origin');
    if (origin !== undefined && !extensionOrigin.test(origin)) {
      res.status(403).json({ error: 'Only Chrome extension origins may call the proxy from a browser.' });
      return;
    }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
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
      const result = await interpret(request.data, config, fetcher, controller.signal);
      if (!controller.signal.aborted) res.json(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ProxyError) res.status(error.status).json({ error: error.message });
      else res.status(500).json({ error: 'The local proxy could not interpret the request.' });
    }
  });

  const inputErrors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error.status === 413 ? 413 : error.status === 415 ? 415 : 400;
    res.status(status).json({ error: status === 413 ? 'Request body is too large.' : 'Send an uncompressed JSON body.' });
  };
  app.use(inputErrors);
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.1-flash-lite';
  const port = Number(process.env.PORT ?? 8787);
  if (port !== 8787) throw new Error('PORT must be 8787 to match the extension endpoint.');
  const app = createApp({ apiKey: process.env.GEMINI_API_KEY?.trim() || '', model });
  app.listen(port, '127.0.0.1', () => console.log(`MoodShift proxy ready at http://127.0.0.1:${port}`));
}
