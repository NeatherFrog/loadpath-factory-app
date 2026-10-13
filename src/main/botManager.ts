import type { AutopilotConfig, AutopilotStatus, BotConfig, BotLogEntry, BotStatus, BotVenueId } from '../shared/types';

/** Paper balance of each Entropy-strategy leg: $300 split in two, like a small real account. */
const ENTROPY_PAPER_EQUITY = 150;
import { Autopilot } from './bot/autopilot';
import { fetchFundingQuotes } from './data/fundingQuotes';
import { ENTROPY_DEX, XYZ_DEX, fetchEntropyQuotes } from './data/entropyQuotes';
import { guardIsolatedMargin } from './bot/marginGuard';
import { DeltaNeutralEngine, emptyStats } from './bot/engine';
import type { Venue } from './bot/venue';
import { PaperVenue } from './bot/venues/paper';
import { hlPublicSource, lighterPublicSource, nadoPublicSource } from './bot/venues/sources';
import { LighterVenue } from './bot/venues/lighter';
import { NadoVenue } from './bot/venues/nado';
import { HyperliquidVenue } from './bot/venues/hyperliquid';
import type { Store } from './store';

const MAX_LOG = 500;

export class BotManager {
  private engine: DeltaNeutralEngine | null = null;
  private engineKey = '';
  private logs: BotLogEntry[] = [];
  private saveTimer: NodeJS.Timeout | null = null;

  private venues = new Map<string, Venue>();
  private autopilot: Autopilot | null = null;
  private autopilotKey = '';
  private apSaveTimer: NodeJS.Timeout | null = null;

  constructor(
    private store: Store,
    private push: { status: (s: BotStatus) => void; log: (e: BotLogEntry) => void; autopilot?: (s: AutopilotStatus) => void },
  ) {}

  /** One venue instance per (mode, exchange), shared by the bot and the autopilot. */
  private makeVenue(id: BotVenueId, mode: BotConfig['mode']): Venue {
    const key = `${mode}:${id}`;
    let v = this.venues.get(key);
    if (!v) {
      v = this.createVenue(id, mode);
      this.venues.set(key, v);
    }
    return v;
  }

  /** New API keys take effect on the next start. */
  resetVenues() {
    if (this.isRunning() || this.autopilot?.status().running) throw new Error('Останови бота и автопилот перед сменой ключей');
    this.venues.clear();
    this.engine = null;
    this.autopilot = null;
  }

  private createVenue(id: BotVenueId, mode: BotConfig['mode']): Venue {
    if (mode === 'paper') {
      if (id === 'nado') return new PaperVenue('nado', 'Nado (paper)', nadoPublicSource());
      if (id === 'lighter') return new PaperVenue('lighter', 'Lighter (paper)', lighterPublicSource());
      if (id === 'entropy') return new PaperVenue('entropy', 'Entropy (paper)', hlPublicSource(ENTROPY_DEX), ENTROPY_PAPER_EQUITY);
      if (id === 'tradexyz') return new PaperVenue('tradexyz', 'trade.xyz (paper)', hlPublicSource(XYZ_DEX), ENTROPY_PAPER_EQUITY);
      return new PaperVenue('hyperliquid', 'Hyperliquid (paper)', hlPublicSource());
    }
    if (id === 'nado') return new NadoVenue(this.store.nadoCredentials());
    if (id === 'lighter') return new LighterVenue(this.store.lighterCredentials());
    // Entropy and trade.xyz are HIP-3 dexes on Hyperliquid: same account and API key, isolated margin.
    const leverage = () => this.store.autopilotConfig.leverage;
    if (id === 'entropy') {
      return new HyperliquidVenue(this.store.hyperliquidCredentials(), { id, label: 'Entropy', dex: ENTROPY_DEX, leverage, equityDexes: [XYZ_DEX] });
    }
    if (id === 'tradexyz') {
      return new HyperliquidVenue(this.store.hyperliquidCredentials(), { id, label: 'trade.xyz', dex: XYZ_DEX, leverage, equityDexes: [ENTROPY_DEX] });
    }
    return new HyperliquidVenue(this.store.hyperliquidCredentials());
  }

