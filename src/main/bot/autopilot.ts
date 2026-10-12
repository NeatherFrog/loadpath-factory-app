import type { AutopilotConfig, AutopilotEvent, AutopilotHold, AutopilotStatus } from '../../shared/types';
import type { DeltaNeutralEngine } from './engine';
import type { Venue } from './venue';
import { commonSize, utcDay } from './math';

/** Funding on both venues for one coin, annualized (positive = longs pay). */
export interface FundingQuote {
  coin: string;
  fNado: number;
  fHedge: number;
  price: number;
}

export interface Opportunity extends FundingQuote {
  /** Funding both legs earn together, per year, when taking the paid side on each venue. */
  edgeApr: number;
  nadoSide: 'long' | 'short';
}

export interface AutopilotDeps {
  nado: Venue;
  hedge: Venue;
  /** Engine over (nado, hedge) used only for the long-lived mirrored position. */
  holder: DeltaNeutralEngine;
  quotes: () => Promise<FundingQuote[]>;
  /** Called each tick with how much the churn engine may lose today (0 = stop churning). */
  churnBudget?: (usd: number, excludeCoin: string | null) => Promise<void> | void;
  save?: (s: AutopilotStatus) => void;
  onChange?: (s: AutopilotStatus) => void;
  now?: () => number;
  sleep?: (ms: number, wake: () => boolean) => Promise<void>;
  initial?: AutopilotStatus;
}

const YEAR_MS = 365 * 86_400_000;
const TICK_MS = 60_000;
const NEG_TICKS_TO_CLOSE = 3;
const MAX_EVENTS = 60;

export function bestOpportunities(quotes: FundingQuote[]): Opportunity[] {
  return quotes
    .map((q) => ({ ...q, edgeApr: Math.abs(q.fNado - q.fHedge), nadoSide: (q.fNado < q.fHedge ? 'long' : 'short') as 'long' | 'short' }))
    .sort((a, b) => b.edgeApr - a.edgeApr);
}

/** Funding the current mirrored position earns per year (negative = it pays). */
export function incomeApr(nadoSide: 'long' | 'short', fNado: number, fHedge: number): number {
  return nadoSide === 'long' ? fHedge - fNado : fNado - fHedge;
}

export function emptyAutopilotStatus(): AutopilotStatus {
  return {
    running: false,
    message: 'Выключен',
    hold: null,
    notionalUsd: 0,
    incomeApr: 0,
    fundingTotalUsd: 0,
    fundingTodayUsd: 0,
    day: utcDay(),
    equity: null,
    events: [],
  };
}

/**
 * Autopilot: keeps one mirrored position (long on one venue, short on the other) on the coin where
 * funding pays the most, sizes it to the available margin, switches when a clearly better coin
 * appears and closes when funding turns against it. Funding earned is spent on extra Nado volume
 * (points) through the churn engine, so points are farmed at ~zero net cost.
 */
export class Autopilot {
  private s: AutopilotStatus;
  private stopRequested = false;
  private loop: Promise<void> | null = null;
  private lastTick = 0;
  private negTicks = 0;
  private now: () => number;
  private sleep: NonNullable<AutopilotDeps['sleep']>;

  constructor(
    private cfg: AutopilotConfig,
    private d: AutopilotDeps,
  ) {
    this.now = d.now ?? Date.now;
    this.sleep =
      d.sleep ??
      (async (ms, wake) => {
        const end = Date.now() + ms;
        while (Date.now() < end && !wake()) await new Promise((r) => setTimeout(r, Math.min(500, end - Date.now())));
      });
    this.s = { ...emptyAutopilotStatus(), ...d.initial, running: false };
    if (this.s.hold) d.holder.restoreHoldBaseline(this.s.hold.coin, { a: this.s.hold.baseA, b: this.s.hold.baseB });
  }

  status(): AutopilotStatus {
    return this.s;
  }

  updateConfig(cfg: AutopilotConfig) {
    this.cfg = cfg;
  }

  private event(text: string, kind: AutopilotEvent['kind'] = 'info') {
    this.s.events = [{ ts: this.now(), text, kind }, ...this.s.events].slice(0, MAX_EVENTS);
  }

  private emit(message?: string) {
    if (message) this.s.message = message;
    this.d.onChange?.(this.s);
    this.d.save?.(this.s);
  }

