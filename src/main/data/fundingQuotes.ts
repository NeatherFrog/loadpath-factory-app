import type { BotVenueId } from '../../shared/types';
import type { FundingQuote } from '../bot/autopilot';
import { fetchNadoContracts, fetchNadoMarketPrices, fetchNadoMarkets } from './nadoPublic';
import { fetchLighterFunding } from './lighterPublic';
import { fetchHlMeta } from './hlPublic';

const MIN_NADO_VOLUME_USD = 300_000;
const MAX_NADO_SPREAD_BPS = 3;

/**
 * Funding on Nado and the hedge venue for every coin that is liquid enough on Nado to hold a
 * mirrored position (enough daily volume, tight spread).
 */
export async function fetchFundingQuotes(hedge: BotVenueId): Promise<FundingQuote[]> {
  const [markets, contracts, hedgeFunding] = await Promise.all([
    fetchNadoMarkets(),
    fetchNadoContracts(),
    hedge === 'lighter'
      ? fetchLighterFunding()
      : fetchHlMeta().then(({ ctxs }) => new Map(ctxs.map((c) => [c.coin, c.funding * 24 * 365]))),
  ]);
  const prices = await fetchNadoMarketPrices([...markets.values()].map((m) => m.productId));
  const byProduct = new Map(contracts.map((c) => [c.product_id, c]));
  const out: FundingQuote[] = [];
  for (const m of markets.values()) {
    const c = byProduct.get(m.productId);
    const p = prices.get(m.productId);
    const fHedge = hedgeFunding.get(m.coin);
    if (!c || !p || fHedge === undefined || !(p.bid > 0) || !(p.ask > 0)) continue;
    const mid = (p.bid + p.ask) / 2;
    if (c.quote_volume < MIN_NADO_VOLUME_USD || ((p.ask - p.bid) / mid) * 10_000 > MAX_NADO_SPREAD_BPS) continue;
    out.push({ coin: m.coin, fNado: c.funding_rate * 365, fHedge, price: mid });
  }
  return out;
}
