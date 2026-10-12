import { describe, expect, it } from 'vitest';
import { DeltaNeutralEngine } from '../src/main/bot/engine';
import type { Book, Fill, MarketSpec, Venue } from '../src/main/bot/venue';
import { DEFAULT_BOT_CONFIG, type BotConfig, type BotLogEntry, type BotVenueId } from '../src/shared/types';

class FakeVenue implements Venue {
  readonly isPaper = true;
  pos = new Map<string, number>();
  /** Fraction of each IOC that fills (per call, popped from the front; default 1). */
  fillPlan: number[] = [];
  orders: { size: number; reduceOnly: boolean }[] = [];
  constructor(readonly id: BotVenueId, readonly label: string, private px = 100, private fee = 4) {}
  async init() {}
  hasMarket(coin: string) { return coin === 'ETH'; }
  spec(): MarketSpec { return { sizeStep: 0.01, priceTick: 0.01, minNotionalUsd: 10, takerFeeBps: this.fee, makerFeeBps: 1 }; }
  async book(): Promise<Book> { return { bid: this.px - 0.01, ask: this.px + 0.01, ts: Date.now() }; }
  async position(coin: string) { return this.pos.get(coin) ?? 0; }
  async equityUsd() { return 1000; }
  async fundingApr() { return 0.1; }
  async ioc(coin: string, size: number, _s: number, reduceOnly = false): Promise<Fill> {
    this.orders.push({ size, reduceOnly });
    const frac = this.fillPlan.length ? this.fillPlan.shift()! : 1;
    let qty = Math.round(size * frac * 100) / 100;
    const cur = this.pos.get(coin) ?? 0;
    if (reduceOnly && Math.abs(qty) > Math.abs(cur)) qty = -cur;
    this.pos.set(coin, Math.round((cur + qty) * 100) / 100);
    const px = qty > 0 ? this.px + 0.01 : this.px - 0.01;
    return { filledSize: Math.abs(qty), avgPx: px, feeUsd: Math.abs(qty) * px * this.fee / 10_000 };
  }
}

/** Venue with post-only support: each resting order fills `makerFillFrac` of its size on the next position() read. */
class MakerVenue extends FakeVenue {
  makerFillFrac: number[] = [];
  resting = new Map<string, { coin: string; size: number }>();
  posted: { size: number; price: number; reduceOnly: boolean }[] = [];
  cancels = 0;
  private n = 0;
  override async position(coin: string) {
    for (const [id, o] of this.resting) {
      const frac = this.makerFillFrac.length ? this.makerFillFrac.shift()! : 1;
      if (frac === 0) continue;
      const q = Math.round(o.size * frac * 100) / 100;
      this.pos.set(coin, Math.round(((this.pos.get(coin) ?? 0) + q) * 100) / 100);
      o.size = Math.round((o.size - q) * 100) / 100;
      if (o.size === 0) this.resting.delete(id);
    }
    return super.position(coin);
  }
  async postOnly(coin: string, size: number, price: number, reduceOnly = false) {
    this.posted.push({ size, price, reduceOnly });
    const id = String(++this.n);
    this.resting.set(id, { coin, size });
    return id;
  }
  async cancel(_coin: string, id: string) {
    this.cancels++;
    this.resting.delete(id);
  }
}

const cfg: BotConfig = {
  ...DEFAULT_BOT_CONFIG,
  coins: ['ETH'],
  notionalMinUsd: 200, notionalMaxUsd: 200,
  holdMinMinutes: 0, holdMaxMinutes: 0, pauseMinMinutes: 0, pauseMaxMinutes: 0,
  maxEntrySpreadBps: 10, dailyVolumeTargetUsd: 1000, makerWaitSec: 0.001,
};

function makeEngine(a: FakeVenue, b: FakeVenue, over: Partial<BotConfig> = {}) {
  const logs: BotLogEntry[] = [];
  const engine = new DeltaNeutralEngine(a, b, { ...cfg, ...over }, {
    sleep: () => new Promise((r) => setImmediate(r)),
    random: () => 0.3,
    log: (e) => logs.push(e),
  });
  return { engine, logs };
}

async function runUntilStopped(engine: DeltaNeutralEngine) {
  await engine.start();
  for (let i = 0; i < 200 && engine.status().state === 'running'; i++) await new Promise((r) => setTimeout(r, 1));
}