  async start() {
    if (this.s.running) return;
    this.stopRequested = false;
    this.s.running = true;
    this.event('Автопилот запущен');
    this.emit('Запускаюсь…');
    try {
      await Promise.all([this.d.nado.init(), this.d.hedge.init()]);
    } catch (err) {
      this.s.running = false;
      this.event(`Не удалось подключиться к биржам: ${msg(err)}`, 'error');
      this.emit('Ошибка подключения');
      return;
    }
    this.lastTick = this.now();
    this.loop = this.run();
  }

  /** Stops the autopilot. The mirrored position stays open (it keeps earning) unless `closePosition`. */
  async stop(closePosition = false) {
    this.stopRequested = true;
    await this.loop;
    if (closePosition && this.s.hold) await this.closeHold('Остановка: закрываю позицию');
    await this.d.churnBudget?.(0, null);
    this.s.running = false;
    this.event(closePosition ? 'Автопилот остановлен, позиция закрыта' : 'Автопилот остановлен (позиция оставлена — она продолжает приносить фандинг)');
    this.emit('Выключен');
  }

  private async run() {
    while (!this.stopRequested) {
      try {
        await this.tick();
      } catch (err) {
        this.event(`Ошибка: ${msg(err)}. Повторю через минуту`, 'error');
        this.emit('Ошибка, повторяю');
      }
      await this.sleep(TICK_MS, () => this.stopRequested);
    }
  }

  /** One decision step. Public for tests. */
  async tick() {
    const now = this.now();
    if (this.s.day !== utcDay(now)) {
      this.s.day = utcDay(now);
      this.s.fundingTodayUsd = 0;
    }

    const quotes = (await this.d.quotes()).filter((q) => this.d.nado.hasMarket(q.coin) && this.d.hedge.hasMarket(q.coin));
    const opps = bestOpportunities(quotes);
    const best = opps[0];
    const [eqA, eqB] = await Promise.all([this.d.nado.equityUsd(), this.d.hedge.equityUsd()]);
    this.s.equity = eqA !== null && eqB !== null ? { nado: eqA, hedge: eqB } : null;
    const margin = Math.min(eqA ?? 0, eqB ?? 0);
    let target = margin * this.cfg.leverage * 0.9;
    if (this.cfg.maxNotionalUsd > 0) target = Math.min(target, this.cfg.maxNotionalUsd);

    const hold = this.s.hold;
    if (hold) {
      const q = quotes.find((x) => x.coin === hold.coin);
      const exp = await this.d.holder.holdExposure(hold.coin);
      const price = q?.price ?? 0;
      this.s.notionalUsd = Math.abs(exp.a) * price;

      // Funding accrued since the last tick (estimate from current rates).
      if (q) {
        this.s.incomeApr = incomeApr(hold.nadoSide, q.fNado, q.fHedge);
        const earned = (this.s.notionalUsd * this.s.incomeApr * (now - this.lastTick)) / YEAR_MS;
        this.s.fundingTotalUsd += earned;
        this.s.fundingTodayUsd += earned;
      }

      if (!q) {
        this.event(`${hold.coin}: нет данных о фандинге, пропускаю шаг`, 'warn');
      } else if (this.s.incomeApr < 0) {
        this.negTicks++;
        if (this.negTicks >= NEG_TICKS_TO_CLOSE) {
          await this.closeHold(`${hold.coin}: биржи перестали платить (фандинг против нас) — закрываю`);
          this.negTicks = 0;
        }
      } else {
        this.negTicks = 0;
        const heldHours = (now - hold.openedAt) / 3_600_000;
        if (
          best &&
          best.coin !== hold.coin &&
          best.edgeApr - this.s.incomeApr >= this.cfg.switchExtraApr &&
          heldHours >= this.cfg.minHoldHours
        ) {
          await this.closeHold(`Нашёл выгоднее: ${best.coin} (${pct(best.edgeApr)} в год против ${pct(this.s.incomeApr)}) — переключаюсь`);
        } else if (price > 0 && target > 0) {
          await this.resize(hold, price, target);
          await this.d.holder.holdAlign(hold.coin);
        }
      }
    }

    if (!this.s.hold && !this.stopRequested) {
      if (best && best.edgeApr >= this.cfg.minEdgeApr && target >= 20) {
        await this.openHold(best, target);
      } else {
        this.s.notionalUsd = 0;
        this.s.incomeApr = 0;
        this.emit(target < 20 ? 'Мало денег на биржах — пополни Nado и хедж-биржу' : 'Жду выгодную монету');
      }
    }

    // Spend funding earned today (+ the user's daily budget) on extra Nado volume for points.
    if (this.d.churnBudget) {
      const budget = this.cfg.churn ? this.cfg.dailyBudgetUsd + Math.max(0, this.s.fundingTodayUsd) : 0;
      await this.d.churnBudget(budget, this.s.hold?.coin ?? null);
    }

    this.lastTick = now;
    if (this.s.hold) {
      const side = this.s.hold.nadoSide === 'long' ? 'LONG' : 'SHORT';
      const other = this.s.hold.nadoSide === 'long' ? 'SHORT' : 'LONG';
      this.emit(`Держу ${this.s.hold.coin}: Nado ${side} / ${this.d.hedge.label} ${other}`);
    } else {
      this.emit();
    }
  }

