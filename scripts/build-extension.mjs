import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

const dir = new URL('../extension/', import.meta.url);
await mkdir(new URL('dist/', dir), { recursive: true });
await build({
  entryPoints: ['background', 'offscreen', 'sidepanel', 'stem-worker', 'stem-worklet', 'youtube-playback']
    .map(name => `extension/src/${name}.ts`),
  outdir: 'extension/dist',
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  logLevel: 'info',
});
await Promise.all([
  copyFile(new URL('manifest.json', dir), new URL('dist/manifest.json', dir)),
  ...['offscreen.html', 'sidepanel.html', 'sidepanel.css'].map(name =>
    copyFile(new URL(`src/${name}`, dir), new URL(`dist/${name}`, dir))),
]);
