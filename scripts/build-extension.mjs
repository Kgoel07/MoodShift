import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
import { build } from 'esbuild';
import { deploymentFromEnv } from '../extension/src/shared/deployment.ts';

const dir = new URL('../extension/', import.meta.url);
const { values } = parseArgs({
  options: { mode: { type: 'string', default: 'development' }, outdir: { type: 'string' }, 'env-file': { type: 'string' } },
});
const envFile = values['env-file'] ?? new URL('.env.local', dir);
const fileEnv = values.mode === 'production'
  ? parse(await readFile(envFile, 'utf8').catch(error => {
      if (values['env-file'] !== undefined || error.code !== 'ENOENT') throw error;
      return '';
    }))
  : {};
const config = deploymentFromEnv(values.mode, { ...process.env, ...fileEnv });
const outdir = resolve(values.outdir ?? (config.mode === 'production' ? 'extension/dist-cloud' : 'extension/dist'));
const workspacePath = relative(process.cwd(), outdir);
if (!workspacePath || workspacePath.startsWith('..') || isAbsolute(workspacePath)) {
  throw new Error('Choose a build output directory inside the MoodShift project.');
}
const manifest = JSON.parse(await readFile(new URL('manifest.json', dir), 'utf8'));
if (config.mode === 'production') {
  const wsOrigin = new URL(config.stemWsUrl).origin;
  manifest.host_permissions = [
    ...manifest.host_permissions.filter(pattern => pattern !== 'http://127.0.0.1/*'),
    config.apiBaseUrl + '/*', wsOrigin + '/*',
  ];
  manifest.content_security_policy.extension_pages += ` connect-src 'self' ${config.apiBaseUrl} ${wsOrigin} https://lrclib.net https://widget.songle.jp`;
}
await mkdir(outdir, { recursive: true });
await mkdir(resolve(outdir, 'assets'), { recursive: true });
await build({
  entryPoints: ['background', 'offscreen', 'sidepanel', 'domain', 'voice', 'stem-worker', 'stem-worklet', 'youtube-playback']
    .map(name => `extension/src/${name}.ts`),
  outdir,
  define: { __MOODSHIFT_DEPLOYMENT__: JSON.stringify(config) },
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  logLevel: 'info',
});
await Promise.all([
  copyFile(fileURLToPath(import.meta.resolve('signalsmith-stretch')), resolve(outdir, 'pitch-processor.mjs')),
  copyFile(new URL('../docs/SIGNALSMITH_LICENSE.txt', import.meta.url), resolve(outdir, 'SIGNALSMITH_LICENSE.txt')),
  ...Object.values(manifest.icons).map(path => copyFile(new URL(path, dir), resolve(outdir, path))),
  config.mode === 'production'
    ? writeFile(resolve(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    : copyFile(new URL('manifest.json', dir), resolve(outdir, 'manifest.json')),
  ...['offscreen.html', 'sidepanel.html', 'sidepanel.css', 'domain.html', 'tuning.css', 'voice.html', 'voice.css'].map(name =>
    copyFile(new URL(`src/${name}`, dir), resolve(outdir, name))),
]);
if (config.mode === 'production') console.log(`MoodShift cloud API: ${config.apiBaseUrl}`);
