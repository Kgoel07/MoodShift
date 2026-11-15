import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { deploymentFromEnv } from '../extension/src/shared/deployment.ts';

const dir = new URL('../extension/', import.meta.url);
const { values } = parseArgs({ options: { mode: { type: 'string', default: 'development' }, outdir: { type: 'string' } } });
const config = deploymentFromEnv(values.mode, process.env);
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
  manifest.content_security_policy = {
    extension_pages: `script-src 'self'; object-src 'self'; connect-src 'self' ${config.apiBaseUrl} ${wsOrigin} https://lrclib.net https://widget.songle.jp`,
  };
}
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: ['background', 'offscreen', 'sidepanel', 'stem-worker', 'stem-worklet', 'youtube-playback']
    .map(name => `extension/src/${name}.ts`),
  outdir,
  define: { __MOODSHIFT_DEPLOYMENT__: JSON.stringify(config) },
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  logLevel: 'info',
});
await Promise.all([
  config.mode === 'production'
    ? writeFile(resolve(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    : copyFile(new URL('manifest.json', dir), resolve(outdir, 'manifest.json')),
  ...['offscreen.html', 'sidepanel.html', 'sidepanel.css'].map(name =>
    copyFile(new URL(`src/${name}`, dir), resolve(outdir, name))),
]);
