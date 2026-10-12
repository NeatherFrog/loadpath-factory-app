import { contextBridge, ipcRenderer } from 'electron';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

function on(channel: string, cb: (payload: any) => void) {
  const listener = (_e: unknown, payload: unknown) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  appInfo: () => call('app:info'),
  getFeed: (refresh = false) => call('feed:get', refresh),
  getMarkets: () => call('markets:get'),
  botStatus: () => call('bot:status'),
  botLogs: () => call('bot:logs'),
  getBotConfig: () => call('bot:config:get'),
  setBotConfig: (c: unknown) => call('bot:config:set', c),
  startBot: () => call('bot:start'),
  stopBot: () => call('bot:stop'),
  flatten: () => call('bot:flatten'),
  resetStats: () => call('bot:resetStats'),
  openHedge: (coin: string, side: 'long' | 'short', size: number, venue: string, maker: boolean) => call('bot:hedge:open', coin, side, size, venue, maker),
  closeHedge: (id: string) => call('bot:hedge:close', id),
  getCreds: () => call('creds:get'),
  setCreds: (input: unknown) => call('creds:set', input),
  getPoints: () => call('points:get'),
  setPoints: (p: unknown) => call('points:set', p),
  nadoPoints: (address?: string) => call('points:nado', address),
  updateStatus: () => call('update:get'),
  checkUpdates: () => call('update:check'),
  installUpdate: () => call('update:install'),
  openExternal: (url: string) => call('open:external', url),
  onBotStatus: (cb: (s: any) => void) => on('bot:status', cb),
  onBotLog: (cb: (e: any) => void) => on('bot:log', cb),
  onUpdateStatus: (cb: (s: any) => void) => on('update:status', cb),
};

contextBridge.exposeInMainWorld('api', api);
export type RetroApi = typeof api;
