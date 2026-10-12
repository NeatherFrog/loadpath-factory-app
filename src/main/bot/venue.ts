import type { BotVenueId } from '../../shared/types';

export interface Book {
  bid: number;
  ask: number;
  ts: number;
}

export interface MarketSpec {
  sizeStep: number; // base units
  priceTick: number;
  minNotionalUsd: number;
  takerFeeBps: number;
  makerFeeBps: number;
}

export interface Fill {
  filledSize: number; // absolute base size actually filled
  avgPx: number;
  feeUsd: number;
}

/** A trading venue as seen by the delta-neutral engine. Sizes are base units, side via sign. */
export interface Venue {
  readonly id: BotVenueId;
  readonly label: string;
  readonly isPaper: boolean;
  init(): Promise<void>;
  hasMarket(coin: string): boolean;
  spec(coin: string): MarketSpec;
  book(coin: string): Promise<Book>;
  /** Signed position size in base units (long > 0). */
  position(coin: string): Promise<number>;
  equityUsd(): Promise<number | null>;
  /**
   * Aggressive immediate-or-cancel order. `size` is signed (buy > 0).
   * The limit price is the top of book moved by `slippageBps`, so it never fills worse.
   */
  ioc(coin: string, size: number, slippageBps: number, reduceOnly?: boolean): Promise<Fill>;
  /** Annualized funding (decimal), positive = longs pay. */
  fundingApr(coin: string): Promise<number | null>;
  /**
   * Optional maker support: rests a post-only limit order. Returns an order id, or null when
   * the price would have crossed the book (post-only rejected).
   */
  postOnly?(coin: string, size: number, price: number, reduceOnly?: boolean): Promise<string | null>;
  cancel?(coin: string, orderId: string): Promise<void>;
}
