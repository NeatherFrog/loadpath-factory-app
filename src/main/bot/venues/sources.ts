import type { MarketSpec } from '../venue';
import type { PublicMarketSource } from './paper';
import { fetchNadoBook, fetchNadoContracts, fetchNadoMarkets } from '../../data/nadoPublic';
import { fetchHlBook, fetchHlMeta, type HlAssetCtx } from '../../data/hlPublic';
import { fetchLighterBook, fetchLighterFunding, fetchLighterMarkets } from '../../data/lighterPublic';

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

/**
 * Hyperliquid public data. `dex` selects a HIP-3 dex ("io" = Entropy, "xyz" = trade.xyz); its
 * markets are exposed under plain coin names ("NBIS" for "io:NBIS") so both legs share one name.
 */
export function hlPublicSource(dex = ''): PublicMarketSource {
  let funding = new Map<string, number>();
  let fundingAt = 0;
  const full = (coin: string) => hlCoin(dex, coin);
  const refresh = (ctxs: HlAssetCtx[]) => {
    funding = new Map(ctxs.map((c) => [plainCoin(c.coin), c.funding * 24 * 365]));
    fundingAt = Date.now();
  };
  return {
    async load() {
      const { markets, ctxs } = await fetchHlMeta(dex);
      refresh(ctxs);
      return new Map<string, MarketSpec>([...markets].map(([coin, m]) => [plainCoin(coin), m.spec]));
    },
    book: (coin) => fetchHlBook(full(coin)),
    async fundingApr(coin) {
      if (Date.now() - fundingAt > FUNDING_TTL) refresh((await fetchHlMeta(dex)).ctxs);
      return funding.get(coin) ?? null;
    },
  };
}

/** "NBIS" on dex "io" → "io:NBIS"; main-dex coins are unchanged. */
export function hlCoin(dex: string, coin: string) {
  return dex ? `${dex}:${coin}` : coin;
}

/** "io:NBIS" → "NBIS". */
export function plainCoin(name: string) {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

export function lighterPublicSource(): PublicMarketSource {
  let ids = new Map<string, number>();
  let funding = new Map<string, number>();
  let fundingAt = 0;
  return {
    async load() {
      const markets = await fetchLighterMarkets();
      ids = new Map([...markets].map(([coin, m]) => [coin, m.marketId]));
      return new Map<string, MarketSpec>([...markets].map(([coin, m]) => [coin, m.spec]));
    },
    book(coin) {
      const id = ids.get(coin);
      if (id === undefined) throw new Error(`Lighter: no market ${coin}`);
      return fetchLighterBook(id);
    },
    async fundingApr(coin) {
      if (Date.now() - fundingAt > FUNDING_TTL) {
        funding = await fetchLighterFunding();
        fundingAt = Date.now();
      }
      return funding.get(coin) ?? null;
    },
  };
}
