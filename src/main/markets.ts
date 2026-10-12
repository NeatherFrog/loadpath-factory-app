import type { MarketRow, MarketSnapshot, VenueId, VenueQuote } from '../shared/types';
import { fetchOmniStats } from './data/variationalPublic';
import { fetchNadoContracts, fetchNadoMarketPrices, fetchNadoMarkets } from './data/nadoPublic';
import { fetchHlMeta } from './data/hlPublic';

function bps(bid: number, ask: number) {
  const mid = (bid + ask) / 2;
  return mid > 0 ? ((ask - bid) / mid) * 10_000 : NaN;
}

function quote(venue: VenueId, coin: string, bid: number, ask: number, extra: Partial<VenueQuote>): VenueQuote {
  return {
    venue,
    coin,
    bid,
    ask,
    mid: (bid + ask) / 2,
    spreadBps: bps(bid, ask),
    fundingApr: null,
    volume24h: null,
    openInterestUsd: null,
    ...extra,
  };
}

/** Normalizes tickers so the same asset matches across venues (e.g. Nado "kBONK" vs Hyperliquid "kBONK"). */
function norm(coin: string) {
  return coin.toUpperCase();
}

export async function fetchMarketSnapshot(): Promise<MarketSnapshot> {
  const errors: string[] = [];
  const byCoin = new Map<string, Partial<Record<VenueId, VenueQuote>>>();
  const put = (q: VenueQuote) => {
    const key = norm(q.coin);
    const row = byCoin.get(key) ?? {};
    row[q.venue] = q;
    byCoin.set(key, row);
  };
  const venueStats: MarketSnapshot['venueStats'] = {};

  const [omni, nado, hl] = await Promise.allSettled([
    fetchOmniStats(),
    (async () => {
      const [markets, contracts] = await Promise.all([fetchNadoMarkets(), fetchNadoContracts()]);
      const prices = await fetchNadoMarketPrices([...markets.values()].map((m) => m.productId));
      return { markets, contracts, prices };
    })(),
    fetchHlMeta(),
  ]);

  if (omni.status === 'fulfilled') {
    const s = omni.value;
    venueStats.variational = {
      volume24h: Number(s.total_volume_24h),
      openInterest: Number(s.open_interest),
      tvl: Number(s.tvl),
      markets: s.num_markets,
    };
    for (const l of s.listings) {
      // The $1k quote is what a farming-size order actually gets on Omni's RFQ.
      const q = l.quotes?.size_1k ?? l.quotes?.base;
      if (!q) continue;
      const oi = Number(l.open_interest?.long_open_interest ?? 0) + Number(l.open_interest?.short_open_interest ?? 0);
      put(
        quote('variational', l.ticker, Number(q.bid), Number(q.ask), {
          fundingApr: Number(l.funding_rate),
          volume24h: Number(l.volume_24h),
          openInterestUsd: oi,
        }),
      );
    }
  } else errors.push(`Variational: ${omni.reason}`);

  if (nado.status === 'fulfilled') {
    const { markets, contracts, prices } = nado.value;
    const byProduct = new Map(contracts.map((c) => [c.product_id, c]));
    let vol = 0;
    let oi = 0;
    for (const m of markets.values()) {
      const p = prices.get(m.productId);
      const c = byProduct.get(m.productId);
      if (!p || !(p.bid > 0) || !(p.ask > 0)) continue;
      vol += c?.quote_volume ?? 0;
      oi += c?.open_interest_usd ?? 0;
      put(
        quote('nado', m.coin, p.bid, p.ask, {
          fundingApr: c ? c.funding_rate * 365 : null,
          volume24h: c?.quote_volume ?? null,
          openInterestUsd: c?.open_interest_usd ?? null,
        }),
      );
    }
    venueStats.nado = { volume24h: vol, openInterest: oi, markets: markets.size };
  } else errors.push(`Nado: ${nado.reason}`);

  if (hl.status === 'fulfilled') {
    let vol = 0;
    let oi = 0;
    for (const c of hl.value.ctxs) {
      vol += c.dayNtlVlm;
      oi += c.openInterest * c.markPx;
      const bid = c.impactBid ?? c.midPx ?? c.markPx;
      const ask = c.impactAsk ?? c.midPx ?? c.markPx;
      if (!(bid > 0)) continue;
      put(
        quote('hyperliquid', c.coin, bid, ask, {
          fundingApr: c.funding * 24 * 365,
          volume24h: c.dayNtlVlm,
          openInterestUsd: c.openInterest * c.markPx,
        }),
      );
    }
    venueStats.hyperliquid = { volume24h: vol, openInterest: oi, markets: hl.value.markets.size };
  } else errors.push(`Hyperliquid: ${hl.reason}`);

  const rows: MarketRow[] = [];
  for (const [coin, quotes] of byCoin) {
    const list = Object.values(quotes).filter((q): q is VenueQuote => !!q);
    if (list.length < 2) continue;
    rows.push({ coin, quotes, bestFundingPair: bestFundingPair(list) });
  }
  const volumeOf = (r: MarketRow) => Object.values(r.quotes).reduce((s, q) => s + (q?.volume24h ?? 0), 0);
  rows.sort((a, b) => volumeOf(b) - volumeOf(a));
  return { ts: Date.now(), rows, venueStats, errors };
}

export function bestFundingPair(list: VenueQuote[]): MarketRow['bestFundingPair'] {
  const withF = list.filter((q) => q.fundingApr !== null && Number.isFinite(q.fundingApr));
  if (withF.length < 2) return null;
  const sorted = [...withF].sort((a, b) => (a.fundingApr as number) - (b.fundingApr as number));
  const long = sorted[0];
  const short = sorted[sorted.length - 1];
  return { longVenue: long.venue, shortVenue: short.venue, aprEdge: (short.fundingApr as number) - (long.fundingApr as number) };
}