  /** Base size both venues can trade exactly (common multiple of their lot steps). */
  private size(coin: string, usd: number, price: number): number {
    return commonSize(usd, price, this.d.nado.spec(coin).sizeStep, this.d.hedge.spec(coin).sizeStep);
  }

  private async openHold(o: Opportunity, target: number) {
    const slice = Math.min(this.cfg.sliceUsd, target);
    const dir = o.nadoSide === 'long' ? 1 : -1;
    const size = this.size(o.coin, slice, o.price);
    if (size <= 0) return;
    const hedged = await this.d.holder.holdOpen(o.coin, dir * size);
    if (hedged <= 0) {
      this.event(`${o.coin}: ордер на Nado не исполнился, попробую позже`, 'warn');
      return;
    }
    const base = this.d.holder.holdBaseline(o.coin) ?? { a: 0, b: 0 };
    const hold: AutopilotHold = { coin: o.coin, nadoSide: o.nadoSide, openedAt: this.now(), baseA: base.a, baseB: base.b };
    this.s.hold = hold;
    this.s.notionalUsd = hedged * o.price;
    this.s.incomeApr = o.edgeApr;
    this.event(
      `Открыл ${o.coin} на ${usd(hedged * o.price)}: Nado ${o.nadoSide === 'long' ? 'LONG' : 'SHORT'}, ${this.d.hedge.label} ${o.nadoSide === 'long' ? 'SHORT' : 'LONG'}. Биржи платят ≈ ${pct(o.edgeApr)} в год`,
      'trade',
    );
  }

  private async resize(hold: AutopilotHold, price: number, target: number) {
    const cur = this.s.notionalUsd;
    const dir = hold.nadoSide === 'long' ? 1 : -1;
    if (cur < target * 0.8) {
      const add = Math.min(this.cfg.sliceUsd, target - cur);
      if (add < 20) return;
      const size = this.size(hold.coin, add, price);
      if (size <= 0) return;
      const hedged = await this.d.holder.holdOpen(hold.coin, dir * size);
      if (hedged > 0) {
        this.s.notionalUsd += hedged * price;
        this.event(`Добавил ${usd(hedged * price)} к ${hold.coin} (всего ${usd(this.s.notionalUsd)})`, 'trade');
      }
    } else if (cur > target * 1.25) {
      // Margin shrank (losses on one leg or a withdrawal): reduce to stay safe from liquidation.
      const cut = Math.min(this.cfg.sliceUsd, cur - target);
      const size = this.size(hold.coin, cut, price);
      if (size <= 0) return;
      await this.d.holder.holdClose(hold.coin, size);
      this.s.notionalUsd -= cut;
      this.event(`Уменьшил ${hold.coin} на ${usd(cut)}: денег на одной из бирж стало меньше`, 'warn');
    }
  }

  private async closeHold(reason: string) {
    const hold = this.s.hold;
    if (!hold) return;
    this.event(reason, 'trade');
    await this.d.holder.holdClose(hold.coin);
    this.s.hold = null;
    this.s.notionalUsd = 0;
    this.s.incomeApr = 0;
    this.emit('Позиция закрыта');
  }
}

function msg(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function pct(x: number) {
  return `${(x * 100).toFixed(1)}%`;
}

function usd(x: number) {
  return `$${x.toFixed(0)}`;
}