describe('DeltaNeutralEngine', () => {
  it('opens opposite legs, closes them flat and stops at the daily volume target', async () => {
    const a = new FakeVenue('nado', 'A');
    const b = new FakeVenue('hyperliquid', 'B');
    const { engine } = makeEngine(a, b);
    await runUntilStopped(engine);
    const s = engine.status();
    expect(s.state).toBe('stopped');
    expect(s.message).toMatch(/цель по объёму/);
    expect(a.pos.get('ETH')).toBe(0);
    expect(b.pos.get('ETH')).toBe(0);
    // Each cycle: 2 legs × open+close × ~$200
    expect(s.stats.volumeTodayUsd).toBeGreaterThanOrEqual(1000);
    expect(s.stats.cycles).toBeGreaterThan(0);
    // Delta-neutral => loss is only fees + spread, never market moves.
    expect(s.stats.totalRealizedPnlUsd).toBeLessThan(0);
    expect(s.stats.totalRealizedPnlUsd).toBeGreaterThan(-5);
    // Leg A always opens first and B mirrors it
    expect(Math.sign(a.orders[0].size)).toBe(-Math.sign(b.orders[0].size));
  });

  it('retries a partial hedge until fully hedged', async () => {
    const a = new FakeVenue('nado', 'A');
    const b = new FakeVenue('hyperliquid', 'B');
    b.fillPlan = [0.5, 1]; // first hedge order half-fills
    const { engine } = makeEngine(a, b, { dailyVolumeTargetUsd: 300 });
    await runUntilStopped(engine);
    expect(b.orders[0].size).toBeCloseTo(b.orders[1].size * 2, 5);
    expect(a.pos.get('ETH')).toBe(0);
    expect(b.pos.get('ETH')).toBe(0);
  });

  it('unwinds leg A when the hedge venue does not fill at all', async () => {
    const a = new FakeVenue('nado', 'A');
    const b = new FakeVenue('hyperliquid', 'B');
    b.fillPlan = [0, 0, 0, 0];
    const { engine, logs } = makeEngine(a, b, { dailyVolumeTargetUsd: 1 });
    await runUntilStopped(engine);
    expect(a.pos.get('ETH')).toBe(0);
    expect(a.orders[1].reduceOnly).toBe(true);
    expect(logs.some((l) => l.msg.includes('откатываю'))).toBe(true);
  });

  it('stops at the daily loss limit', async () => {
    const a = new FakeVenue('nado', 'A', 100, 50); // absurd 50 bps fees
    const b = new FakeVenue('hyperliquid', 'B', 100, 50);
    const { engine } = makeEngine(a, b, { maxDailyLossUsd: 3, dailyVolumeTargetUsd: 0 });
    await runUntilStopped(engine);
    expect(engine.status().message).toMatch(/лимит убытка/);
  });

  it('skips the cycle when spreads are too wide', async () => {
    const a = new FakeVenue('nado', 'A');
    const b = new FakeVenue('hyperliquid', 'B');
    const { engine, logs } = makeEngine(a, b, { maxEntrySpreadBps: 1, dailyVolumeTargetUsd: 1 });
    await engine.start();
    await new Promise((r) => setTimeout(r, 20));
    await engine.stop();
    expect(a.orders.length).toBe(0);
    expect(logs.some((l) => l.msg.includes('спред'))).toBe(true);
  });

  it('hedges a manual Omni trade on the hedge venue and closes it', async () => {
    const a = new FakeVenue('nado', 'A');
    const b = new FakeVenue('hyperliquid', 'B');
    const { engine } = makeEngine(a, b);
    const h = await engine.openManualHedge('ETH', 'long', 1.5, 'hyperliquid');
    expect(h.status).toBe('open');
    expect(b.pos.get('ETH')).toBe(-1.5);
    await engine.closeManualHedge(h.id);
    expect(b.pos.get('ETH')).toBe(0);
    expect(engine.status().hedges[0].status).toBe('closed');
  });

  it('leaves positions it did not open (manual hedges) untouched', async () => {
    const a = new FakeVenue('nado', 'A');
    const b = new FakeVenue('hyperliquid', 'B');
    a.pos.set('ETH', -1.5); // e.g. a hedge for a manual Omni long
    const { engine, logs } = makeEngine(a, b, { dailyVolumeTargetUsd: 1000 });
    await runUntilStopped(engine);
    expect(engine.status().stats.cycles).toBeGreaterThan(0);
    expect(a.pos.get('ETH')).toBe(-1.5);
    expect(b.pos.get('ETH')).toBe(0);
    expect(logs.some((l) => l.msg.includes('вне бота'))).toBe(true);
  });

  it('emergency flatten closes everything and marks hedges closed', async () => {
    const a = new FakeVenue('nado', 'A');
    const b = new FakeVenue('hyperliquid', 'B');
    const { engine } = makeEngine(a, b);
    await engine.openManualHedge('ETH', 'short', 0.7, 'nado');
    expect(a.pos.get('ETH')).toBe(0.7);
    await engine.flattenAll();
    expect(a.pos.get('ETH')).toBe(0);
    expect(engine.status().hedges[0].status).toBe('closed');
  });

  it('maker mode: rests post-only on leg A, hedges every partial fill on B, ends flat', async () => {
    const a = new MakerVenue('nado', 'A');
    const b = new FakeVenue('hyperliquid', 'B');
    a.makerFillFrac = [0.5, 1]; // the opening order fills in two pieces
    const { engine } = makeEngine(a, b, { dailyVolumeTargetUsd: 300 });
    await runUntilStopped(engine);
    expect(engine.status().state).toBe('stopped');
    expect(a.posted.length).toBeGreaterThan(0);
    // first maker fill (half) was hedged before the second one arrived
    expect(Math.abs(b.orders[0].size)).toBeCloseTo(Math.abs(a.posted[0].size) / 2, 5);
    expect(a.pos.get('ETH')).toBe(0);
    expect(b.pos.get('ETH')).toBe(0);
    // maker fees (1 bp) are far below the taker test above
    expect(engine.status().stats.perVenue.nado!.feesUsd).toBeLessThan(0.1);
  });

  it('maker mode: skips the cycle and cancels when nothing fills', async () => {
    const a = new MakerVenue('nado', 'A');
    const b = new FakeVenue('hyperliquid', 'B');
    a.makerFillFrac = new Array(1_000_000).fill(0);
    const { engine } = makeEngine(a, b, { dailyVolumeTargetUsd: 1 });
    await engine.start();
    await new Promise((r) => setTimeout(r, 30));
    await engine.stop();
    expect(a.cancels).toBeGreaterThan(0);
    expect(b.orders.length).toBe(0);
    expect(a.pos.get('ETH') ?? 0).toBe(0);
  });
});
