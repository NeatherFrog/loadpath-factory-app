import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import type { Book, Fill, MarketSpec, Venue } from '../venue';
import { fetchHlBook, fetchHlMeta, hlPrice, type HlMarket } from '../../data/hlPublic';
import { hlPublicSource } from './sources';
import { roundToStep } from '../math';

export interface HyperliquidCredentials {
  /** Main account address (holds the margin). */
  address: string;
  /** API wallet ("agent") private key from app.hyperliquid.xyz/API — it can trade but cannot withdraw. */
  privateKey: string;
}

export class HyperliquidVenue implements Venue {
  readonly id = 'hyperliquid' as const;
  readonly label = 'Hyperliquid';
  readonly isPaper = false;
  private info = new InfoClient({ transport: new HttpTransport() });
  private exchange!: ExchangeClient;
  private markets = new Map<string, HlMarket>();
  private funding = hlPublicSource();

  constructor(private creds: HyperliquidCredentials) {}

  private ready = false;

  async init() {
    if (this.ready) return;
    const key = this.creds.privateKey.trim();
    const wallet = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`);
    this.exchange = new ExchangeClient({ transport: new HttpTransport(), wallet });
    this.markets = (await fetchHlMeta()).markets;
    await this.funding.load();
    await this.equityUsd(); // validates the address
    this.ready = true;
  }

  private market(coin: string): HlMarket {
    const m = this.markets.get(coin);
    if (!m) throw new Error(`Hyperliquid: no market ${coin}`);
    return m;
  }

  hasMarket(coin: string) {
    return this.markets.has(coin);
  }

  spec(coin: string): MarketSpec {
    return this.market(coin).spec;
  }

  book(coin: string): Promise<Book> {
    return fetchHlBook(coin);
  }

  async position(coin: string): Promise<number> {
    const state = await this.info.clearinghouseState({ user: this.creds.address as `0x${string}` });
    const p = state.assetPositions.find((a) => a.position.coin === coin);
    return p ? Number(p.position.szi) : 0;
  }

  async equityUsd(): Promise<number | null> {
    const state = await this.info.clearinghouseState({ user: this.creds.address as `0x${string}` });
    return Number(state.marginSummary.accountValue);
  }

  fundingApr(coin: string) {
    return this.funding.fundingApr(coin);
  }

  async ioc(coin: string, size: number, slippageBps: number, reduceOnly = false): Promise<Fill> {
    const m = this.market(coin);
    const qty = roundToStep(size, m.spec.sizeStep);
    if (qty === 0) return { filledSize: 0, avgPx: 0, feeUsd: 0 };
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
}
