// Types shared between the main process (bot, data) and the renderer (UI).

export type ProjectStatus = 'farming' | 'tge-announced' | 'token-live' | 'watch' | 'avoid';

export interface ScoreBreakdown {
  team: number; // 0-10: doxxed, track record
  funding: number; // 0-10: tier-1 VCs / self-funded profitably
  traction: number; // 0-10: volume, OI, TVL
  tokenUpside: number; // 0-10: airdrop share, FDV expectations, no token yet
  pointsAccess: number; // 0-10: how much of the pool is still farmable for a newcomer
  automation: number; // 0-10: trading API quality (can the bot farm it?)
  farmCost: number; // 0-10: low fees / tight spreads = high score
  risk: number; // 0-10: 10 = low risk (sybil rules, rug, regulatory)
}

export interface ProjectLink {
  label: string;
  url: string;
}

export interface Project {
  id: string;
  name: string;
  sector: string;
  chain: string;
  status: ProjectStatus;
  pick?: 'primary' | 'secondary';
  summary: string;
  team: string;
  funding: string;
  traction: string;
  points: string;
  token: string;
  tgeEstimate?: string;
  airdropPct?: number; // % of supply for the points/genesis airdrop, if known
  weeklyPoints?: string;
  fees: string;
  api: string;
  risks: string[];
  verdict: string;
  scores: ScoreBreakdown;
  links: ProjectLink[];
  pointsModel?: PointsModelDefaults;
}

export interface PointsModelDefaults {
  totalPointsEstimate: number;
  airdropPct: number;
  fdvBear: number;
  fdvBase: number;
  fdvBull: number;
}

export interface OtcVenue {
  name: string;
  url: string;
  kind: string;
  notes: string;
}

export interface ResearchFeed {
  version: number;
  updatedAt: string;
  marketNote: string;
  economics?: import('./economics').EconomicsInputs & { notes: string[]; sources: ProjectLink[] };
  projects: Project[];
  otcVenues: OtcVenue[];
  sources: ProjectLink[];
}

// ---- Market data ----

export type VenueId = 'variational' | 'nado' | 'hyperliquid';

export interface VenueQuote {
  venue: VenueId;
  coin: string;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  fundingApr: number | null; // annualized, decimal (0.1 = 10%/yr), positive = longs pay
  volume24h: number | null;
  openInterestUsd: number | null;
}

export interface MarketRow {
  coin: string;
  quotes: Partial<Record<VenueId, VenueQuote>>;
  bestFundingPair: { longVenue: VenueId; shortVenue: VenueId; aprEdge: number } | null;
}

export interface MarketSnapshot {
  ts: number;
  rows: MarketRow[];
  venueStats: Partial<Record<VenueId, { volume24h?: number; openInterest?: number; tvl?: number; markets?: number }>>;
  errors: string[];
}

// ---- Bot ----

export type BotVenueId = 'nado' | 'hyperliquid' | 'lighter';
export type BotMode = 'paper' | 'live';

export interface BotConfig {
  mode: BotMode;
  legA: BotVenueId; // farm leg (points)
  legB: BotVenueId; // hedge leg
  coins: string[];
  notionalMinUsd: number;
  notionalMaxUsd: number;
  holdMinMinutes: number;
  holdMaxMinutes: number;
  pauseMinMinutes: number;
  pauseMaxMinutes: number;
  maxEntrySpreadBps: number; // combined spread of both books must be below this
  maxBasisBps: number; // mid price divergence between venues
  slippageBps: number; // IOC limit offset from top of book
  maxDailyLossUsd: number; // stop the bot when realized loss today exceeds this
  dailyVolumeTargetUsd: number; // stop opening new cycles after this volume (0 = unlimited)
  direction: 'random' | 'funding';
  deltaToleranceUsd: number; // rebalance when |net exposure| exceeds this
  makerLegA: boolean; // leg A uses post-only limit orders (much cheaper), leg B hedges each fill
  makerWaitSec: number; // how long a resting order may wait before it is re-quoted
  makerRequotes: number; // re-quotes before the remainder falls back to a taker order
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  mode: 'paper',
  legA: 'nado',
  legB: 'lighter',
  coins: ['BTC', 'ETH'],
  notionalMinUsd: 150,
  notionalMaxUsd: 300,
  holdMinMinutes: 3,
  holdMaxMinutes: 12,
  pauseMinMinutes: 1,
  pauseMaxMinutes: 4,
  maxEntrySpreadBps: 6,
  maxBasisBps: 15,
  slippageBps: 8,
  maxDailyLossUsd: 25,
  dailyVolumeTargetUsd: 0,
  direction: 'funding',
  deltaToleranceUsd: 40,
  makerLegA: true,
  makerWaitSec: 45,
  makerRequotes: 6,
};

