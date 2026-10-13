import { describe, expect, it } from 'vitest';
import { Autopilot, type FundingQuote } from '../src/main/bot/autopilot';
import { DeltaNeutralEngine } from '../src/main/bot/engine';
import { guardIsolatedMargin, liqDistance, marginNeeded } from '../src/main/bot/marginGuard';
import type { Book, Fill, IsolatedLeg, MarketSpec, Venue } from '../src/main/bot/venue';
import { entropyPairs } from '../src/main/data/entropyQuotes';
import { hlFeeMultiplier, parseHlMeta, type HlAssetCtx } from '../src/main/data/hlPublic';
import { DEFAULT_AUTOPILOT_CONFIG, DEFAULT_BOT_CONFIG, type BotVenueId } from '../src/shared/types';

describe('Hyperliquid HIP-3 markets', () => {
  const data = [
    {
      universe: [
        { name: 'io:OAI', szDecimals: 3, maxLeverage: 6, onlyIsolated: true, growthMode: 'enabled', deployerFeeScale: '1.0' },
        { name: 'io:NBIS', szDecimals: 2, maxLeverage: 15, onlyIsolated: true, growthMode: 'enabled', deployerFeeScale: '1.0' },
        { name: 'io:SBE', szDecimals: 2, maxLeverage: 6, onlyIsolated: true, deployerFeeScale: '1.0' },
      ],
    },
    [
      { funding: '0.00002', openInterest: '1', dayNtlVlm: '1', markPx: '1680', midPx: null, impactPxs: null },
      { funding: '0.00005', openInterest: '1', dayNtlVlm: '1', markPx: '205', midPx: null, impactPxs: null },
      { funding: '0', openInterest: '0', dayNtlVlm: '0', markPx: '50', midPx: null, impactPxs: null },
    ],
  ] as Parameters<typeof parseHlMeta>[0];

  it('uses HIP-3 asset ids (100000 + dex index × 10000 + index)', () => {
    const { markets } = parseHlMeta(data, 'io', 10);
    expect(markets.get('io:OAI')?.asset).toBe(200_000);
    expect(markets.get('io:NBIS')?.asset).toBe(200_001);
    expect(markets.get('io:NBIS')?.onlyIsolated).toBe(true);
  });

  it('charges 0.9 bps taker / 0.3 bps maker on growth-mode Entropy markets (as seen in real fills)', () => {
    const { markets } = parseHlMeta(data, 'io', 10);
    expect(markets.get('io:NBIS')?.spec.takerFeeBps).toBeCloseTo(0.9);
    expect(markets.get('io:NBIS')?.spec.makerFeeBps).toBeCloseTo(0.3);
    expect(markets.get('io:SBE')?.spec.takerFeeBps).toBeCloseTo(9); // no growth mode: 2× the base fee
    expect(hlFeeMultiplier({ deployerFeeScale: '0.5' }, true)).toBeCloseTo(1.5);
    expect(hlFeeMultiplier({}, false)).toBe(1);
  });
});

describe('Entropy pairs', () => {
  const ctx = (coin: string, markPx: number, dayNtlVlm: number): HlAssetCtx => ({
    coin, markPx, dayNtlVlm, funding: 0, openInterest: 0, midPx: null, impactBid: null, impactAsk: null,
  });

  it('keeps stocks listed on both dexes with volume and matching prices', () => {
    const pairs = entropyPairs(
      [ctx('io:NBIS', 205.1, 5e6), ctx('io:ANTH', 2048, 1e7), ctx('io:EWY', 164, 1e5), ctx('io:TCNT', 53.9, 1e6)],
      [ctx('xyz:NBIS', 205.0, 1.6e7), ctx('xyz:EWY', 164, 2e7), ctx('xyz:TCNT', 465, 1e6)],
    );
    // ANTH: not on trade.xyz; EWY: too little volume on Entropy; TCNT: different instrument (price).
    expect(pairs.map((p) => p.coin)).toEqual(['NBIS']);
  });
});

describe('isolated margin guard', () => {
  const leg = (size: number, markPx: number, liquidationPx: number | null, marginUsd = 100): IsolatedLeg => ({
    size, markPx, liquidationPx, marginUsd, positionValueUsd: Math.abs(size) * markPx, isolated: true, removable: true,
  });

  it('measures the distance to liquidation for longs and shorts', () => {
    expect(liqDistance(leg(1, 100, 60))).toBeCloseTo(0.4);
    expect(liqDistance(leg(-1, 100, 115))).toBeCloseTo(0.15);
    expect(liqDistance(leg(1, 100, null))).toBe(Infinity);
    expect(marginNeeded(leg(-2, 100, 115))).toBeCloseTo(30); // $200 × (0.30 − 0.15)
    expect(marginNeeded(leg(1, 100, 60))).toBe(0);
  });

  class MarginVenue {
    adjustments: number[] = [];
    constructor(readonly label: string, public leg: IsolatedLeg | null, public free: number) {}
    async isolatedLeg() { return this.leg; }
    async freeCollateralUsd() { return this.free; }
    async adjustIsolatedMargin(_c: string, usd: number) { this.adjustments.push(usd); this.free -= usd; }
  }

  it('moves spare margin from the winning leg to the losing one', async () => {
    // Price ran up 30%: the short (Entropy) is close to liquidation, the long (trade.xyz) is far from it.
    const short = new MarginVenue('Entropy', leg(-2, 130, 145), 0);
    const long = new MarginVenue('trade.xyz', leg(2, 130, 20, 175), 0);
    // Both legs share one account: what the winner gives away becomes free collateral for the loser.
    Object.defineProperty(short, 'free', { get: () => -long.adjustments.reduce((a, b) => a + b, 0) - short.adjustments.reduce((a, b) => a + b, 0), set: () => {} });
    const r = await guardIsolatedMargin(short as unknown as Venue, long as unknown as Venue, 'NBIS');
    const need = 260 * (0.3 - 15 / 130);
    expect(long.adjustments[0]).toBeCloseTo(-need, 0);
    expect(short.adjustments.reduce((a, b) => a + b, 0)).toBeCloseTo(need - 1, 0);
    expect(r.danger).toBe(false);
  });

  it('never takes margin out of a "strict isolated" leg', async () => {
    const short = new MarginVenue('Entropy', leg(-2, 130, 145), 0);
    const long = new MarginVenue('trade.xyz', { ...leg(2, 130, 20, 175), removable: false }, 0);
    const r = await guardIsolatedMargin(short as unknown as Venue, long as unknown as Venue, 'NBIS');
    expect(long.adjustments).toEqual([]);
    expect(r.danger).toBe(false); // 11.5% away: not yet dangerous, but nothing could be added
  });

  it('flags danger when a leg is nearly liquidated and there is nothing to add', async () => {
    const short = new MarginVenue('Entropy', leg(-2, 100, 105), 0);
    const long = new MarginVenue('trade.xyz', leg(2, 100, 90, 25), 0); // the other leg has no spare margin either
    const r = await guardIsolatedMargin(short as unknown as Venue, long as unknown as Venue, 'NBIS');
    expect(r.danger).toBe(true);
  });
});

