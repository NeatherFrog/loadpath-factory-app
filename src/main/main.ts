import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell } from 'electron';
import log from 'electron-log/main';
import { join } from 'node:path';
import type { AppInfo, BotConfig, BotVenueId, CredentialsInput, PointsEntry, UpdateStatus } from '../shared/types';
import { Store } from './store';
import { loadFeed, type LoadedFeed } from './feed';
import { fetchMarketSnapshot } from './markets';
import { fetchNadoPoints } from './data/nadoPublic';
import { setupUpdater } from './updater';
import { BotManager } from './botManager';

log.initialize();
let win: BrowserWindow | null = null;
let feedCache: LoadedFeed | null = null;
let blockerId: number | null = null;

function send(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b0e14',
    title: 'RetroDrop Dashboard',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));

  // External links open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !(devUrl && url.startsWith(devUrl))) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  win.on('close', (e) => {
    if (!bot.isRunning()) return;
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      buttons: ['Остановить бота и выйти', 'Отмена'],
      defaultId: 1,
      message: 'Бот работает',
      detail: 'При выходе текущий цикл будет закрыт (обе ноги).',
    });
    if (choice === 1) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    void bot.stop().finally(() => {
      win?.destroy();
    });
  });
}

// Created in app.whenReady(): the store needs app paths, the bot needs the store.
let realStore: Store;
let bot: BotManager;
let updater: ReturnType<typeof setupUpdater>;

function wrap<T>(fn: () => Promise<T> | T) {
  return Promise.resolve()
    .then(fn)
    .then((data) => ({ ok: true as const, data }))
    .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
}

function registerIpc() {
  ipcMain.handle('app:info', () =>
    wrap<AppInfo>(() => ({
      version: app.getVersion(),
      platform: process.platform,
      dataSource: feedCache?.source ?? 'bundled',
      dataUpdatedAt: feedCache?.feed.updatedAt ?? '',
    })),
  );
  ipcMain.handle('feed:get', (_e, refresh: boolean) =>
    wrap(async () => {
      if (!feedCache || refresh) feedCache = await loadFeed();
      return feedCache;
    }),
  );
  ipcMain.handle('markets:get', () => wrap(fetchMarketSnapshot));

  ipcMain.handle('bot:status', () => wrap(() => bot.status()));
  ipcMain.handle('bot:logs', () => wrap(() => bot.getLogs()));
  ipcMain.handle('bot:config:get', () => wrap(() => realStore.botConfig));
  ipcMain.handle('bot:config:set', (_e, c: BotConfig) =>
    wrap(() => {
      if (bot.isRunning() && (c.mode !== realStore.botConfig.mode || c.legA !== realStore.botConfig.legA || c.legB !== realStore.botConfig.legB)) {
        throw new Error('Останови бота перед сменой режима или бирж');
      }
      realStore.setBotConfig(c);
      bot.notify();
      return realStore.botConfig;
    }),
  );
  ipcMain.handle('bot:start', () =>
    wrap(async () => {
      const s = await bot.start();
      if (blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
      return s;
    }),
  );
  ipcMain.handle('bot:stop', () =>
    wrap(async () => {
      const s = await bot.stop();
      if (blockerId !== null) powerSaveBlocker.stop(blockerId);
      blockerId = null;
      return s;
    }),
  );
  ipcMain.handle('bot:flatten', () => wrap(() => bot.flatten()));
  ipcMain.handle('bot:resetStats', () => wrap(() => bot.resetStats()));
  ipcMain.handle('bot:hedge:open', (_e, coin: string, side: 'long' | 'short', size: number, venue: BotVenueId, maker: boolean) =>
    wrap(() => bot.openHedge(coin, side, size, venue, maker)),
  );
  ipcMain.handle('bot:hedge:close', (_e, id: string) => wrap(() => bot.closeHedge(id)));

  ipcMain.handle('creds:get', () => wrap(() => realStore.credentialsView()));
  ipcMain.handle('creds:set', (_e, input: CredentialsInput) =>
    wrap(() => {
      realStore.setCredentials(input);
      return realStore.credentialsView();
    }),
  );
  ipcMain.handle('points:get', () => wrap(() => realStore.points));
  ipcMain.handle('points:set', (_e, p: PointsEntry[]) =>
    wrap(() => {
      realStore.setPoints(p);
      return realStore.points;
    }),
  );

  ipcMain.handle('points:nado', (_e, address?: string) =>
    wrap(() => fetchNadoPoints(address || realStore.credentialsView().nado.address || undefined)),
  );
  ipcMain.handle('update:get', () => wrap(() => updater.get()));
  ipcMain.handle('update:check', () => wrap(() => updater.check()));
  ipcMain.handle('update:install', () => wrap(() => updater.install()));
  ipcMain.handle('open:external', (_e, url: string) =>
    wrap(() => {
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
    }),
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    realStore = new Store();
    bot = new BotManager(realStore, {
      status: (s) => send('bot:status', s),
      log: (e) => send('bot:log', e),
    });
    registerIpc();
    createWindow();
    updater = setupUpdater((s: UpdateStatus) => send('update:status', s));
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
