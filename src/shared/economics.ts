// Farming economics: what $1M of volume (or $1M of open interest for a week) costs and earns.
// All rates come from data/projects.json → "economics" so they can be refined without a release.

export interface EconomicsInputs {
  nado: { pointsPer1MVolume: number; cashBackBps: number; pointValue: number };
  variational: { pointsPer1MVolume: number; pointsPer1MOiWeek: number; pointValue: number; roundTripSpreadBps: number };
  fees: { nadoMaker: number; nadoTaker: number; hlTaker: number; lighterTaker: number };
  /** Price drift between the two legs of a cycle (bps per side), measured in paper runs. */
  hedgeSlippageBps: number;
}

export interface StrategyResult {
  id: string;
  name: string;
  manual: boolean;
  /** Cost of producing $1M of volume on the farmed venue(s), USD. */
  costPer1M: number;
  pointsNado: number;
  pointsVar: number;
  /** USD value of points + cash rebates per $1M. */
  valuePer1M: number;
  netPer1M: number;
  /** Cost per point of the main farmed program (null when nothing is earned). */
  costPerPoint: number | null;
  note: string;
}

const M = 1_000_000;
const bps = (x: number) => x / 10_000;

/**
 * Strategies per $1M of volume on the farm leg. A cycle trades the farm leg twice (open + close),
 * so $1M farm volume = $500k notional round-tripped; the hedge leg trades the same volume.
 */
export function compareStrategies(e: EconomicsInputs): StrategyResult[] {
  const nadoVal = (vol: number) => (vol / M) * (e.nado.pointsPer1MVolume * e.nado.pointValue + bps(e.nado.cashBackBps) * M);
  const varVal = (vol: number) => (vol / M) * e.variational.pointsPer1MVolume * e.variational.pointValue;
  const slip = bps(e.hedgeSlippageBps) * M;

  const row = (
    id: string,
    name: string,
    manual: boolean,
    costPer1M: number,
    nadoVol: number,
    varVol: number,
    note: string,
  ): StrategyResult => {
    const pointsNado = (nadoVol / M) * e.nado.pointsPer1MVolume;
    const pointsVar = (varVol / M) * e.variational.pointsPer1MVolume;
    const valuePer1M = nadoVal(nadoVol) + varVal(varVol);
    const cashBack = (nadoVol / M) * bps(e.nado.cashBackBps) * M;
    const mainPoints = pointsVar > 0 ? pointsVar : pointsNado;
    return {
      id,
      name,
      manual,
      costPer1M,
      pointsNado,
      pointsVar,
      valuePer1M,
      netPer1M: valuePer1M - costPer1M,
      costPerPoint: mainPoints > 0 ? (costPer1M - cashBack) / mainPoints : null,
      note,
    };
  };

  const f = e.fees;
  return [
    row('nado-hl-taker', 'Nado тейкер ⇄ Hyperliquid тейкер (v0.1.0)', false, (bps(f.nadoTaker) + bps(f.hlTaker)) * M + 2 * slip, M, 0,
      'Обе ноги платят тейкер; HL-нога поинтов не даёт.'),
    row('nado-hl-maker', 'Nado мейкер ⇄ Hyperliquid тейкер (v0.1.1)', false, (bps(f.nadoMaker) + bps(f.hlTaker)) * M + slip, M, 0,
      'Основной расход — тейкер 4.5 bps на Hyperliquid.'),
    row('nado-lighter', 'Nado мейкер ⇄ Lighter тейкер (0%)', false, bps(f.nadoMaker) * M + slip, M, 0,
      'Хедж бесплатный, остаётся мейкер 1 bp на Nado и проскальзывание.'),
    row('omni-churn', 'Omni вручную ⇄ Nado мейкер (оборот)', true,
      (bps(e.variational.roundTripSpreadBps) / 2) * M + bps(f.nadoMaker) * M, M, M,
      'Поинты на двух биржах; Omni без комиссий, платишь только спред RFQ.'),
  ];
}

/**
 * Holding a delta-neutral position on Omni (hedged on Nado) for `days`. Variational weights open
 * interest far above volume, so this is the main earner. Entry and exit cost one round trip on
 * each leg; funding is earned or paid on the spread between the two venues.
 */
export function omniHoldPlan(e: EconomicsInputs, notionalUsd: number, days: number, fundingEdgeApr: number) {
  const points = (notionalUsd / M) * e.variational.pointsPer1MOiWeek * (days / 7);
  const pointsValue = points * e.variational.pointValue;
  const entryExit =
    notionalUsd * bps(e.variational.roundTripSpreadBps) + notionalUsd * 2 * bps(e.fees.nadoMaker) - (2 * notionalUsd / M) * bps(e.nado.cashBackBps) * M;
  const funding = notionalUsd * fundingEdgeApr * (days / 365);
  const net = pointsValue - entryExit + funding;
  return { points, pointsValue, entryExit, funding, net, costPerPoint: points > 0 ? (entryExit - funding) / points : null };
}

export interface HoldIdea {
  coin: string;
  /** Side to open on Variational Omni; Nado takes the opposite side. */
  omniSide: 'long' | 'short';
  /** Funding both legs earn together, per year (decimal). */
  fundingApr: number;
  fundingUsd: number;
  points: number;
  pointsUsd: number;
  costUsd: number;
  netUsd: number;
  price: number;
}

interface QuoteLike {
  fundingApr: number | null;
  spreadBps: number;
  volume24h: number | null;
  mid: number;
}

/**
 * Mirrored trades (long on one venue, short on the other) ranked by what they earn over `days`:
 * funding paid to us on both legs + Variational points for holding the position − entry/exit cost.
 */
export function rankHoldIdeas(
  rows: { coin: string; quotes: { variational?: QuoteLike; nado?: QuoteLike } }[],
  e: EconomicsInputs,
  notionalUsd: number,
  days: number,
): HoldIdea[] {
  const out: HoldIdea[] = [];
  for (const r of rows) {
    const o = r.quotes.variational;
    const n = r.quotes.nado;
    if (!o || !n || o.fundingApr === null || n.fundingApr === null) continue;
    // Omni TradFi swaps (stocks, indices) use a different financing model and report 0 here.
    if (o.fundingApr === 0) continue;
    // Liquidity guard: thin books make entry/exit and hedging unreliable.
    if ((n.volume24h ?? 0) < 150_000 || o.spreadBps > 10 || n.spreadBps > 5) continue;
    const fundingApr = Math.abs(o.fundingApr - n.fundingApr);
    const p = omniHoldPlan({ ...e, variational: { ...e.variational, roundTripSpreadBps: o.spreadBps + n.spreadBps / 2 } }, notionalUsd, days, fundingApr);
    out.push({
      coin: r.coin,
      omniSide: o.fundingApr < n.fundingApr ? 'long' : 'short',
      fundingApr,
      fundingUsd: p.funding,
      points: p.points,
      pointsUsd: p.pointsValue,
      costUsd: p.entryExit,
      netUsd: p.net,
      price: n.mid,
    });
  }
  return out.sort((a, b) => b.netUsd - a.netUsd);
}

/** What an open mirrored trade earns per day right now (negative = it costs money). */
export function dailyIncome(notionalUsd: number, omniSide: 'long' | 'short', fOmni: number, fNado: number): number {
  const apr = omniSide === 'long' ? fNado - fOmni : fOmni - fNado;
  return (notionalUsd * apr) / 365;
}
