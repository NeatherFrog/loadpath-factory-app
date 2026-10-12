import type { BotVenueId } from '../../../shared/types';
import type { Book, Fill, MarketSpec, Venue } from '../venue';
import { roundToStep } from '../math';

export interface PublicMarketSource {
  load(): Promise<Map<string, MarketSpec>>;
  book(coin: string): Promise<Book>;
  fundingApr(coin: string): Promise<number | null>;
}

/**
 * Paper trading: real public order books, simulated fills at top of book.
 * Lets you run the full strategy without keys or money.
 */
export class PaperVenue implements Venue {
  readonly isPaper = true;
  private specs = new Map<string, MarketSpec>();
  private positions = new Map<string, number>();
  private cash = 0;
  private resting = new Map<string, { coin: string; size: number; price: number }>();
  private lastPx = new Map<string, number>();
  private seq = 0;

  constructor(
    readonly id: BotVenueId,
    readonly label: string,
    private source: PublicMarketSource,
    private startingEquity = 1_000,
  ) {}

  private ready = false;

  async init() {
    if (this.ready) return;
    this.specs = await this.source.load();
    this.cash = this.startingEquity;
    this.ready = true;
  }

  hasMarket(coin: string) {
    return this.specs.has(coin);
  }

  spec(coin: string): MarketSpec {
    const s = this.specs.get(coin);
    if (!s) throw new Error(`${this.label}: no market ${coin}`);
    return s;
  }

  book(coin: string) {
    return this.source.book(coin);
  }

  async position(coin: string) {
    await this.settleMakers(coin);
    return this.positions.get(coin) ?? 0;
  }

  /** Resting post-only orders fill once the opposite side of the book trades through their price. */
  private async settleMakers(coin: string) {
    const orders = [...this.resting].filter(([, o]) => o.coin === coin);
    if (!orders.length) return;
    const b = await this.source.book(coin);
    const spec = this.spec(coin);
    for (const [id, o] of orders) {
      const crossed = o.size > 0 ? b.ask <= o.price : b.bid >= o.price;
      if (!crossed) continue;
      this.resting.delete(id);
      const cur = this.positions.get(coin) ?? 0;
      this.positions.set(coin, Number((cur + o.size).toFixed(10)));
      this.lastPx.set(coin, o.price);
      this.cash -= o.size * o.price + Math.abs(o.size) * o.price * (spec.makerFeeBps / 10_000);
    }
  }

  async postOnly(coin: string, size: number, price: number): Promise<string | null> {
    const spec = this.spec(coin);
    const b = await this.source.book(coin);
    if ((size > 0 && price >= b.ask) || (size < 0 && price <= b.bid)) return null;
    const id = `p${++this.seq}`;
    this.resting.set(id, { coin, size: roundToStep(size, spec.sizeStep), price });
    return id;
  }

  async cancel(_coin: string, orderId: string) {
    this.resting.delete(orderId);
  }

  /** Cash plus open positions marked at their last trade price. */
  async equityUsd() {
    let eq = this.cash;
    for (const [coin, pos] of this.positions) eq += pos * (this.lastPx.get(coin) ?? 0);
    return eq;
  }

  fundingApr(coin: string) {
    return this.source.fundingApr(coin);
  }

  async ioc(coin: string, size: number, _slippageBps: number, reduceOnly = false): Promise<Fill> {
    const spec = this.spec(coin);
    const current = this.positions.get(coin) ?? 0;
    let qty = roundToStep(size, spec.sizeStep);
    if (reduceOnly) {
      if (Math.sign(qty) === Math.sign(current) || current === 0) return { filledSize: 0, avgPx: 0, feeUsd: 0 };
      if (Math.abs(qty) > Math.abs(current)) qty = -current;
    }
    const b = await this.source.book(coin);
    const px = qty > 0 ? b.ask : b.bid;
    const feeUsd = Math.abs(qty) * px * (spec.takerFeeBps / 10_000);
    this.positions.set(coin, Number((current + qty).toFixed(10)));
    this.lastPx.set(coin, px);
    this.cash -= qty * px + feeUsd;
    return { filledSize: Math.abs(qty), avgPx: px, feeUsd };
  }
}
