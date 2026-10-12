import type { BotConfig, BotLogEntry, BotStatus, BotVenueId } from '../shared/types';
import { DeltaNeutralEngine, emptyStats } from './bot/engine';
import type { Venue } from './bot/venue';
import { PaperVenue } from './bot/venues/paper';
import { hlPublicSource, nadoPublicSource } from './bot/venues/sources';
import { NadoVenue } from './bot/venues/nado';
import { HyperliquidVenue } from './bot/venues/hyperliquid';
import type { Store } from './store';

const MAX_LOG = 500;

export class BotManager {
  private engine: DeltaNeutralEngine | null = null;
  private engineKey = '';
  private logs: BotLogEntry[] = [];
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private store: Store,
    private push: { status: (s: BotStatus) => void; log: (e: BotLogEntry) => void },
  ) {}

  private makeVenue(id: BotVenueId, mode: BotConfig['mode']): Venue {
    if (mode === 'paper') {
      return id === 'nado'
        ? new PaperVenue('nado', 'Nado (paper)', nadoPublicSource())
        : new PaperVenue('hyperliquid', 'Hyperliquid (paper)', hlPublicSource());
    }
    return id === 'nado' ? new NadoVenue(this.store.nadoCredentials()) : new HyperliquidVenue(this.store.hyperliquidCredentials());
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
    if (this.engine) return this.engine.status();
    return {
      state: 'stopped',
      mode: this.store.botConfig.mode,
      message: 'Остановлен',
      cycle: null,
      stats: this.store.stats ?? emptyStats(),
      hedges: this.store.hedges,
    };
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

  async openHedge(coin: string, side: 'long' | 'short', size: number, venue: BotVenueId) {
    const engine = this.ensureEngine();
    await engine.openManualHedge(coin, side, size, venue);
    return engine.status();
  }

  async closeHedge(id: string) {
    const engine = this.ensureEngine();
    await engine.closeManualHedge(id);
    return engine.status();
  }

  resetStats() {
    if (this.isRunning()) throw new Error('Останови бота перед сбросом статистики');
    this.engine = null;
    this.store.saveBotState(emptyStats(), this.store.hedges);
    return this.status();
  }
}
