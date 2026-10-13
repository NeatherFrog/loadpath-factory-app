import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import type { BotVenueId } from '../../../shared/types';
import type { Book, Fill, IsolatedLeg, MarketSpec, Venue } from '../venue';
import { fetchHlBook, fetchHlMeta, hlPrice, type HlMarket } from '../../data/hlPublic';
import { hlCoin, hlPublicSource, plainCoin } from './sources';
import { roundToStep } from '../math';

export interface HyperliquidCredentials {
  /** Main account address (holds the margin). */
  address: string;
  /** API wallet ("agent") private key from app.hyperliquid.xyz/API — it can trade but cannot withdraw. */
  privateKey: string;
}

export interface HyperliquidVenueOptions {
  id?: BotVenueId;
  label?: string;
  /** HIP-3 dex: "io" = Entropy, "xyz" = trade.xyz. Empty = Hyperliquid's own perps. */
  dex?: string;
  /** Leverage set on a market before the first order (isolated-only HIP-3 markets need it). */
  leverage?: () => number;
  /** Dexes whose balances count toward equity (one account holds both HIP-3 legs). */
  equityDexes?: string[];
}

/** Hyperliquid perps — its own markets or a HIP-3 dex built on it (Entropy, trade.xyz). */
export class HyperliquidVenue implements Venue {
  readonly id: BotVenueId;
  readonly label: string;
  readonly isPaper = false;
  private info = new InfoClient({ transport: new HttpTransport() });
  private exchange!: ExchangeClient;
  /** Keyed by plain coin name ("NBIS"), see hlCoin(). */
  private markets = new Map<string, HlMarket>();
  private funding;
  private dex: string;
  private leverageSet = new Map<string, number>();

  constructor(
    private creds: HyperliquidCredentials,
    private opts: HyperliquidVenueOptions = {},
  ) {
    this.id = opts.id ?? 'hyperliquid';
    this.label = opts.label ?? 'Hyperliquid';
    this.dex = opts.dex ?? '';
    this.funding = hlPublicSource(this.dex);
  }

  private ready = false;

  private get user() {
    return this.creds.address as `0x${string}`;
  }

