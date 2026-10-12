import type {
  AppInfo,
  BotConfig,
  BotLogEntry,
  BotStatus,
  BotVenueId,
  CredentialsInput,
  MarketSnapshot,
  NadoPointsSummary,
  PointsEntry,
  ResearchFeed,
  UpdateStatus,
  VenueCredentialsView,
} from '../shared/types';

export interface Api {
  appInfo(): Promise<AppInfo>;
  getFeed(refresh?: boolean): Promise<{ feed: ResearchFeed; source: 'remote' | 'cache' | 'bundled' }>;
  getMarkets(): Promise<MarketSnapshot>;
  botStatus(): Promise<BotStatus>;
  botLogs(): Promise<BotLogEntry[]>;
  getBotConfig(): Promise<BotConfig>;
  setBotConfig(c: BotConfig): Promise<BotConfig>;
  startBot(): Promise<BotStatus>;
  stopBot(): Promise<BotStatus>;
  flatten(): Promise<BotStatus>;
  resetStats(): Promise<BotStatus>;
  openHedge(coin: string, side: 'long' | 'short', size: number, venue: BotVenueId): Promise<BotStatus>;
  closeHedge(id: string): Promise<BotStatus>;
  getCreds(): Promise<VenueCredentialsView>;
  setCreds(input: CredentialsInput): Promise<VenueCredentialsView>;
  getPoints(): Promise<PointsEntry[]>;
  setPoints(p: PointsEntry[]): Promise<PointsEntry[]>;
  nadoPoints(address?: string): Promise<NadoPointsSummary>;
  updateStatus(): Promise<UpdateStatus>;
  checkUpdates(): Promise<void>;
  installUpdate(): Promise<void>;
  openExternal(url: string): Promise<void>;
  onBotStatus(cb: (s: BotStatus) => void): () => void;
  onBotLog(cb: (e: BotLogEntry) => void): () => void;
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void;
}

declare global {
  interface Window {
    api: Api;
  }
}

export const api = (): Api => window.api;

export const usd = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits, minimumFractionDigits: digits });

export const compact = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export const pct = (n: number | null | undefined, digits = 1) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(digits)}%`;
