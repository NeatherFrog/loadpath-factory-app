import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResearchFeed } from '../shared/types';

// Research data lives in the repo (data/projects.json). Pushing a new version to main
// updates every installed app within minutes — no new release needed.
const REMOTE_URLS = [
  'https://raw.githubusercontent.com/NeatherFrog/retrodrop-dashboard/main/data/projects.json',
  'https://raw.githubusercontent.com/NeatherFrog/loadpath-factory-app/main/data/projects.json',
];

export interface LoadedFeed {
  feed: ResearchFeed;
  source: 'remote' | 'cache' | 'bundled';
}

function bundledPath() {
  return app.isPackaged ? join(process.resourcesPath, 'data', 'projects.json') : join(app.getAppPath(), 'data', 'projects.json');
}

function cachePath() {
  return join(app.getPath('userData'), 'feed-cache.json');
}

function readJson(path: string): ResearchFeed | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ResearchFeed) : null;
  } catch {
    return null;
  }
}

function valid(f: unknown): f is ResearchFeed {
  return !!f && typeof f === 'object' && Array.isArray((f as ResearchFeed).projects) && typeof (f as ResearchFeed).version === 'number';
}

export async function loadFeed(): Promise<LoadedFeed> {
  const bundled = readJson(bundledPath());
  const cached = readJson(cachePath());
  let best: LoadedFeed | null = bundled ? { feed: bundled, source: 'bundled' } : null;
  if (cached && (!best || cached.version >= best.feed.version)) best = { feed: cached, source: 'cache' };

  for (const url of REMOTE_URLS) {
    try {
      const res = await fetch(`${url}?t=${Date.now()}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const remote = (await res.json()) as unknown;
      if (valid(remote) && (!best || remote.version >= best.feed.version)) {
        writeFileSync(cachePath(), JSON.stringify(remote));
        best = { feed: remote, source: 'remote' };
      }
      break;
    } catch {
      // offline or repo renamed — try the next URL, fall back to cache/bundled
    }
  }
  if (!best) throw new Error('Нет данных исследования (data/projects.json)');
  return best;
}
