import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { appFromEnv } from './environment';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
const port = Number(process.env.PORT ?? 8787);
if (port !== 8787) throw new Error('Use port 8787 for the local MoodShift proxy.');
appFromEnv(process.env, 'local').listen(port, '127.0.0.1', () => {
  console.log(`MoodShift proxy ready at http://127.0.0.1:${port}`);
});