// ---------- autopilot on one shared account ----------

const PX = 200;

class Fake implements Venue {
  readonly isPaper = true;
  pos = new Map<string, number>();
  constructor(readonly id: BotVenueId, readonly label: string, public equity: number, private spread = 0.02) {}
  async init() {}
  hasMarket() { return true; }
  spec(): MarketSpec { return { sizeStep: 0.01, priceTick: 0.01, minNotionalUsd: 1, takerFeeBps: 0.9, makerFeeBps: 0.3 }; }
  async book(): Promise<Book> { return { bid: PX - this.spread / 2, ask: PX + this.spread / 2, ts: 0 }; }
  async position(c: string) { return this.pos.get(c) ?? 0; }
  async equityUsd() { return this.equity; }
  async fundingApr() { return 0; }
  async ioc(c: string, size: number, _s: number, reduceOnly = false): Promise<Fill> {
    let q = Math.round(size * 100) / 100;
    const cur = this.pos.get(c) ?? 0;
    if (reduceOnly && Math.abs(q) > Math.abs(cur)) q = -cur;
    this.pos.set(c, Math.round((cur + q) * 100) / 100);
    const px = q > 0 ? PX + this.spread / 2 : PX - this.spread / 2;
    return { filledSize: Math.abs(q), avgPx: px, feeUsd: Math.abs(q) * px * 0.00009 };
  }
}

function setupShared(budget: number) {
  // A $300 account seen from both legs (unified Hyperliquid account).
  const entropy = new Fake('entropy', 'Entropy', 300);
  const xyz = new Fake('tradexyz', 'trade.xyz', 300);
  const holder = new DeltaNeutralEngine(entropy, xyz, { ...DEFAULT_BOT_CONFIG, makerLegA: false }, { sleep: () => new Promise((r) => setImmediate(r)) });
  const quotes: FundingQuote[] = [{ coin: 'NBIS', fNado: 0.2, fHedge: 0.1, price: PX }];
  const ap = new Autopilot({ ...DEFAULT_AUTOPILOT_CONFIG, dailyBudgetUsd: budget, sliceUsd: 100 }, {
    nado: entropy, hedge: xyz, holder, quotes: async () => quotes, rollVolume: true, sharedAccount: true, now: () => 1_000_000,
  });
  return { ap, entropy, xyz };
}

describe('Entropy autopilot (small shared account)', () => {
  it('sizes each leg from half of the account and shorts Entropy where shorts are paid', async () => {
    const { ap, entropy, xyz } = setupShared(0);
    for (let i = 0; i < 5; i++) await ap.tick();
    // $300 / 2 × 2x × 0.8 = $240 per leg → 1.2 NBIS; stops within 80% of it.
    expect(ap.status().hold?.nadoSide).toBe('short');
    expect(entropy.pos.get('NBIS')).toBeCloseTo(-1, 2);
    expect(xyz.pos.get('NBIS')).toBeCloseTo(1, 2);
    expect(ap.status().farmVolumeTotalUsd).toBeCloseTo(200, 0);
  });

  it('rolls the position for volume within the daily budget and keeps it hedged', async () => {
    const { ap, entropy, xyz } = setupShared(0.5);
    for (let i = 0; i < 3; i++) await ap.tick(); // build the position
    const before = ap.status().farmVolumeTotalUsd;
    for (let i = 0; i < 30; i++) await ap.tick();
    const s = ap.status();
    // A roll of $200 costs ~$0.11 here (4 fills × (0.9 bps fee + half the spread)) and makes $400 of Entropy volume.
    expect(s.farmVolumeTotalUsd).toBeGreaterThan(before + 1500);
    expect(s.rollSpentTodayUsd).toBeGreaterThan(0.4);
    expect(s.rollSpentTodayUsd).toBeLessThan(0.5 + 0.12); // never more than one roll past the budget
    expect(entropy.pos.get('NBIS')).toBeCloseTo(-(xyz.pos.get('NBIS') ?? 0), 6);
    expect(s.events.some((e) => e.text.startsWith('Объём: перекатил'))).toBe(true);
  });

  it('does not roll without a budget', async () => {
    const { ap } = setupShared(0);
    for (let i = 0; i < 10; i++) await ap.tick();
    expect(ap.status().rollSpentTodayUsd).toBe(0);
  });
});
