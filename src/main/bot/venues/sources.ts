import type { MarketSpec } from '../venue';
import type { PublicMarketSource } from './paper';
import { fetchNadoBook, fetchNadoContracts, fetchNadoMarkets } from '../../data/nadoPublic';
import { fetchHlBook, fetchHlMeta } from '../../data/hlPublic';

const FUNDING_TTL = 60_000;

export function nadoPublicSource(): PublicMarketSource {
  let symbols = new Map<string, string>();
  let funding = new Map<string, number>();
  let fundingAt = 0;
  return {
    async load() {
      const markets = await fetchNadoMarkets();
      symbols = new Map([...markets].map(([coin, m]) => [coin, m.symbol]));
      return new Map<string, MarketSpec>([...markets].map(([coin, m]) => [coin, m.spec]));
    },
    book(coin) {
      const symbol = symbols.get(coin);
      if (!symbol) throw new Error(`Nado: no market ${coin}`);
      return fetchNadoBook(symbol);
    },
    async fundingApr(coin) {
      if (Date.now() - fundingAt > FUNDING_TTL) {
        const contracts = await fetchNadoContracts();
        funding = new Map(contracts.map((c) => [c.base_currency.replace(/-PERP$/, ''), c.funding_rate * 365]));
        fundingAt = Date.now();
      }
      return funding.get(coin) ?? null;
    },
  };
}

export function hlPublicSource(): PublicMarketSource {
  let funding = new Map<string, number>();
  let fundingAt = 0;
  return {
    async load() {
      const { markets, ctxs } = await fetchHlMeta();
      funding = new Map(ctxs.map((c) => [c.coin, c.funding * 24 * 365]));
      fundingAt = Date.now();
      return new Map<string, MarketSpec>([...markets].map(([coin, m]) => [coin, m.spec]));
    },
    book: (coin) => fetchHlBook(coin),
    async fundingApr(coin) {
      if (Date.now() - fundingAt > FUNDING_TTL) {
        const { ctxs } = await fetchHlMeta();
        funding = new Map(ctxs.map((c) => [c.coin, c.funding * 24 * 365]));
        fundingAt = Date.now();
      }
      return funding.get(coin) ?? null;
    },
  };
}
