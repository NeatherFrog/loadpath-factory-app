import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { rmSync } from 'node:fs';

const skipRenderer = process.argv.includes('--no-renderer');
rmSync('dist', { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
};

await esbuild({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' });
await esbuild({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js' });
if (!skipRenderer) await viteBuild({ configFile: 'vite.config.ts' });
