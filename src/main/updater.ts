import { app } from 'electron';
import log from 'electron-log/main';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '../shared/types';

const CHECK_EVERY_MS = 30 * 60_000;

/**
 * Auto-update from GitHub Releases: every push of a new version to main builds an installer
 * (see .github/workflows/release.yml); installed apps download it in the background and
 * install it on the next restart.
 */
export function setupUpdater(onStatus: (s: UpdateStatus) => void) {
  let status: UpdateStatus = { state: 'idle' };
  const set = (s: UpdateStatus) => {
    status = s;
    onStatus(s);
  };

  if (!app.isPackaged) {
    set({ state: 'dev', message: 'Режим разработки — обновления отключены' });
    return { check: async () => {}, install: () => {}, get: () => status };
  }

  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => set({ state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => set({ state: 'up-to-date', version: app.getVersion() }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', version: status.version, progress: p.percent }));
  autoUpdater.on('update-downloaded', (i) => set({ state: 'downloaded', version: i.version }));
  autoUpdater.on('error', (e) => set({ state: 'error', message: String(e?.message ?? e) }));

  const check = async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      set({ state: 'error', message: String(e) });
    }
  };
  void check();
  setInterval(check, CHECK_EVERY_MS);

  return {
    check,
    install: () => autoUpdater.quitAndInstall(false, true),
    get: () => status,
  };
}