  /** Engine for the current config; rebuilt when venues or mode change (only while stopped). */
  private ensureEngine(): DeltaNeutralEngine {
    const cfg = this.store.botConfig;
    const key = `${cfg.mode}:${cfg.legA}:${cfg.legB}`;
    if (this.engine && this.engineKey === key) {
      this.engine.updateConfig(cfg);
      return this.engine;
    }
    if (this.engine && ['running', 'starting', 'stopping'].includes(this.engine.status().state)) {
      throw new Error('Останови бота перед сменой режима или бирж');
    }
    if (cfg.legA === cfg.legB) throw new Error('Ноги A и B должны быть на разных биржах');
    const prev = this.engine?.status();
    this.engine = new DeltaNeutralEngine(this.makeVenue(cfg.legA, cfg.mode), this.makeVenue(cfg.legB, cfg.mode), cfg, {
      initialStats: prev?.stats ?? this.store.stats ?? emptyStats(),
      initialHedges: prev?.hedges ?? this.store.hedges,
      log: (e) => this.addLog(e),
      onChange: (s) => this.onChange(s),
      resolveVenue: (id) => this.makeVenue(id, cfg.mode),
    });
    this.engineKey = key;
    return this.engine;
  }

  private addLog(e: BotLogEntry) {
    this.logs.push(e);
    if (this.logs.length > MAX_LOG) this.logs.splice(0, this.logs.length - MAX_LOG);
    this.push.log(e);
  }

