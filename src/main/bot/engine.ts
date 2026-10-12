import type {
  BotConfig,
  BotCycle,
  BotLogEntry,
  BotState,
  BotStats,
  BotStatus,
  BotVenueId,
  ManualHedge,
} from '../../shared/types';
import type { Fill, Venue } from './venue';
import { basisBps, chooseDirection, commonSize, randomBetween, roundToStep, spreadBps, utcDay } from './math';

export interface EngineDeps {
  sleep?: (ms: number, shouldWake: () => boolean) => Promise<void>;
  random?: () => number;
  now?: () => number;
  log?: (e: BotLogEntry) => void;
  onChange?: (s: BotStatus) => void;
  initialStats?: BotStats;
  initialHedges?: ManualHedge[];
  /** Builds venues that are not legs A/B (e.g. a manual-hedge venue). */
  resolveVenue?: (id: BotVenueId) => Venue;
}

const HEDGE_RETRIES = 4;
const CHECK_EVERY_MS = 30_000;
const SKIP_WAIT_MS = 15_000;
const NET_RETRIES = 6;
const UNWIND_ATTEMPTS = 4;
const MAKER_POLL_MS = 1500;

export function emptyStats(day = utcDay()): BotStats {
  return {
    day,
    cycles: 0,
    failedCycles: 0,
    volumeTodayUsd: 0,
    realizedPnlTodayUsd: 0,
    totalVolumeUsd: 0,
    totalFeesUsd: 0,
    totalRealizedPnlUsd: 0,
    perVenue: {},
  };
}

async function defaultSleep(ms: number, shouldWake: () => boolean) {
  const end = Date.now() + ms;
  while (Date.now() < end && !shouldWake()) {
    await new Promise((r) => setTimeout(r, Math.min(500, end - Date.now())));
  }
}

/**
 * Delta-neutral volume farming: open the same size long on one venue and short on the other,
 * hold for a random time, close both, repeat. Market risk stays ~0; the cost is fees + spread.
 */
export class DeltaNeutralEngine {
  private state: BotState = 'stopped';
  private message = 'Остановлен';
  private stopRequested = false;
  private cycle: BotCycle | null = null;
  private cycleSeq = 0;
  private stats: BotStats;
  private hedges: ManualHedge[];
  private loopPromise: Promise<void> | null = null;
  /**
   * Positions that existed before the current cycle (manual Omni hedges, the user's own trades).
   * The bot only ever manages position - baseline, so it never touches what isn't its own.
   */
  private baseline = new Map<string, number>();
  private sleep: NonNullable<EngineDeps['sleep']>;
  private random: () => number;
  private now: () => number;

