import { describe, expect, it } from 'vitest';
import { Autopilot, bestOpportunities, incomeApr, type FundingQuote } from '../src/main/bot/autopilot';
import { DeltaNeutralEngine } from '../src/main/bot/engine';
import type { Book, Fill, MarketSpec, Venue } from '../src/main/bot/venue';
import { DEFAULT_AUTOPILOT_CONFIG, DEFAULT_BOT_CONFIG, type AutopilotStatus, type BotVenueId } from '../src/shared/types';

const PRICES: Record<string, number> = { BTC: 100, BNB: 10, UNI: 5 };

class Fake implements Venue {
  readonly isPaper = true;
  pos = new Map<string, number>();
  constructor(readonly id: BotVenueId, readonly label: string, public equity = 1000) {}
  async init() {}
  hasMarket(c: string) { return c in PRICES; }
  spec(): MarketSpec { return { sizeStep: 0.001, priceTick: 0.001, minNotionalUsd: 1, takerFeeBps: 0, makerFeeBps: 0 }; }
  async book(c: string): Promise<Book> { return { bid: PRICES[c] - 0.001, ask: PRICES[c] + 0.001, ts: 0 }; }
  async position(c: string) { return this.pos.get(c) ?? 0; }
  async equityUsd() { return this.equity; }
  async fundingApr() { return 0; }
  async ioc(c: string, size: number, _s: number, reduceOnly = false): Promise<Fill> {
    let q = Math.round(size * 1000) / 1000;
    const cur = this.pos.get(c) ?? 0;
    if (reduceOnly && Math.abs(q) > Math.abs(cur)) q = -cur;
    this.pos.set(c, Math.round((cur + q) * 1000) / 1000);
    return { filledSize: Math.abs(q), avgPx: PRICES[c], feeUsd: 0 };
  }
}

function setup(quotes: () => FundingQuote[], initial?: AutopilotStatus) {
  const nado = new Fake('nado', 'Nado');
  const hedge = new Fake('lighter', 'Lighter');
  const holder = new DeltaNeutralEngine(nado, hedge, { ...DEFAULT_BOT_CONFIG, makerLegA: false }, { sleep: () => new Promise((r) => setImmediate(r)) });
  let t = 1_000_000;
  const budgets: number[] = [];
  const ap = new Autopilot({ ...DEFAULT_AUTOPILOT_CONFIG }, {
    nado, hedge, holder,
    quotes: async () => quotes(),
    churnBudget: (b) => { budgets.push(b); },
    now: () => t,
    initial,
  });
  return { ap, nado, hedge, holder, budgets, advance: (ms: number) => { t += ms; } };
}

const q = (coin: string, fNado: number, fHedge: number): FundingQuote => ({ coin, fNado, fHedge, price: PRICES[coin] });

describe('autopilot math', () => {
  it('takes the paid side on both venues', () => {
    const [o] = bestOpportunities([q('BNB', -0.19, 0.105), q('BTC', 0.017, 0.105)]);
    expect(o.coin).toBe('BNB');
    expect(o.nadoSide).toBe('long'); // Nado longs are paid (negative funding), Lighter shorts are paid
    expect(o.edgeApr).toBeCloseTo(0.295);
    expect(incomeApr('long', -0.19, 0.105)).toBeCloseTo(0.295);
    expect(incomeApr('short', -0.19, 0.105)).toBeCloseTo(-0.295);
  });
});