  private onChange(s: BotStatus) {
    this.push.status(s);
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.store.saveBotState(s.stats, s.hedges);
    }, 2000);
  }

  status(): BotStatus {
    if (this.engine) return { ...this.engine.status(), mode: this.store.botConfig.mode };
    return {
      state: 'stopped',
      mode: this.store.botConfig.mode,
      message: 'Остановлен',
      cycle: null,
      stats: this.store.stats ?? emptyStats(),
      hedges: this.store.hedges,
    };
  }

  /** Tell the UI about a config change (e.g. practice ↔ live). */
  notify() {
    this.push.status(this.status());
  }

  getLogs() {
    return this.logs;
  }

  isRunning() {
    return !!this.engine && ['running', 'starting', 'stopping'].includes(this.engine.status().state);
  }

  async start() {
    const engine = this.ensureEngine();
    await engine.start();
    return engine.status();
  }

  async stop() {
    await this.engine?.stop();
    return this.status();
  }

  async flatten() {
    const engine = this.ensureEngine();
    await engine.flattenAll();
    this.addLog({ ts: Date.now(), level: 'warn', msg: 'Экстренное закрытие всех позиций выполнено' });
    return engine.status();
  }

  async openHedge(coin: string, side: 'long' | 'short', size: number, venue: BotVenueId, maker = false) {
    const engine = this.ensureEngine();
    await engine.openManualHedge(coin, side, size, venue, maker);
    return engine.status();
  }

  async closeHedge(id: string) {
    const engine = this.ensureEngine();
    await engine.closeManualHedge(id);
    return engine.status();
  }

  // ---------- autopilot ----------

  private hedgeId(): BotVenueId {
    const b = this.store.botConfig.legB;
    return b === 'nado' ? 'lighter' : b;
  }

  private ensureAutopilot(): Autopilot {
    const cfg = this.store.botConfig;
    const strategy = this.store.autopilotConfig.strategy;
    const entropy = strategy === 'entropy';
    const farmId: BotVenueId = entropy ? 'entropy' : 'nado';
    const hedge: BotVenueId = entropy ? 'tradexyz' : this.hedgeId();
    const key = `${cfg.mode}:${farmId}:${hedge}`;
    if (this.autopilot && this.autopilotKey === key) {
      this.autopilot.updateConfig(this.store.autopilotConfig);
      return this.autopilot;
    }
    if (this.autopilot?.status().running) throw new Error('Останови автопилот перед сменой режима');
    const mode = cfg.mode;
    const farm = this.makeVenue(farmId, mode);
    const hedgeVenue = this.makeVenue(hedge, mode);
    const holder = new DeltaNeutralEngine(farm, hedgeVenue, { ...cfg, legA: farmId, legB: hedge }, {
      log: (e) => this.addLog(e),
      resolveVenue: (id) => this.makeVenue(id, mode),
    });
    const stateKey = entropy ? `entropy:${mode}` : mode;
    this.autopilot = new Autopilot(this.store.autopilotConfig, {
      nado: farm,
      hedge: hedgeVenue,
      holder,
      ...(entropy
        ? {
            quotes: () => fetchEntropyQuotes(),
            rollVolume: true,
            sharedAccount: mode === 'live',
            guard: mode === 'live' ? (coin: string) => guardIsolatedMargin(farm, hedgeVenue, coin) : undefined,
          }
        : {
            quotes: () => fetchFundingQuotes(hedge),
            churnBudget: (usd: number, exclude: string | null) => this.churnBudget(usd, exclude),
          }),
      initial: this.store.autopilotState(stateKey),
      onChange: (s) => {
        this.push.autopilot?.(s);
        if (this.apSaveTimer) return;
        this.apSaveTimer = setTimeout(() => {
          this.apSaveTimer = null;
          this.store.saveAutopilotState(stateKey, s);
        }, 1000);
      },
    });
    this.autopilotKey = key;
    return this.autopilot;
  }

  /**
   * The churn engine (extra Nado volume for points) may lose at most `usd` today — funding the
   * autopilot earned plus the user's daily budget. 0 stops it.
   */
  private async churnBudget(usd: number, exclude: string | null) {
    const cfg = this.store.botConfig;
    if (cfg.legA !== 'nado') return;
    const engine = this.ensureEngine();
    const coins = cfg.coins.filter((c) => c !== exclude);
    const running = ['running', 'starting', 'stopping'].includes(engine.status().state);
    if (usd < 0.05 || coins.length === 0) {
      if (running) void engine.stop();
      return;
    }
    engine.updateConfig({ ...cfg, coins, maxDailyLossUsd: usd, dailyVolumeTargetUsd: 0 });
    const spent = -engine.status().stats.realizedPnlTodayUsd;
    if (!running && spent < usd - 0.05) void engine.start();
  }

  autopilotStatus(): AutopilotStatus | null {
    try {
      return this.ensureAutopilot().status();
    } catch {
      return null;
    }
  }

  async startAutopilot() {
    const ap = this.ensureAutopilot();
    this.store.setAutopilotEnabled(true);
    await ap.start();
    return ap.status();
  }

  /** `byUser`: the user pressed stop (don't resume on next launch); false when the app is quitting. */
  async stopAutopilot(closePosition: boolean, byUser = true) {
    if (byUser) this.store.setAutopilotEnabled(false);
    if (!this.autopilot) return null;
    await this.autopilot.stop(closePosition);
    if (this.engine && ['running', 'starting'].includes(this.engine.status().state)) await this.engine.stop();
    return this.autopilot.status();
  }

  async resumeAutopilotIfEnabled() {
    if (!this.store.autopilotEnabled) return;
    try {
      await this.startAutopilot();
      this.addLog({ ts: Date.now(), level: 'info', msg: 'Автопилот продолжил работу после перезапуска' });
    } catch (err) {
      this.addLog({ ts: Date.now(), level: 'error', msg: `Не удалось возобновить автопилот: ${err instanceof Error ? err.message : err}` });
    }
  }

  setAutopilotConfig(c: AutopilotConfig) {
    if (c.strategy !== this.store.autopilotConfig.strategy && this.autopilot?.status().running) {
      throw new Error('Останови автопилот, потом меняй биржу');
    }
    this.store.setAutopilotConfig(c);
    this.autopilot?.updateConfig(this.store.autopilotConfig);
    return this.store.autopilotConfig;
  }

  resetStats() {
    if (this.isRunning()) throw new Error('Останови бота перед сбросом статистики');
    this.engine = null;
    this.store.saveBotState(emptyStats(), this.store.hedges);
    return this.status();
  }
}
