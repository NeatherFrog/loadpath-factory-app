import { describe, expect, it } from 'vitest';
import { basisBps, chooseDirection, commonSize, decimalsOf, lcmStep, roundPrice, roundToStep, spreadBps } from '../src/main/bot/math';
import { hlPrice } from '../src/main/data/hlPublic';
import { valuePerPoint, valuePoints } from '../src/shared/points';
import { projectScore } from '../src/shared/scoring';

describe('math', () => {
  it('rounds sizes down to the step, keeping sign', () => {
    expect(roundToStep(0.123456, 0.001)).toBe(0.123);
    expect(roundToStep(-0.123456, 0.001)).toBe(-0.123);
    expect(roundToStep(0.00049, 0.00005)).toBe(0.00045);
  });
  it('rounds prices to tick in the requested direction', () => {
    expect(roundPrice(100.123, 0.05, 'up')).toBe(100.15);
    expect(roundPrice(100.123, 0.05, 'down')).toBe(100.1);
  });
  it('decimals of steps', () => {
    expect(decimalsOf(0.00005)).toBe(5);
    expect(decimalsOf(0.1)).toBe(1);
    expect(decimalsOf(1)).toBe(0);
  });
  it('common size uses the LCM of both steps', () => {
    expect(lcmStep(0.00005, 0.00001)).toBeCloseTo(0.00005);
    expect(lcmStep(0.02, 0.05)).toBeCloseTo(0.1);
    const s = commonSize(300, 84000, 0.00005, 0.00001);
    expect(s).toBeCloseTo(0.00355, 10);
  });
  it('spread and basis in bps', () => {
    expect(spreadBps(99.99, 100.01)).toBeCloseTo(2, 5);
    expect(basisBps(100, 100.1)).toBeCloseTo(9.995, 2);
  });
  it('direction follows funding: long where funding is cheaper', () => {
    expect(chooseDirection('funding', 0.05, 0.2)).toBe(1);
    expect(chooseDirection('funding', 0.3, 0.1)).toBe(-1);
    expect(chooseDirection('funding', 0.1, 0.105, () => 0.9)).toBe(-1); // tiny diff -> random
  });
  it('formats Hyperliquid prices to 5 significant figures', () => {
    expect(hlPrice(84128.123, 5)).toBe('84128');
    expect(hlPrice(2572.456, 4)).toBe('2572.5');
    expect(hlPrice(0.123456, 0)).toBe('0.12346');
  });
});

describe('points valuation', () => {
  it('value per point = FDV * share / total', () => {
    expect(valuePerPoint(1_000_000_000, 32, 12_000_000)).toBeCloseTo(26.67, 2);
    expect(valuePerPoint(0, 32, 1)).toBe(0);
  });
  it('flags a rich OTC offer as sell and computes break-even FDV', () => {
    const v = valuePoints({
      projectId: 'x', myPoints: 1000, totalPoints: 10_000_000, airdropPct: 30,
      fdvBear: 300e6, fdvBase: 600e6, fdvBull: 1.5e9, otcOfferPerPoint: 20, farmCostUsd: 5000,
    });
    expect(v.perPoint.base).toBeCloseTo(18, 5);
    expect(v.verdict).toBe('sell');
    expect(v.costPerPoint).toBe(5);
    expect(v.breakEvenFdv).toBeCloseTo((5 * 10_000_000) / 0.3, 0);
  });
});

describe('scoring', () => {
  it('maps a perfect project to 100 and an empty one to 0', () => {
    const all = (n: number) => ({ team: n, funding: n, traction: n, tokenUpside: n, pointsAccess: n, automation: n, farmCost: n, risk: n });
    expect(projectScore(all(10))).toBe(100);
    expect(projectScore(all(0))).toBe(0);
  });
});