  constructor(
    private a: Venue,
    private b: Venue,
    private config: BotConfig,
    private deps: EngineDeps = {},
  ) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.stats = deps.initialStats ?? emptyStats();
    this.hedges = deps.initialHedges ?? [];
  }

  status(): BotStatus {
    return {
      state: this.state,
      mode: this.config.mode,
      message: this.message,
      cycle: this.cycle,
      stats: this.stats,
      hedges: this.hedges,
    };
  }

  updateConfig(config: BotConfig) {
    this.config = config;
  }

  private emit() {
    this.deps.onChange?.(this.status());
  }

  private log(level: BotLogEntry['level'], msg: string) {
    this.deps.log?.({ ts: this.now(), level, msg });
  }

  private setState(state: BotState, message: string) {
    this.state = state;
    this.message = message;
    this.emit();
  }

  private extra = new Map<BotVenueId, Venue>();

  private venue(id: BotVenueId): Venue {
    if (this.a.id === id) return this.a;
    if (this.b.id === id) return this.b;
    let v = this.extra.get(id);
    if (!v && this.deps.resolveVenue) {
      v = this.deps.resolveVenue(id);
      this.extra.set(id, v);
    }
    if (!v) throw new Error(`Venue ${id} is not connected`);
    return v;
  }

  // ---------- lifecycle ----------

  async start() {
    if (this.state === 'running' || this.state === 'starting') return;
    this.stopRequested = false;
    this.setState('starting', 'Подключение к биржам…');
    try {
      await Promise.all([this.a.init(), this.b.init()]);
      const coins = this.config.coins.filter((c) => this.a.hasMarket(c) && this.b.hasMarket(c));
      const missing = this.config.coins.filter((c) => !coins.includes(c));
      if (missing.length) this.log('warn', `Нет на обеих биржах, пропускаю: ${missing.join(', ')}`);
      if (!coins.length) throw new Error('Ни одна монета из списка не торгуется на обеих биржах');
      this.config = { ...this.config, coins };
    } catch (err) {
      this.setState('error', `Ошибка запуска: ${errMsg(err)}`);
      this.log('error', `Ошибка запуска: ${errMsg(err)}`);
      return;
    }
    this.log('info', `Старт (${this.config.mode === 'paper' ? 'бумажный режим' : 'LIVE'}): ${this.a.label} ⇄ ${this.b.label}, монеты ${this.config.coins.join(', ')}`);
    this.setState('running', 'Работает');
    this.loopPromise = this.loop();
  }

  /** Graceful stop: the current cycle is closed early, then the loop exits. */
  async stop() {
    if (this.state !== 'running') return;
    this.stopRequested = true;
    this.setState('stopping', 'Закрываю текущий цикл…');
    await this.loopPromise;
  }

  /** Emergency: close EVERY position in the bot's coins on both venues (manual hedges included). */
  async flattenAll() {
    if (this.state === 'running') await this.stop();
    await Promise.all([this.a.init(), this.b.init()]);
    for (const venue of [this.a, this.b]) {
      for (const coin of this.config.coins) {
        if (!venue.hasMarket(coin)) continue;
        try {
          await this.closePosition(venue, coin);
        } catch (err) {
          this.log('error', `${venue.label} ${coin}: не удалось закрыть — ${errMsg(err)}`);
        }
      }
    }
    for (const h of this.hedges) {
      if (h.status === 'open' && this.config.coins.includes(h.coin)) h.status = 'closed';
    }
    this.baseline.clear();
    this.emit();
  }

  private async loop() {
    while (!this.stopRequested) {
      this.rollDay();
      const limit = this.limitReached();
      if (limit) {
        this.log('warn', limit);
        this.setState('stopped', limit);
        return;
      }
      let skipped = false;
      try {
        skipped = (await this.runCycle()) === 'skipped';
      } catch (err) {
        this.stats.failedCycles++;
        this.log('error', `Цикл прерван: ${errMsg(err)}`);
        const coin = this.cycle?.coin;
        if (this.cycle) this.cycle.phase = 'failed';
        // Never leave a one-sided position behind: unwind what this cycle opened.
        if (coin) {
          let naked = true;
          for (let attempt = 0; attempt < UNWIND_ATTEMPTS && naked; attempt++) {
            if (attempt > 0) {
              this.log('warn', `${coin}: повторяю откат (${attempt + 1}/${UNWIND_ATTEMPTS}) через 20 c`);
              await this.sleep(20_000, () => false);
            }
            for (const venue of [this.a, this.b]) {
              try {
                await this.closeOwn(venue, coin);
              } catch (e) {
                this.log('error', `${venue.label} ${coin}: откат не удался — ${errMsg(e)}`);
              }
            }
            try {
              naked = await this.hasNakedExposure(coin);
            } catch (e) {
              this.log('error', `${coin}: не удалось проверить позиции — ${errMsg(e)}`);
            }
          }
          if (naked) {
            this.setState('error', `Осталась незахеджированная позиция ${coin}. Нажми «Закрыть всё» или закрой её на бирже вручную`);
            return;
          }
          this.log('info', `${coin}: позиции после сбоя закрыты, продолжаю`);
        }
      }
      this.cycle = null;
      this.emit();
      if (this.stopRequested) break;
      let pause = randomBetween(this.config.pauseMinMinutes, this.config.pauseMaxMinutes, this.random) * 60_000;
      if (skipped) pause = Math.max(pause, SKIP_WAIT_MS); // don't hammer the APIs while spreads are wide
      this.message = `Пауза ${Math.round(pause / 1000)} c`;
      this.emit();
      await this.sleep(pause, () => this.stopRequested);
    }
    this.setState('stopped', 'Остановлен');
  }

  private rollDay() {
    const today = utcDay(this.now());
    if (this.stats.day !== today) {
      this.stats = { ...this.stats, day: today, volumeTodayUsd: 0, realizedPnlTodayUsd: 0 };
    }
  }

  private limitReached(): string | null {
    if (this.config.maxDailyLossUsd > 0 && -this.stats.realizedPnlTodayUsd >= this.config.maxDailyLossUsd) {
      return `Достигнут дневной лимит убытка $${this.config.maxDailyLossUsd}`;
    }
    if (this.config.dailyVolumeTargetUsd > 0 && this.stats.volumeTodayUsd >= this.config.dailyVolumeTargetUsd) {
      return `Дневная цель по объёму $${this.config.dailyVolumeTargetUsd} выполнена`;
    }
    return null;
  }

  private async hasNakedExposure(coin: string): Promise<boolean> {
    const [pa, pb] = await Promise.all([this.own(this.a, coin), this.own(this.b, coin)]);
    const step = Math.max(this.a.spec(coin).sizeStep, this.b.spec(coin).sizeStep);
    return Math.abs(pa + pb) >= step;
  }

  private key(venue: Venue | BotVenueId, coin: string) {
    return `${typeof venue === 'string' ? venue : venue.id}:${coin}`;
  }

  /** The bot's own position on a venue: current position minus the pre-cycle baseline. */
  private async own(venue: Venue, coin: string): Promise<number> {
    const pos = await this.retry(() => venue.position(coin), `${venue.label}: позиция`);
    return pos - (this.baseline.get(this.key(venue, coin)) ?? 0);
  }

  /** Bring the venue back to its baseline for `coin`, i.e. close only what the bot opened. */
  private async closeOwn(venue: Venue, coin: string, track?: (v: Venue, q: number, f: Fill) => void) {
    const pos = await this.retry(() => venue.position(coin), `${venue.label}: позиция`);
    const exposure = pos - (this.baseline.get(this.key(venue, coin)) ?? 0);
    const step = venue.spec(coin).sizeStep;
    if (Math.abs(exposure) < step) return;
    // reduce-only is safe only when closing our part also shrinks the total position.
    const reduceOnly = Math.sign(pos) === Math.sign(exposure) && Math.abs(exposure) <= Math.abs(pos) + 1e-12;
    const record = track ?? ((v: Venue, _q: number, f: Fill) => f.filledSize > 0 && this.recordFill(v.id, f));
    const done = await this.fillWithRetries(venue, coin, -exposure, reduceOnly, record);
    if (Math.abs(exposure) - done >= step) {
      throw new Error(`${venue.label} ${coin}: закрыто ${done} из ${Math.abs(exposure)}`);
    }
  }

  // ---------- one cycle ----------

  private async runCycle(): Promise<'skipped' | 'done'> {
    const cfg = this.config;
    const coin = cfg.coins[Math.floor(this.random() * cfg.coins.length)];
    const [bookA, bookB] = await Promise.all([
      this.retry(() => this.a.book(coin), `${this.a.label}: стакан`),
      this.retry(() => this.b.book(coin), `${this.b.label}: стакан`),
    ]);
    const midA = (bookA.bid + bookA.ask) / 2;
    const midB = (bookB.bid + bookB.ask) / 2;
    const totalSpread = spreadBps(bookA.bid, bookA.ask) + spreadBps(bookB.bid, bookB.ask);
    const basis = basisBps(midA, midB);
    if (totalSpread > cfg.maxEntrySpreadBps) {
      this.log('info', `${coin}: спред ${totalSpread.toFixed(1)} bps > лимита ${cfg.maxEntrySpreadBps}, жду`);
      return 'skipped';
    }
    if (basis > cfg.maxBasisBps) {
      this.log('info', `${coin}: расхождение цен ${basis.toFixed(1)} bps > ${cfg.maxBasisBps}, жду`);
      return 'skipped';
    }

    const [fA, fB] = await Promise.all([this.a.fundingApr(coin).catch(() => null), this.b.fundingApr(coin).catch(() => null)]);
    const dir = chooseDirection(cfg.direction, fA, fB, this.random);
    const notional = randomBetween(cfg.notionalMinUsd, cfg.notionalMaxUsd, this.random);
    const specA = this.a.spec(coin);
    const specB = this.b.spec(coin);
    const size = commonSize(notional, midA, specA.sizeStep, specB.sizeStep);
    const minNotional = Math.max(specA.minNotionalUsd, specB.minNotionalUsd);
    if (size * midA < minNotional) {
      this.log('warn', `${coin}: объём $${(size * midA).toFixed(0)} меньше минимального $${minNotional}`);
      return 'skipped';
    }

    const [baseA, baseB] = await Promise.all([
      this.retry(() => this.a.position(coin), `${this.a.label}: позиция`),
      this.retry(() => this.b.position(coin), `${this.b.label}: позиция`),
    ]);
    this.baseline.set(this.key(this.a, coin), baseA);
    this.baseline.set(this.key(this.b, coin), baseB);
    if (baseA !== 0 || baseB !== 0) {
      this.log('info', `${coin}: уже есть позиции вне бота (${this.a.label} ${baseA}, ${this.b.label} ${baseB}) — их не трогаю`);
    }

    const holdMs = randomBetween(cfg.holdMinMinutes, cfg.holdMaxMinutes, this.random) * 60_000;
    this.cycle = {
      id: ++this.cycleSeq,
      coin,
      phase: 'opening',
      openedAt: this.now(),
      closeAt: this.now() + holdMs,
      notionalUsd: size * midA,
      legs: [],
    };
    this.message = `Открываю ${coin} ~$${(size * midA).toFixed(0)}`;
    this.emit();

    let cash = 0; // cash flow of the whole cycle: realized PnL once both legs are flat
    const track = (venue: Venue, signedQty: number, fill: Fill) => {
      if (fill.filledSize <= 0) return;
      cash += -signedQty * fill.avgPx - fill.feeUsd;
      this.recordFill(venue.id, fill);
      this.log('trade', `${venue.label} ${signedQty > 0 ? 'BUY' : 'SELL'} ${+fill.filledSize.toPrecision(8)} ${coin} @ ${fill.avgPx} (fee $${fill.feeUsd.toFixed(3)})`);
    };

    const useMaker = cfg.makerLegA && !!this.a.postOnly && !!this.a.cancel;
    if (useMaker) {
      this.message = `Мейкер-ордер ${coin} на ${this.a.label}…`;
      this.emit();
    }
    const { filledA, hedged, entryPx } = await this.openLegs(coin, dir * size, useMaker, track);
    if (filledA === 0) {
      this.log('info', useMaker ? `${coin}: мейкер-ордер не исполнился за ${cfg.makerWaitSec * cfg.makerRequotes} c, пропускаю цикл` : `${this.a.label}: IOC не исполнился, пропускаю цикл`);
      this.cycle.phase = 'failed';
      return 'skipped';
    }
    this.cycle.notionalUsd = hedged * midA;
    this.cycle.legs = [
      { venue: this.a.id, coin, size: dir * hedged, entryPx },
      { venue: this.b.id, coin, size: -dir * hedged, entryPx: midB },
    ];
    if (hedged === 0) {
      this.cycle.phase = 'failed';
      this.stats.failedCycles++;
      return 'done';
    }

    // Hold
    this.cycle.phase = 'holding';
    this.message = `Держу ${coin} до ${new Date(this.cycle.closeAt).toLocaleTimeString()}`;
    this.emit();
    while (this.now() < this.cycle.closeAt && !this.stopRequested) {
      await this.sleep(Math.min(CHECK_EVERY_MS, this.cycle.closeAt - this.now()), () => this.stopRequested);
      try {
        await this.checkDelta(coin, track);
      } catch (err) {
        if (!isTransient(err)) throw err;
        this.log('warn', `${coin}: проверка дельты не удалась (${errMsg(err)}), повторю позже`);
      }
    }

    // Close both legs
    this.cycle.phase = 'closing';
    this.message = `Закрываю ${coin}`;
    this.emit();
    await this.closeLegs(coin, useMaker && !this.stopRequested, track);

    this.cycle.phase = 'done';
    this.stats.cycles++;
    this.stats.realizedPnlTodayUsd += cash;
    this.stats.totalRealizedPnlUsd += cash;
    this.log('info', `Цикл #${this.cycle.id} ${coin} закрыт, результат $${cash.toFixed(3)} (комиссии + спред)`);
    return 'done';
  }

  /**
   * Opens `target` (signed, base units) on leg A — as maker when `useMaker` — and hedges exactly
   * what fills on leg B. An unhedged remainder is unwound on A.
   */
  private async openLegs(coin: string, target: number, useMaker: boolean, track: (v: Venue, q: number, f: Fill) => void) {
    const dir = Math.sign(target);
    const size = Math.abs(target);
    let filledA = 0;
    let hedged = 0;
    let entryPx = 0;
    if (useMaker && this.a.postOnly && this.a.cancel) {
      // Leg A rests post-only at the top of its book; every fill is hedged on B right away.
      filledA = await this.makerFill(this.a, coin, dir * size, false, async (delta, px) => {
        entryPx = px;
        hedged += await this.fillWithRetries(this.b, coin, -dir * delta, false, track);
      }, track);
    } else {
      filledA = await this.fillWithRetries(this.a, coin, dir * size, false, (v, q, f) => {
        entryPx = f.avgPx;
        track(v, q, f);
      });
      if (filledA > 0) hedged = await this.fillWithRetries(this.b, coin, -dir * filledA, false, track);
    }
    const unhedged = filledA - hedged;
    if (unhedged >= this.a.spec(coin).sizeStep) {
      this.log('warn', `Захеджировано ${hedged} из ${filledA}, откатываю остаток на ${this.a.label}`);
      const posA = await this.retry(() => this.a.position(coin), `${this.a.label}: позиция`);
      const safeReduce = Math.sign(posA) === dir && Math.abs(posA) >= unhedged;
      await this.fillWithRetries(this.a, coin, -dir * unhedged, safeReduce, track);
    }
    return { filledA, hedged, entryPx };
  }

  /**
   * Closes the bot's own exposure on both legs (or only `amount` of it): leg A as maker first with
   * every fill mirrored on B, then whatever is left as taker.
   */
  private async closeLegs(coin: string, useMaker: boolean, track: (v: Venue, q: number, f: Fill) => void, amount?: number) {
    const expA = await this.own(this.a, coin);
    const step = this.a.spec(coin).sizeStep;
    const part = amount === undefined ? Math.abs(expA) : Math.min(Math.abs(expA), amount);
    if (part < step) return;
    const target = -Math.sign(expA) * part;
    let closed = 0;
    if (useMaker && this.a.postOnly && this.a.cancel) {
      const posA = await this.retry(() => this.a.position(coin), `${this.a.label}: позиция`);
      const reduceOnly = Math.sign(posA) === Math.sign(expA) && part <= Math.abs(posA);
      closed = await this.makerFill(this.a, coin, target, reduceOnly, async (delta) => {
        const posB = await this.retry(() => this.b.position(coin), `${this.b.label}: позиция`);
        const closeB = Math.sign(expA) * delta;
        await this.fillWithRetries(this.b, coin, closeB, Math.sign(posB) === -Math.sign(closeB), track);
      }, track);
    }
    if (amount === undefined) {
      await this.closeOwn(this.a, coin, track);
      await this.closeOwn(this.b, coin, track);
      return;
    }
    // Partial close: finish the rest of `part` as taker, then re-align B to A.
    const rest = part - closed;
    if (rest >= step) {
      const posA = await this.retry(() => this.a.position(coin), `${this.a.label}: позиция`);
      const done = await this.fillWithRetries(this.a, coin, Math.sign(target) * rest, Math.sign(posA) === Math.sign(expA), track);
      if (done > 0) await this.fillWithRetries(this.b, coin, Math.sign(expA) * done, false, track);
    }
  }

  // ---------- long-lived mirrored positions (autopilot) ----------

  /** Positions that existed before the autopilot opened `coin`, so they are never touched. */
  holdBaseline(coin: string): { a: number; b: number } | null {
    const a = this.baseline.get(this.key(this.a, coin));
    const b = this.baseline.get(this.key(this.b, coin));
    return a === undefined || b === undefined ? null : { a, b };
  }

  restoreHoldBaseline(coin: string, base: { a: number; b: number }) {
    this.baseline.set(this.key(this.a, coin), base.a);
    this.baseline.set(this.key(this.b, coin), base.b);
  }

  /** Signed own exposure on each leg for a held coin. */
  async holdExposure(coin: string): Promise<{ a: number; b: number }> {
    const [a, b] = await Promise.all([this.own(this.a, coin), this.own(this.b, coin)]);
    return { a, b };
  }

  /** Adds `target` (signed, base units) to the mirrored position on `coin`. Returns the hedged size. */
  async holdOpen(coin: string, target: number, useMaker = true): Promise<number> {
    await Promise.all([this.a.init(), this.b.init()]);
    if (!this.holdBaseline(coin)) {
      const [pa, pb] = await Promise.all([
        this.retry(() => this.a.position(coin), `${this.a.label}: позиция`),
        this.retry(() => this.b.position(coin), `${this.b.label}: позиция`),
      ]);
      this.restoreHoldBaseline(coin, { a: pa, b: pb });
    }
    const { hedged } = await this.openLegs(coin, target, useMaker, this.holdTrack(coin));
    this.emit();
    return hedged;
  }

  /** Closes `amount` (base units) of the mirrored position, or all of it. */
  async holdClose(coin: string, amount?: number, useMaker = true) {
    await this.closeLegs(coin, useMaker, this.holdTrack(coin), amount);
    if (amount === undefined) {
      this.baseline.delete(this.key(this.a, coin));
      this.baseline.delete(this.key(this.b, coin));
    }
    this.emit();
  }

  /** Re-aligns the hedge leg if the two legs drifted apart. */
  async holdAlign(coin: string) {
    await this.checkDelta(coin, this.holdTrack(coin));
  }

  private holdTrack(coin: string) {
    return (venue: Venue, signedQty: number, fill: Fill) => {
      if (fill.filledSize <= 0) return;
      this.recordFill(venue.id, fill);
      this.stats.totalRealizedPnlUsd -= fill.feeUsd;
      this.stats.realizedPnlTodayUsd -= fill.feeUsd;
      this.log('trade', `${venue.label} ${signedQty > 0 ? 'BUY' : 'SELL'} ${+fill.filledSize.toPrecision(8)} ${coin} @ ${fill.avgPx}`);
    };
  }

  /**
   * Works `target` (signed) on `venue` with post-only orders at the top of the book, re-quoting up to
   * MAKER_REQUOTES times. `onFill(delta, px)` is called as soon as each new fill is seen, so the
   * other leg can be hedged immediately. Returns the absolute filled size.
   */
  private async makerFill(
    venue: Venue,
    coin: string,
    target: number,
    reduceOnly: boolean,
    onFill: (delta: number, px: number) => Promise<void>,
    track: (v: Venue, q: number, f: Fill) => void,
    budget?: { waitSec: number; requotes: number },
  ): Promise<number> {
    const spec = venue.spec(coin);
    const waitSec = budget?.waitSec ?? this.config.makerWaitSec;
    const requotes = budget?.requotes ?? this.config.makerRequotes ?? 3;
    const sign = Math.sign(target);
    const want = Math.abs(target);
    const start = await this.retry(() => venue.position(coin), `${venue.label}: позиция`);
    let reported = 0;

    const report = async (px: number) => {
      const pos = await this.retry(() => venue.position(coin), `${venue.label}: позиция`);
      const filled = Math.max(0, Math.min(want, sign * (pos - start)));
      const delta = Number((filled - reported).toFixed(10));
      if (delta >= spec.sizeStep / 2) {
        reported = filled;
        track(venue, sign * delta, { filledSize: delta, avgPx: px, feeUsd: delta * px * (spec.makerFeeBps / 10_000) });
        await onFill(delta, px);
      }
    };

    for (let q = 0; q < Math.max(1, requotes) && want - reported >= spec.sizeStep && !this.stopRequested; q++) {
      const book = await this.retry(() => venue.book(coin), `${venue.label}: стакан`);
      const px = sign > 0 ? book.bid : book.ask;
      let id: string | null = null;
      try {
        id = await venue.postOnly!(coin, sign * (want - reported), px, reduceOnly);
      } catch (err) {
        if (!isTransient(err)) throw err;
        // The order may or may not exist; any fill is still picked up from the position below.
        this.log('warn', `${venue.label}: мейкер-ордер не подтвердился (${errMsg(err)}), переставляю`);
        await this.sleep(backoff(q), () => false);
        await report(px);
        continue;
      }
      if (!id) continue; // book moved and the order would have crossed: re-quote
      const deadline = this.now() + waitSec * 1000;
      while (this.now() < deadline && !this.stopRequested) {
        await this.sleep(MAKER_POLL_MS, () => this.stopRequested);
        await report(px);
        if (want - reported < spec.sizeStep) break;
      }
      try {
        await this.retry(() => venue.cancel!(coin, id!), `${venue.label}: отмена ордера`);
      } catch (err) {
        this.log('error', `${venue.label}: не удалось отменить ордер ${id} — ${errMsg(err)}. Проверь открытые ордера на бирже`);
      }
      await report(px); // fills that landed between the last poll and the cancel
    }
    return reported;
  }

  private recordFill(venue: BotVenueId, fill: Fill) {
    const usd = fill.filledSize * fill.avgPx;
    const v = (this.stats.perVenue[venue] ??= { volumeUsd: 0, feesUsd: 0, trades: 0 });
    v.volumeUsd += usd;
    v.feesUsd += fill.feeUsd;
    v.trades++;
    this.stats.volumeTodayUsd += usd;
    this.stats.totalVolumeUsd += usd;
    this.stats.totalFeesUsd += fill.feeUsd;
  }

  /** Repeats IOC orders with growing slippage until `target` is filled. Returns the filled absolute size. */
  private async fillWithRetries(
    venue: Venue,
    coin: string,
    target: number,
    reduceOnly: boolean,
    track: (v: Venue, q: number, f: Fill) => void,
  ): Promise<number> {
    const step = venue.spec(coin).sizeStep;
    const want = Math.abs(target);
    const sign = Math.sign(target);
    if (want < step) return 0;
    const start = await this.retry(() => venue.position(coin), `${venue.label}: позиция`);
    let reported = 0;
    let noFill = 0;
    let netErrors = 0;
    while (want - reported >= step && noFill < HEDGE_RETRIES && netErrors < NET_RETRIES) {
      const slip = this.config.slippageBps * 2 ** Math.min(noFill + netErrors, 3);
      let fill: Fill | null = null;
      try {
        fill = await venue.ioc(coin, sign * roundToStep(want - reported, step), slip, reduceOnly);
      } catch (err) {
        if (!isTransient(err)) throw err;
        netErrors++;
        this.log('warn', `${venue.label}: сетевая ошибка (${errMsg(err)}), проверяю позицию и повторяю`);
        await this.sleep(backoff(netErrors - 1), () => false);
      }
      // The position is the source of truth: an order can fill even when its response is lost.
      const pos = await this.retry(() => venue.position(coin), `${venue.label}: позиция`);
      const actual = Math.max(0, Math.min(want, sign * (pos - start)));
      const delta = Number((actual - reported).toFixed(10));
      if (delta >= step / 2) {
        let f: Fill;
        if (fill && fill.filledSize > 0) {
          f = { filledSize: delta, avgPx: fill.avgPx, feeUsd: (fill.feeUsd * delta) / fill.filledSize };
        } else {
          const b = await this.retry(() => venue.book(coin), `${venue.label}: стакан`);
          const px = sign > 0 ? b.ask : b.bid;
          f = { filledSize: delta, avgPx: px, feeUsd: delta * px * (venue.spec(coin).takerFeeBps / 10_000) };
        }
        track(venue, sign * delta, f);
        reported = actual;
      } else if (fill) {
        noFill++;
      }
    }
    return reported;
  }

  /** Retries transient network failures (timeouts, resets, 429/5xx) with exponential backoff. */
  private async retry<T>(fn: () => Promise<T>, what: string, attempts = NET_RETRIES): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (!isTransient(err) || i >= attempts - 1) throw err;
        this.log('warn', `${what}: ${errMsg(err)} — повтор через ${Math.round(backoff(i) / 1000)} c`);
        await this.sleep(backoff(i), () => false);
      }
    }
  }

  private async closePosition(venue: Venue, coin: string, track?: (v: Venue, q: number, f: Fill) => void) {
    const pos = await this.retry(() => venue.position(coin), `${venue.label}: позиция`);
    if (Math.abs(pos) < venue.spec(coin).sizeStep) return;
    const record = track ?? ((v: Venue, _q: number, f: Fill) => f.filledSize > 0 && this.recordFill(v.id, f));
    const done = await this.fillWithRetries(venue, coin, -pos, true, record);
    if (Math.abs(pos) - done >= venue.spec(coin).sizeStep) {
      throw new Error(`${venue.label} ${coin}: закрыто ${done} из ${Math.abs(pos)}`);
    }
  }

  /** If the two legs drift apart (partial fills, liquidation, manual trades) — re-align on venue B. */
  private async checkDelta(coin: string, track: (v: Venue, q: number, f: Fill) => void) {
    const [pa, pb, book] = await Promise.all([this.own(this.a, coin), this.own(this.b, coin), this.b.book(coin)]);
    const net = pa + pb;
    const px = (book.bid + book.ask) / 2;
    if (Math.abs(net) * px > this.config.deltaToleranceUsd) {
      this.log('warn', `${coin}: дельта ${net.toFixed(6)} (~$${(Math.abs(net) * px).toFixed(0)}), выравниваю на ${this.b.label}`);
      await this.fillWithRetries(this.b, coin, -net, false, track);
    }
  }

  // ---------- manual Omni hedges ----------

  /** The user opened `size` on Variational Omni by hand; open the opposite side on `venueId`. */
  async openManualHedge(coin: string, omniSide: 'long' | 'short', size: number, venueId: BotVenueId, maker = false): Promise<ManualHedge> {
    const venue = this.venue(venueId);
    await venue.init();
    if (!venue.hasMarket(coin)) throw new Error(`${venue.label}: нет рынка ${coin}`);
    const target = omniSide === 'long' ? -size : size;
    let px = 0;
    const track = (v: Venue, q: number, f: Fill) => {
      if (f.filledSize > 0) {
        this.recordFill(v.id, f);
        px = f.avgPx;
        this.log('trade', `Хедж Omni: ${v.label} ${q > 0 ? 'BUY' : 'SELL'} ${+f.filledSize.toPrecision(8)} ${coin} @ ${f.avgPx}`);
      }
    };
    let filled = 0;
    if (maker && venue.postOnly && venue.cancel) {
      // Maker first (cheap); whatever did not fill within the wait is completed as taker.
      // Keep a person waiting at most ~1 minute; the rest is filled as taker.
      filled = await this.makerFill(venue, coin, target, false, async () => {}, track, { waitSec: 20, requotes: 3 });
    }
    const rest = Math.abs(target) - filled;
    if (rest >= venue.spec(coin).sizeStep) filled += await this.fillWithRetries(venue, coin, Math.sign(target) * rest, false, track);
    this.shiftBaseline(venueId, coin, Math.sign(target) * filled);
    const hedge: ManualHedge = {
      id: `${this.now()}-${coin}`,
      coin,
      omniSide,
      size,
      hedgeVenue: venueId,
      hedgeSize: Math.sign(target) * filled,
      hedgePx: px,
      openedAt: this.now(),
      status: filled > 0 ? 'open' : 'failed',
    };
    this.hedges = [hedge, ...this.hedges].slice(0, 50);
    if (filled < Math.abs(target)) this.log('warn', `Хедж исполнен частично: ${filled} из ${Math.abs(target)}`);
    this.emit();
    return hedge;
  }

  private shiftBaseline(venueId: BotVenueId, coin: string, delta: number) {
    const k = this.key(venueId, coin);
    if (this.baseline.has(k)) this.baseline.set(k, (this.baseline.get(k) ?? 0) + delta);
  }

  async closeManualHedge(id: string) {
    const hedge = this.hedges.find((h) => h.id === id);
    if (!hedge || hedge.status !== 'open') return;
    const venue = this.venue(hedge.hedgeVenue);
    await venue.init();
    const done = await this.fillWithRetries(venue, hedge.coin, -hedge.hedgeSize, true, (v, q, f) => {
      if (f.filledSize > 0) {
        this.recordFill(v.id, f);
        this.log('trade', `Закрытие хеджа: ${v.label} ${q > 0 ? 'BUY' : 'SELL'} ${f.filledSize} ${hedge.coin} @ ${f.avgPx}`);
      }
    });
    this.shiftBaseline(hedge.hedgeVenue, hedge.coin, -Math.sign(hedge.hedgeSize) * done);
    if (done < Math.abs(hedge.hedgeSize)) this.log('warn', `Хедж закрыт частично: ${done} из ${Math.abs(hedge.hedgeSize)}`);
    hedge.status = 'closed';
    this.emit();
  }
}

/** Network-level failures worth retrying (the request may or may not have reached the venue). */
export function isTransient(err: unknown): boolean {
  return /timeout|timed out|aborted|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket|fetch failed|network|\b429\b|\b50[0-4]\b|Too Many Requests|Bad Gateway|Service Unavailable/i.test(
    errMsg(err),
  );
}

function backoff(i: number): number {
  return Math.min(1000 * 2 ** i, 15_000);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
