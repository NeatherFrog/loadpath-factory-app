import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { build as esbuild } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: true, external: ['electron'] };
await esbuild({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' });
await esbuild({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js' });

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls.local[0];
const electron = (await import('electron')).default;
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url } });
child.on('exit', () => { server.close(); process.exit(0); });
