import type { FundingQuote } from '../bot/autopilot';
import { fetchHlFundingAvg, fetchHlMeta, type HlAssetCtx } from './hlPublic';
import { plainCoin } from '../bot/venues/sources';

/** Entropy = HIP-3 dex "io"; the same stocks are hedged on trade.xyz (dex "xyz"). */
export const ENTROPY_DEX = 'io';
export const XYZ_DEX = 'xyz';

const MIN_VOLUME_USD = 500_000; // per day, on both dexes
const AVG_HOURS = 24;
const AVG_TTL = 10 * 60_000;

const avgCache = new Map<string, { at: number; apr: number | null }>();

/** 24h average funding: hourly rates jump around a lot, the average is what a position really earns. */
async function avgFunding(coin: string): Promise<number | null> {
  const hit = avgCache.get(coin);
  if (hit && Date.now() - hit.at < AVG_TTL) return hit.apr;
  const apr = await fetchHlFundingAvg(coin, AVG_HOURS);
  avgCache.set(coin, { at: Date.now(), apr });
  return apr;
}

/** Coins listed on both Entropy and trade.xyz with enough volume, filtered by liquidity. Exported for tests. */
export function entropyPairs(io: HlAssetCtx[], xyz: HlAssetCtx[]): { coin: string; io: HlAssetCtx; xyz: HlAssetCtx }[] {
  const byCoin = new Map(xyz.map((c) => [plainCoin(c.coin), c]));
  const out: { coin: string; io: HlAssetCtx; xyz: HlAssetCtx }[] = [];
  for (const a of io) {
    const coin = plainCoin(a.coin);
    const b = byCoin.get(coin);
    if (!b || !(a.markPx > 0) || !(b.markPx > 0)) continue;
    if (a.dayNtlVlm < MIN_VOLUME_USD || b.dayNtlVlm < MIN_VOLUME_USD) continue;
    // Same stock on both dexes: marks must agree, otherwise the oracles differ (different instrument).
    if (Math.abs(a.markPx / b.markPx - 1) > 0.01) continue;
    out.push({ coin, io: a, xyz: b });
  }
  return out;
}

/** Funding quotes for the Entropy autopilot: fNado = Entropy, fHedge = trade.xyz (24h averages). */
export async function fetchEntropyQuotes(): Promise<FundingQuote[]> {
  const [io, xyz] = await Promise.all([fetchHlMeta(ENTROPY_DEX), fetchHlMeta(XYZ_DEX)]);
  const pairs = entropyPairs(io.ctxs, xyz.ctxs);
  const out = await Promise.all(
    pairs.map(async (p) => {
      const [fa, fb] = await Promise.all([avgFunding(p.io.coin), avgFunding(p.xyz.coin)]);
      return {
        coin: p.coin,
        fNado: fa ?? p.io.funding * 24 * 365,
        fHedge: fb ?? p.xyz.funding * 24 * 365,
        price: p.io.markPx,
      } satisfies FundingQuote;
    }),
  );
  return out;
}
