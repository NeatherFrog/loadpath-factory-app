import { getJson, postJson } from './http';
import type { Book, MarketSpec } from '../bot/venue';

const BASE = 'https://api.prod.nado.xyz';
const X18 = 1e18;

export interface NadoMarket {
  productId: number;
  symbol: string; // e.g. BTC-PERP
  coin: string; // e.g. BTC
  spec: MarketSpec;
}

interface SymbolsResponse {
  status: string;
  data: {
    symbols: Record<
      string,
      {
        type: string;
        product_id: number;
        symbol: string;
        price_increment_x18: string;
        size_increment: string;
        min_size: string;
        taker_fee_rate_x18: string;
        trading_status: string;
      }
    >;
  };
}

export interface NadoContract {
  product_id: number;
  ticker_id: string;
  base_currency: string;
  quote_volume: number;
  open_interest_usd: number;
  index_price: number;
  mark_price: number;
  funding_rate: number; // 24h rate, decimal
}

export async function fetchNadoMarkets(): Promise<Map<string, NadoMarket>> {
  const res = await postJson<SymbolsResponse>(`${BASE}/gateway/v1/query`, { type: 'symbols', product_type: 'perp' });
  const out = new Map<string, NadoMarket>();
  for (const s of Object.values(res.data.symbols)) {
    if (s.type !== 'perp' || s.trading_status !== 'live') continue;
    const coin = s.symbol.replace(/-PERP$/, '');
    out.set(coin, {
      productId: s.product_id,
      symbol: s.symbol,
      coin,
      spec: {
        priceTick: Number(s.price_increment_x18) / X18,
        sizeStep: Number(s.size_increment) / X18,
        minNotionalUsd: Number(s.min_size) / X18,
        takerFeeBps: (Number(s.taker_fee_rate_x18) / X18) * 10_000,
      },
    });
  }
  return out;
}

export async function fetchNadoBook(symbol: string): Promise<Book> {
  const r = await getJson<{ bids: [number, number][]; asks: [number, number][]; timestamp: number }>(
    `${BASE}/gateway/v2/orderbook?ticker_id=${encodeURIComponent(symbol)}_USDT0&depth=1`,
  );
  if (!r.bids?.length || !r.asks?.length) throw new Error(`Nado: empty book for ${symbol}`);
  return { bid: r.bids[0][0], ask: r.asks[0][0], ts: r.timestamp };
}

export async function fetchNadoContracts(): Promise<NadoContract[]> {
  const r = await getJson<Record<string, NadoContract>>(`${BASE}/archive/v2/contracts`);
  return Object.values(r).filter((c) => c.ticker_id.includes('-PERP'));
}

export async function fetchNadoMarketPrices(productIds: number[]): Promise<Map<number, Book>> {
  const r = await postJson<{ data: { market_prices: { product_id: number; bid_x18: string; ask_x18: string }[] } }>(
    `${BASE}/gateway/v1/query`,
    { type: 'market_prices', product_ids: productIds },
  );
  const out = new Map<number, Book>();
  for (const p of r.data.market_prices) {
    out.set(p.product_id, { bid: Number(p.bid_x18) / X18, ask: Number(p.ask_x18) / X18, ts: Date.now() });
  }
  return out;
}