describe('Autopilot', () => {
  it('opens the best coin in slices up to the margin-based target, hedged 1:1', async () => {
    const { ap, nado, hedge } = setup(() => [q('BNB', -0.19, 0.105), q('BTC', 0.017, 0.105)]);
    await ap.tick();
    expect(ap.status().hold?.coin).toBe('BNB');
    expect(nado.pos.get('BNB')).toBe(50); // $500 slice / $10
    expect(hedge.pos.get('BNB')).toBe(-50);
    for (let i = 0; i < 5; i++) await ap.tick();
    // target = min(1000, 1000) × 2 × 0.9 = $1800; it stops topping up once within 80% of it
    expect(nado.pos.get('BNB')).toBe(150);
    expect(hedge.pos.get('BNB')).toBe(-150);
    expect(ap.status().events.some((e) => e.text.includes('Открыл BNB'))).toBe(true);
  });

  it('accrues funding and hands it to the churn budget', async () => {
    const { ap, budgets, advance } = setup(() => [q('BNB', -0.19, 0.105)]);
    for (let i = 0; i < 4; i++) await ap.tick();
    advance(24 * 3_600_000); // one day
    await ap.tick();
    const s = ap.status();
    expect(s.fundingTodayUsd).toBeGreaterThan(1); // $1800 × 29.5% / 365 ≈ $1.45
    expect(budgets.at(-1)).toBeCloseTo(s.fundingTodayUsd, 5);
  });

  it('switches to a clearly better coin only after the minimum hold time', async () => {
    let quotes = [q('BNB', -0.05, 0.05)]; // 10%/yr
    const { ap, nado, advance } = setup(() => quotes);
    await ap.tick();
    expect(ap.status().hold?.coin).toBe('BNB');
    quotes = [q('BNB', -0.05, 0.05), q('UNI', -0.2, 0.2)]; // UNI pays 40%/yr
    advance(3_600_000);
    await ap.tick();
    expect(ap.status().hold?.coin).toBe('BNB'); // too early
    advance(8 * 3_600_000);
    await ap.tick(); // closes BNB
    expect(nado.pos.get('BNB')).toBe(0);
    expect(ap.status().hold?.coin).toBe('UNI'); // and opens UNI in the same step
    expect(nado.pos.get('UNI')).toBeGreaterThan(0); // UNI: Nado funding is negative, so Nado longs get paid
  });

  it('closes after funding stays against the position for 3 checks', async () => {
    let quotes = [q('BNB', -0.19, 0.105)];
    const { ap, nado, hedge } = setup(() => quotes);
    await ap.tick();
    quotes = [q('BNB', 0.02, 0)]; // our side now pays 2%/yr; the other side would earn only 2% (< 5% minimum)
    await ap.tick();
    await ap.tick();
    expect(ap.status().hold).not.toBeNull();
    await ap.tick();
    expect(ap.status().hold).toBeNull();
    expect(nado.pos.get('BNB')).toBe(0);
    expect(hedge.pos.get('BNB')).toBe(0);
  });

  it('never touches positions that existed before it, and resumes after a restart', async () => {
    const first = setup(() => [q('BNB', -0.19, 0.105)]);
    first.nado.pos.set('BNB', 7); // the user's own position
    await first.ap.tick();
    const saved = JSON.parse(JSON.stringify(first.ap.status())) as AutopilotStatus;
    expect(saved.hold?.baseA).toBe(7);

    // "Restart": new engine and autopilot over the same venues, restored from the saved status.
    const holder = new DeltaNeutralEngine(first.nado, first.hedge, { ...DEFAULT_BOT_CONFIG, makerLegA: false }, { sleep: () => new Promise((r) => setImmediate(r)) });
    const ap2 = new Autopilot({ ...DEFAULT_AUTOPILOT_CONFIG }, { nado: first.nado, hedge: first.hedge, holder, quotes: async () => [q('BNB', 0.02, 0)], initial: saved });
    for (let i = 0; i < 3; i++) await ap2.tick(); // funding flipped → closes
    expect(ap2.status().hold).toBeNull();
    expect(first.nado.pos.get('BNB')).toBe(7); // the user's position is intact
    expect(first.hedge.pos.get('BNB')).toBe(0);
  });

  it('does nothing without money on the venues', async () => {
    const { ap, nado } = setup(() => [q('BNB', -0.19, 0.105)]);
    nado.equity = 5;
    await ap.tick();
    expect(ap.status().hold).toBeNull();
    expect(ap.status().message).toMatch(/Мало денег/);
  });

  it('flips to the other side when funding reverses strongly', async () => {
    let quotes = [q('BNB', -0.19, 0.105)];
    const { ap, nado } = setup(() => quotes);
    await ap.tick();
    quotes = [q('BNB', 0.2, -0.1)];
    for (let i = 0; i < 3; i++) await ap.tick();
    expect(ap.status().hold?.nadoSide).toBe('short');
    expect(nado.pos.get('BNB')).toBeLessThan(0);
  });
});
