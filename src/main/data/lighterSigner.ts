import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createGoRuntime } from '../vendor/wasmExecRuntime';

// Lighter's official Go signer compiled to WebAssembly (shipped by @lifi/perps-sdk-provider-lighter).
// The installer carries it under resources/wasm; in development it is read from node_modules.

export interface SignResult {
  txType?: number;
  txInfo?: string;
  txHash?: string;
  error?: string;
}

export interface LighterWasm {
  CreateClient(url: string, privateKey: string, chainId: number, apiKeyIndex: number, accountIndex: number): { error?: string };
  SignCreateOrder(...args: number[]): SignResult;
  SignCancelOrder(...args: number[]): SignResult;
}

const NAMES = ['CreateClient', 'SignCreateOrder', 'SignCancelOrder'] as const;
let loaded: Promise<LighterWasm> | null = null;

function wasmPath(): string {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'wasm', 'lighter-signer.wasm') : '',
    join(__dirname, '..', 'wasm', 'lighter-signer.wasm'), // dist/wasm in development builds
    join(process.cwd(), 'node_modules', '@lifi', 'perps-sdk-provider-lighter', 'dist', 'wasm', 'lighter-signer.wasm'),
    join(__dirname, '..', '..', 'node_modules', '@lifi', 'perps-sdk-provider-lighter', 'dist', 'wasm', 'lighter-signer.wasm'),
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Lighter signer (lighter-signer.wasm) not found');
  return found;
}

export function loadLighterWasm(): Promise<LighterWasm> {
  loaded ??= (async () => {
    const bytes = await readFile(wasmPath());
    const go = createGoRuntime();
    const { instance } = await WebAssembly.instantiate(bytes.slice().buffer as ArrayBuffer, go.importObject);
    void go.run(instance); // the Go main() never returns; it registers the signer functions on globalThis
    for (let i = 0; i < 2; i++) await new Promise((r) => setImmediate(r));
    const g = globalThis as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const name of NAMES) {
      if (typeof g[name] !== 'function') throw new Error(`Lighter signer: missing ${name}`);
      out[name] = g[name];
    }
    return out as unknown as LighterWasm;
  })().catch((err) => {
    loaded = null;
    throw err;
  });
  return loaded;
}
