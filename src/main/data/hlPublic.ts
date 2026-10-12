import { postJson } from './http';
import type { Book, MarketSpec } from '../bot/venue';

const INFO = 'https://api.hyperliquid.xyz/info';

export interface HlMarket {
  asset: number;
  coin: string;
  szDecimals: number;
  spec: MarketSpec;
}

export interface HlAssetCtx {
  coin: string;
  funding: number; // hourly rate
  openInterest: number; // base units
  dayNtlVlm: number;
  markPx: number;
  midPx: number | null;
  impactBid: number | null;
  impactAsk: number | null;
}

type MetaAndCtxs = [
  { universe: { name: string; szDecimals: number; isDelisted?: boolean }[] },
  { funding: string; openInterest: string; dayNtlVlm: string; markPx: string; midPx: string | null; impactPxs: string[] | null }[],
];

export async function fetchHlMeta(): Promise<{ markets: Map<string, HlMarket>; ctxs: HlAssetCtx[] }> {
  const [meta, ctxs] = await postJson<MetaAndCtxs>(INFO, { type: 'metaAndAssetCtxs' });
  const markets = new Map<string, HlMarket>();
  const outCtx: HlAssetCtx[] = [];
  meta.universe.forEach((u, asset) => {
    if (u.isDelisted) return;
    markets.set(u.name, {
      asset,
      coin: u.name,
      szDecimals: u.szDecimals,
      spec: {
        sizeStep: 10 ** -u.szDecimals,
        // Perp prices: max 5 significant figures and at most (6 - szDecimals) decimals; see hlPrice().
        priceTick: 10 ** -(6 - u.szDecimals),
        minNotionalUsd: 10,
        takerFeeBps: 4.5,
        makerFeeBps: 1.5,
      },
    });
    const c = ctxs[asset];
    if (c) {
      outCtx.push({
        coin: u.name,
        funding: Number(c.funding),
        openInterest: Number(c.openInterest),
        dayNtlVlm: Number(c.dayNtlVlm),
        markPx: Number(c.markPx),
        midPx: c.midPx ? Number(c.midPx) : null,
        impactBid: c.impactPxs ? Number(c.impactPxs[0]) : null,
        impactAsk: c.impactPxs ? Number(c.impactPxs[1]) : null,
      });
    }
  });
  return { markets, ctxs: outCtx };
}

export async function fetchHlBook(coin: string): Promise<Book> {
  const r = await postJson<{ levels: { px: string }[][]; time: number }>(INFO, { type: 'l2Book', coin });
  const [bids, asks] = r.levels;
  if (!bids?.length || !asks?.length) throw new Error(`Hyperliquid: empty book for ${coin}`);
  return { bid: Number(bids[0].px), ask: Number(asks[0].px), ts: r.time };
}

/** Format a price the way Hyperliquid accepts it: <= 5 significant figures, <= 6 - szDecimals decimals. */
export function hlPrice(px: number, szDecimals: number): string {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const sig = Number(px.toPrecision(5));
  const fixed = sig.toFixed(maxDecimals);
  return String(Number(fixed));
}
