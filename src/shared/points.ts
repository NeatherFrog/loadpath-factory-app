import type { PointsEntry } from './types';

export interface PointsValuation {
  perPoint: { bear: number; base: number; bull: number };
  myValue: { bear: number; base: number; bull: number };
  otcTotal: number;
  /** OTC offer relative to the base-case value per point (1 = fair, >1 = premium). */
  otcVsBase: number | null;
  costPerPoint: number | null;
  breakEvenFdv: number | null;
  verdict: 'sell' | 'hold' | 'neutral' | 'no-data';
}

/** Value of one point = FDV * airdropShare / totalPoints. */
export function valuePerPoint(fdv: number, airdropPct: number, totalPoints: number): number {
  if (!(fdv > 0) || !(airdropPct > 0) || !(totalPoints > 0)) return 0;
  return (fdv * (airdropPct / 100)) / totalPoints;
}

export function valuePoints(e: PointsEntry): PointsValuation {
  const per = {
    bear: valuePerPoint(e.fdvBear, e.airdropPct, e.totalPoints),
    base: valuePerPoint(e.fdvBase, e.airdropPct, e.totalPoints),
    bull: valuePerPoint(e.fdvBull, e.airdropPct, e.totalPoints),
  };
  const my = { bear: per.bear * e.myPoints, base: per.base * e.myPoints, bull: per.bull * e.myPoints };
  const otcTotal = e.otcOfferPerPoint > 0 ? e.otcOfferPerPoint * e.myPoints : 0;
  const otcVsBase = per.base > 0 && e.otcOfferPerPoint > 0 ? e.otcOfferPerPoint / per.base : null;
  const costPerPoint = e.myPoints > 0 && e.farmCostUsd > 0 ? e.farmCostUsd / e.myPoints : null;
  // FDV at which the airdrop just repays the farming cost.
  const breakEvenFdv =
    costPerPoint !== null && e.airdropPct > 0 && e.totalPoints > 0
      ? (costPerPoint * e.totalPoints) / (e.airdropPct / 100)
      : null;

  let verdict: PointsValuation['verdict'] = 'no-data';
  if (otcVsBase !== null) {
    // An OTC deal removes TGE risk (delays, sybil filters, low FDV), so a sale
    // at ~80% of the base case is already reasonable; well above base it is a clear sell.
    if (otcVsBase >= 0.8) verdict = 'sell';
    else if (otcVsBase < 0.5) verdict = 'hold';
    else verdict = 'neutral';
  }
  return { perPoint: per, myValue: my, otcTotal, otcVsBase, costPerPoint, breakEvenFdv, verdict };
}