export type BotState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface BotLeg {
  venue: BotVenueId;
  coin: string;
  size: number; // signed base size
  entryPx: number;
}

export interface BotCycle {
  id: number;
  coin: string;
  phase: 'opening' | 'holding' | 'closing' | 'done' | 'failed';
  openedAt: number;
  closeAt: number;
  notionalUsd: number;
  legs: BotLeg[];
}

export interface VenueStats {
  volumeUsd: number;
  feesUsd: number;
  trades: number;
}

export interface BotStats {
  day: string; // YYYY-MM-DD (UTC) the "today" counters belong to
  cycles: number;
  failedCycles: number;
  volumeTodayUsd: number;
  realizedPnlTodayUsd: number;
  totalVolumeUsd: number;
  totalFeesUsd: number;
  totalRealizedPnlUsd: number; // includes fees and spread cost
  perVenue: Partial<Record<BotVenueId, VenueStats>>;
}

export interface BotStatus {
  state: BotState;
  mode: BotMode;
  message: string;
  cycle: BotCycle | null;
  stats: BotStats;
  hedges: ManualHedge[];
}

export interface BotLogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'trade';
  msg: string;
}

// Manual Omni (Variational) trades hedged automatically on an API venue.
export interface ManualHedge {
  id: string;
  coin: string;
  omniSide: 'long' | 'short';
  size: number; // base units opened on Omni
  hedgeVenue: BotVenueId;
  hedgeSize: number; // signed size actually filled on the hedge venue
  hedgePx: number;
  openedAt: number;
  status: 'open' | 'closed' | 'failed';
}

// ---- Settings / secrets ----

export interface VenueCredentialsView {
  nado: { address: string; hasKey: boolean; subaccount: string };
  hyperliquid: { address: string; hasKey: boolean };
  lighter: { accountIndex: string; apiKeyIndex: string; hasKey: boolean };
}

export interface CredentialsInput {
  nado?: { address?: string; privateKey?: string; subaccount?: string };
  hyperliquid?: { address?: string; privateKey?: string };
  lighter?: { accountIndex?: string; apiKeyIndex?: string; privateKey?: string };
}

export interface PointsEntry {
  projectId: string;
  myPoints: number;
  totalPoints: number;
  airdropPct: number;
  fdvBear: number;
  fdvBase: number;
  fdvBull: number;
  otcOfferPerPoint: number;
  farmCostUsd: number;
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error' | 'dev';
  version?: string;
  progress?: number;
  message?: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  dataSource: 'remote' | 'cache' | 'bundled';
  dataUpdatedAt: string;
}

export interface NadoPointsSummary {
  totalDistributed: number;
  lastWeekPool: number;
  myPoints: number | null;
  epochs: { epoch: number; description: string; start: number; total: number; mine: number }[];
}

// ---- Autopilot ----

export interface AutopilotConfig {
  /** Position size = min(margin on both venues) × leverage × 0.9. */
  leverage: number;
  /** Extra USD per day the user allows to spend on Nado volume for points (on top of funding earned). */
  dailyBudgetUsd: number;
  /** Spend funding (+ budget) on extra Nado volume. */
  churn: boolean;
  /** Minimum funding the mirrored position must earn per year to open it. */
  minEdgeApr: number;
  /** Switch coins only when the new one pays this much more per year. */
  switchExtraApr: number;
  minHoldHours: number;
  /** Positions are built and reduced in slices of this size. */
  sliceUsd: number;
  /** Hard cap on the position size (0 = no cap). */
  maxNotionalUsd: number;
}

export const DEFAULT_AUTOPILOT_CONFIG: AutopilotConfig = {
  leverage: 2,
  dailyBudgetUsd: 0,
  churn: true,
  minEdgeApr: 0.05,
  switchExtraApr: 0.1,
  minHoldHours: 8,
  sliceUsd: 500,
  maxNotionalUsd: 0,
};

export interface AutopilotHold {
  coin: string;
  nadoSide: 'long' | 'short';
  openedAt: number;
  /** Positions that existed before the autopilot (never touched). */
  baseA: number;
  baseB: number;
}

export interface AutopilotEvent {
  ts: number;
  text: string;
  kind: 'info' | 'trade' | 'warn' | 'error';
}

export interface AutopilotStatus {
  running: boolean;
  message: string;
  hold: AutopilotHold | null;
  notionalUsd: number;
  /** Funding the open position earns per year (decimal). */
  incomeApr: number;
  fundingTotalUsd: number;
  fundingTodayUsd: number;
  day: string;
  equity: { nado: number; hedge: number } | null;
  events: AutopilotEvent[];
}
