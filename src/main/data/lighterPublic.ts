import { getJson } from './http';
import type { Book, MarketSpec } from '../bot/venue';

export const LIGHTER_API = 'https://mainnet.zklighter.elliot.ai';

export interface LighterMarket {
  marketId: number;
  coin: string;
  sizeDecimals: number;
  priceDecimals: number;
  spec: MarketSpec;
}

interface OrderBooksResponse {
  order_books: {
    symbol: string;
    market_id: number;
    market_type: string;
    status: string;
    taker_fee: string;
    maker_fee: string;
    min_base_amount: string;
    min_quote_amount: string;
    supported_size_decimals: number;
    supported_price_decimals: number;
  }[];
}

export async function fetchLighterMarkets(): Promise<Map<string, LighterMarket>> {
  const r = await getJson<OrderBooksResponse>(`${LIGHTER_API}/api/v1/orderBooks`);
  const out = new Map<string, LighterMarket>();
  for (const o of r.order_books) {
    if (o.market_type !== 'perp' || o.status !== 'active') continue;
    out.set(o.symbol, {
      marketId: o.market_id,
      coin: o.symbol,
      sizeDecimals: o.supported_size_decimals,
      priceDecimals: o.supported_price_decimals,
      spec: {
        sizeStep: 10 ** -o.supported_size_decimals,
        priceTick: 10 ** -o.supported_price_decimals,
        minNotionalUsd: Number(o.min_quote_amount) || 10,
        // Fees are quoted in percent ("0.0000"); standard accounts trade for free.
        takerFeeBps: Number(o.taker_fee) * 100,
        makerFeeBps: Number(o.maker_fee) * 100,
      },
    });
  }
  return out;
}

export async function fetchLighterBook(marketId: number): Promise<Book> {
  const r = await getJson<{ bids: { price: string }[]; asks: { price: string }[] }>(
    `${LIGHTER_API}/api/v1/orderBookOrders?market_id=${marketId}&limit=1`,
  );
  if (!r.bids?.length || !r.asks?.length) throw new Error(`Lighter: empty book for market ${marketId}`);
  return { bid: Number(r.bids[0].price), ask: Number(r.asks[0].price), ts: Date.now() };
}

/** Lighter funding per coin, annualized. The API quotes an 8-hour rate. */
export async function fetchLighterFunding(): Promise<Map<string, number>> {
  const r = await getJson<{ funding_rates: { exchange: string; symbol: string; rate: number }[] }>(
    `${LIGHTER_API}/api/v1/funding-rates`,
  );
  return new Map(r.funding_rates.filter((f) => f.exchange === 'lighter').map((f) => [f.symbol, f.rate * 3 * 365]));
}
