import { postJson } from './http';
import type { Book, MarketSpec } from '../bot/venue';

const INFO = 'https://api.hyperliquid.xyz/info';

// Tier-0 fees on Hyperliquid's own (validator-operated) perps.
const BASE_TAKER_BPS = 4.5;
const BASE_MAKER_BPS = 1.5;

export interface HlMarket {
  asset: number;
  /** Name as the API knows it: "BTC" on the main dex, "io:NBIS" on a HIP-3 dex. */
  coin: string;
  szDecimals: number;
  maxLeverage: number;
  /** HIP-3 markets that can only be traded with isolated margin. */
  onlyIsolated: boolean;
  /** "strictIsolated": margin cannot be taken out of an open position. */
  marginMode: string;
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

interface UniverseEntry {
  name: string;
  szDecimals: number;
  maxLeverage?: number;
  isDelisted?: boolean;
  onlyIsolated?: boolean;
  marginMode?: string;
  growthMode?: string;
  deployerFeeScale?: string;
}

type MetaAndCtxs = [
  { universe: UniverseEntry[] },
  { funding: string; openInterest: string; dayNtlVlm: string; markPx: string; midPx: string | null; impactPxs: string[] | null }[],
];

/**
 * Fee multiplier for a market. HIP-3 markets charge the base fee times (1 + deployer share)
 * (deployerFeeScale < 1) or times 2·scale (scale ≥ 1); "growth mode" cuts all-in fees by 90%.
 */
export function hlFeeMultiplier(u: Pick<UniverseEntry, 'growthMode' | 'deployerFeeScale'>, hip3: boolean): number {
  let m = 1;
  if (hip3) {
    const scale = Number(u.deployerFeeScale ?? 1);
    m = scale < 1 ? 1 + scale : 2 * scale;
  }
  if (u.growthMode === 'enabled') m *= 0.1;
  return m;
}

let dexIndexCache: Map<string, number> | null = null;

/** Index of each HIP-3 dex (used in its asset ids). The main dex is "" with index 0. */
export async function fetchHlDexIndex(): Promise<Map<string, number>> {
  if (dexIndexCache) return dexIndexCache;
  const dexs = await postJson<({ name: string } | null)[]>(INFO, { type: 'perpDexs' });
  dexIndexCache = new Map(dexs.map((d, i) => [d?.name ?? '', i]));
  return dexIndexCache;
}

/** Splits the API response into tradable markets and their live context. Exported for tests. */
export function parseHlMeta(data: MetaAndCtxs, dex: string, dexIndex: number): { markets: Map<string, HlMarket>; ctxs: HlAssetCtx[] } {
  const [meta, ctxs] = data;
  const markets = new Map<string, HlMarket>();
  const outCtx: HlAssetCtx[] = [];
  const hip3 = dex !== '';
  meta.universe.forEach((u, i) => {
    if (u.isDelisted) return;
    const fee = hlFeeMultiplier(u, hip3);
    markets.set(u.name, {
      asset: hip3 ? 100_000 + dexIndex * 10_000 + i : i,
      coin: u.name,
      szDecimals: u.szDecimals,
      maxLeverage: u.maxLeverage ?? 1,
      onlyIsolated: !!u.onlyIsolated,
      marginMode: u.marginMode ?? '',
      spec: {
        sizeStep: 10 ** -u.szDecimals,
        // Perp prices: max 5 significant figures and at most (6 - szDecimals) decimals; see hlPrice().
        priceTick: 10 ** -(6 - u.szDecimals),
        minNotionalUsd: 10,
        takerFeeBps: BASE_TAKER_BPS * fee,
        makerFeeBps: BASE_MAKER_BPS * fee,
      },
    });
    const c = ctxs[i];
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

/** Markets of the main dex (`dex` = "") or of a HIP-3 dex such as "io" (Entropy) or "xyz" (trade.xyz). */
export async function fetchHlMeta(dex = ''): Promise<{ markets: Map<string, HlMarket>; ctxs: HlAssetCtx[] }> {
  const [data, index] = await Promise.all([
    postJson<MetaAndCtxs>(INFO, dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }),
    dex ? fetchHlDexIndex() : Promise.resolve(new Map<string, number>()),
  ]);
  const dexIndex = index.get(dex);
  if (dex && dexIndex === undefined) throw new Error(`Hyperliquid: dex "${dex}" not found`);
  return parseHlMeta(data, dex, dexIndex ?? 0);
}

export async function fetchHlBook(coin: string): Promise<Book> {
  const r = await postJson<{ levels: { px: string }[][]; time: number }>(INFO, { type: 'l2Book', coin });
  const [bids, asks] = r.levels;
  if (!bids?.length || !asks?.length) throw new Error(`Hyperliquid: empty book for ${coin}`);
  return { bid: Number(bids[0].px), ask: Number(asks[0].px), ts: r.time };
}

/** Average annualized funding over the last `hours` (decimal, positive = longs pay). */
export async function fetchHlFundingAvg(coin: string, hours: number): Promise<number | null> {
  const rows = await postJson<{ fundingRate: string }[]>(INFO, {
    type: 'fundingHistory',
    coin,
    startTime: Date.now() - hours * 3_600_000,
  });
  if (!rows.length) return null;
  return (rows.reduce((s, r) => s + Number(r.fundingRate), 0) / rows.length) * 24 * 365;
}

/** Format a price the way Hyperliquid accepts it: <= 5 significant figures, <= 6 - szDecimals decimals. */
export function hlPrice(px: number, szDecimals: number): string {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const sig = Number(px.toPrecision(5));
  const fixed = sig.toFixed(maxDecimals);
  return String(Number(fixed));
}