  async init() {
    if (this.ready) return;
    if (!this.creds.address || !this.creds.privateKey) throw new Error(`${this.label}: добавь адрес и API-ключ Hyperliquid в Настройках`);
    const key = this.creds.privateKey.trim();
    const wallet = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`);
    this.exchange = new ExchangeClient({ transport: new HttpTransport(), wallet });
    const { markets } = await fetchHlMeta(this.dex);
    this.markets = new Map([...markets].map(([name, m]) => [plainCoin(name), m]));
    await this.funding.load();
    if (this.dex) await this.ensureUnifiedAccount();
    await this.equityUsd(); // validates the address
    this.ready = true;
  }

  /**
   * HIP-3 dexes keep separate balances unless the account is "unified": then one USDC balance backs
   * every dex, so both legs (Entropy and trade.xyz) draw margin from the same money.
   */
  private async ensureUnifiedAccount() {
    const mode = await this.info.userAbstraction({ user: this.user });
    if (mode === 'unifiedAccount' || mode === 'portfolioMargin') return;
    try {
      await this.exchange.agentSetAbstraction({ abstraction: 'u' });
    } catch (err) {
      throw new Error(
        `${this.label}: не получилось включить «Unified account» на Hyperliquid (${err instanceof Error ? err.message : err}). ` +
          'Включи его вручную: app.hyperliquid.xyz → иконка аккаунта → Account mode → Unified.',
      );
    }
  }

  private market(coin: string): HlMarket {
    const m = this.markets.get(coin);
    if (!m) throw new Error(`${this.label}: no market ${coin}`);
    return m;
  }

  hasMarket(coin: string) {
    return this.markets.has(coin);
  }

  spec(coin: string): MarketSpec {
    return this.market(coin).spec;
  }

  book(coin: string): Promise<Book> {
    return fetchHlBook(hlCoin(this.dex, coin));
  }

  private state(dex = this.dex) {
    return this.info.clearinghouseState(dex ? { user: this.user, dex } : { user: this.user });
  }

  async position(coin: string): Promise<number> {
    const state = await this.state();
    const name = hlCoin(this.dex, coin);
    const p = state.assetPositions.find((a) => a.position.coin === name);
    return p ? Number(p.position.szi) : 0;
  }

  async equityUsd(): Promise<number | null> {
    if (!this.dex) {
      const state = await this.state('');
      return Number(state.marginSummary.accountValue);
    }
    // Free USDC (spot side of a unified account) + everything locked in positions on each dex.
    const dexes = [...new Set(['', this.dex, ...(this.opts.equityDexes ?? [])])];
    const [spot, ...states] = await Promise.all([this.info.spotClearinghouseState({ user: this.user }), ...dexes.map((d) => this.state(d))]);
    const usdc = spot.balances.find((b) => b.coin === 'USDC');
    const free = usdc ? Number(usdc.total) - Number(usdc.hold) : 0;
    return free + states.reduce((s, st) => s + Number(st.marginSummary.accountValue), 0);
  }

  fundingApr(coin: string) {
    return this.funding.fundingApr(coin);
  }

  /**
   * Sets the configured leverage once per market. HIP-3 legs always use isolated margin: each
   * position then locks exactly notional / leverage, so the account can never be over-leveraged.
   */
  private async ensureLeverage(m: HlMarket) {
    if (!this.opts.leverage) return;
    const want = Math.max(1, Math.min(m.maxLeverage, Math.ceil(this.opts.leverage())));
    if (this.leverageSet.get(m.coin) === want) return;
    try {
      await this.exchange.updateLeverage({ asset: m.asset, isCross: !this.dex && !m.onlyIsolated, leverage: want });
      this.leverageSet.set(m.coin, want);
    } catch (err) {
      // Lowering leverage on an open isolated position can be refused; the order still goes through.
      if (this.leverageSet.has(m.coin)) return;
      throw err;
    }
  }

  async ioc(coin: string, size: number, slippageBps: number, reduceOnly = false): Promise<Fill> {
    const m = this.market(coin);
    const qty = roundToStep(size, m.spec.sizeStep);
    if (qty === 0) return { filledSize: 0, avgPx: 0, feeUsd: 0 };
    if (!reduceOnly) await this.ensureLeverage(m);
    const b = await this.book(coin);
    const ref = qty > 0 ? b.ask : b.bid;
    const limit = hlPrice(ref * (1 + (Math.sign(qty) * slippageBps) / 10_000), m.szDecimals);
    try {
      const res = await this.exchange.order({
        orders: [
          {
            a: m.asset,
            b: qty > 0,
            p: limit,
            s: Math.abs(qty).toFixed(m.szDecimals),
            r: reduceOnly,
            t: { limit: { tif: 'Ioc' } },
          },
        ],
        grouping: 'na',
      });
      const status = res.response.data.statuses[0];
      if (typeof status === 'object' && 'filled' in status) {
        const filled = Number(status.filled.totalSz);
        const avgPx = Number(status.filled.avgPx);
        return { filledSize: filled, avgPx, feeUsd: filled * avgPx * (m.spec.takerFeeBps / 10_000) };
      }
      return { filledSize: 0, avgPx: 0, feeUsd: 0 };
    } catch (err) {
      // An IOC that finds no liquidity inside the limit is reported as an error by the API.
      if (String(err).includes('could not immediately match')) return { filledSize: 0, avgPx: 0, feeUsd: 0 };
      throw err;
    }
  }

  async postOnly(coin: string, size: number, price: number, reduceOnly = false): Promise<string | null> {
    const m = this.market(coin);
    const qty = roundToStep(size, m.spec.sizeStep);
    if (qty === 0) return null;
    if (!reduceOnly) await this.ensureLeverage(m);
    try {
      const res = await this.exchange.order({
        orders: [
          {
            a: m.asset,
            b: qty > 0,
            p: hlPrice(price, m.szDecimals),
            s: Math.abs(qty).toFixed(m.szDecimals),
            r: reduceOnly,
            t: { limit: { tif: 'Alo' } },
          },
        ],
        grouping: 'na',
      });
      const status = res.response.data.statuses[0];
      if (typeof status === 'object' && 'resting' in status) return String(status.resting.oid);
      return null;
    } catch (err) {
      // "Post only order would have immediately matched"
      if (/post only|immediately match/i.test(String(err))) return null;
      throw err;
    }
  }

  async cancel(coin: string, orderId: string) {
    const m = this.market(coin);
    try {
      await this.exchange.cancel({ cancels: [{ a: m.asset, o: Number(orderId) }] });
    } catch (err) {
      if (!/already canceled|filled|never placed/i.test(String(err))) throw err;
    }
  }

  // ---------- isolated margin (HIP-3 markets are isolated-only) ----------

  async isolatedLeg(coin: string): Promise<IsolatedLeg | null> {
    const name = hlCoin(this.dex, coin);
    const st = await this.state();
    const p = st.assetPositions.find((a) => a.position.coin === name)?.position;
    if (!p || Number(p.szi) === 0) return null;
    const size = Number(p.szi);
    const value = Number(p.positionValue);
    return {
      size,
      markPx: value / Math.abs(size),
      liquidationPx: p.liquidationPx === null ? null : Number(p.liquidationPx),
      marginUsd: Number(p.marginUsed),
      positionValueUsd: value,
      isolated: p.leverage.type === 'isolated',
      removable: this.market(coin).marginMode !== 'strictIsolated',
    };
  }

  async freeCollateralUsd(): Promise<number> {
    const spot = await this.info.spotClearinghouseState({ user: this.user });
    const usdc = spot.balances.find((b) => b.coin === 'USDC');
    return usdc ? Math.max(0, Number(usdc.total) - Number(usdc.hold)) : 0;
  }

  /** Moves `usd` into (positive) or out of (negative) the isolated margin of the position on `coin`. */
  async adjustIsolatedMargin(coin: string, usd: number) {
    const m = this.market(coin);
    const leg = await this.isolatedLeg(coin);
    if (!leg) return;
    await this.exchange.updateIsolatedMargin({ asset: m.asset, isBuy: leg.size > 0, ntli: Math.trunc(usd * 1e6) });
  }
}
