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
    return this.positions.get(coin) ?? 0;
  }

  async equityUsd() {
    return this.cash;
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
    this.cash -= qty * px + feeUsd;
    return { filledSize: Math.abs(qty), avgPx: px, feeUsd };
  }
}
