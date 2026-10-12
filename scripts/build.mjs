import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

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
// Lighter's signer (WebAssembly) ships next to the app as an extra resource.
mkdirSync('dist/wasm', { recursive: true });
copyFileSync('node_modules/@lifi/perps-sdk-provider-lighter/dist/wasm/lighter-signer.wasm', 'dist/wasm/lighter-signer.wasm');

if (!skipRenderer) await viteBuild({ configFile: 'vite.config.ts' });
