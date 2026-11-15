import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
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
const logoPath = 'assets/logo.png';
const logo = await readFile(new URL(logoPath, dir)).catch(error => {
  if (error.code !== 'ENOENT') throw error;
});
if (logo) {
  await mkdir(resolve(outdir, 'assets'), { recursive: true });
  await writeFile(resolve(outdir, logoPath), logo);
  manifest.icons = { ...manifest.icons, 128: logoPath };
  manifest.action.default_icon = logoPath;
} else {
  await rm(resolve(outdir, logoPath), { force: true });
}
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
  config.mode === 'production' || logo
    ? writeFile(resolve(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    : copyFile(new URL('manifest.json', dir), resolve(outdir, 'manifest.json')),
  ...['offscreen.html', 'sidepanel.html', 'sidepanel.css'].map(name =>
    copyFile(new URL(`src/${name}`, dir), resolve(outdir, name))),
]);
if (config.mode === 'production') console.log(`MoodShift cloud API: ${config.apiBaseUrl}`);
