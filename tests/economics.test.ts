import { describe, expect, it } from 'vitest';
import { compareStrategies, omniHoldPlan, type EconomicsInputs } from '../src/shared/economics';

const E: EconomicsInputs = {
  nado: { pointsPer1MVolume: 160, cashBackBps: 0.4, pointValue: 0.8 },
  variational: { pointsPer1MVolume: 9.6, pointsPer1MOiWeek: 86, pointValue: 20, roundTripSpreadBps: 1 },
  fees: { nadoMaker: 1, nadoTaker: 3.5, hlTaker: 4.5, lighterTaker: 0 },
  hedgeSlippageBps: 0.3,
};

describe('economics', () => {
  it('ranks hedge venues by cost: HL taker > HL with Nado maker > Lighter', () => {
    const r = Object.fromEntries(compareStrategies(E).map((s) => [s.id, s]));
    expect(r['nado-hl-taker'].costPer1M).toBeCloseTo(800 + 60, 5);
    expect(r['nado-hl-maker'].costPer1M).toBeCloseTo(550 + 30, 5);
    expect(r['nado-lighter'].costPer1M).toBeCloseTo(100 + 30, 5);
    // Nado point cost = (cost - $40 cash back) / 160 points
    expect(r['nado-lighter'].costPerPoint!).toBeCloseTo((130 - 40) / 160, 5);
  });

  it('Omni + Nado churn earns points on both venues', () => {
    const r = compareStrategies(E).find((s) => s.id === 'omni-churn')!;
    expect(r.pointsVar).toBeCloseTo(9.6);
    expect(r.pointsNado).toBeCloseTo(160);
    expect(r.netPer1M).toBeGreaterThan(0);
  });

  it('holding Omni OI for a week: points, costs and funding', () => {
    const p = omniHoldPlan(E, 10_000, 7, 0.08);
    expect(p.points).toBeCloseTo(0.86, 5);
    expect(p.pointsValue).toBeCloseTo(17.2, 5);
    // 1 bp Omni round trip + 2 bp Nado maker on $10k, minus cash back on $20k Nado volume
    expect(p.entryExit).toBeCloseTo(1 + 2 - 0.8, 5);
    expect(p.funding).toBeCloseTo((10_000 * 0.08 * 7) / 365, 5);
    expect(p.net).toBeGreaterThan(15);
  });
});

import { dailyIncome, rankHoldIdeas } from '../src/shared/economics';

describe('mirrored trade ideas', () => {
  const q = (fundingApr: number, spreadBps = 1, volume24h = 1e6, mid = 100) => ({ fundingApr, spreadBps, volume24h, mid });
  it('picks the side where funding is paid to us and skips illiquid or TradFi markets', () => {
    const ideas = rankHoldIdeas(
      [
        { coin: 'GOLD', quotes: { variational: q(-0.1), nado: q(0.1) } }, // long Omni, short Nado: +20%/yr
        { coin: 'BTC', quotes: { variational: q(0.1), nado: q(0.02) } }, // short Omni: +8%/yr
        { coin: 'THIN', quotes: { variational: q(-0.5), nado: q(0.5, 1, 1000) } }, // no volume on Nado
        { coin: 'SPY', quotes: { variational: q(0), nado: q(0.3) } }, // Omni TradFi swap
      ],
      E,
      10_000,
      7,
    );
    expect(ideas.map((i) => i.coin)).toEqual(['GOLD', 'BTC']);
    expect(ideas[0].omniSide).toBe('long');
    expect(ideas[1].omniSide).toBe('short');
    expect(ideas[0].fundingApr).toBeCloseTo(0.2);
  });
  it('daily income of an open mirrored trade', () => {
    expect(dailyIncome(3650, 'long', -0.1, 0.1)).toBeCloseTo(2, 5);
    expect(dailyIncome(3650, 'short', -0.1, 0.1)).toBeCloseTo(-2, 5);
  });
});
