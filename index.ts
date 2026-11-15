import type { Express } from 'express';
import { appFromEnv } from './server/src/environment.js';

export const config = { maxDuration: 30 };
const app: Express = appFromEnv(process.env, 'cloud');
export default app;
