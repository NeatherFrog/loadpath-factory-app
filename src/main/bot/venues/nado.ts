import { addDecimals, createNadoClient, getOrderNonce, packOrderAppendix, type NadoClient } from '@nadohq/client';
import { createPublicClient, createWalletClient, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ink } from 'viem/chains';
import type { Book, Fill, MarketSpec, Venue } from '../venue';
import { fetchNadoBook, fetchNadoMarkets, type NadoMarket } from '../../data/nadoPublic';
import { nadoPublicSource } from './sources';
import { roundPrice, roundToStep } from '../math';

const X18 = 1e18;

export interface NadoCredentials {
  /** Wallet that owns the Nado subaccount. */
  address: string;
  /** Private key of the main wallet or (recommended) of a linked signer. */
  privateKey: string;
  subaccount: string;
}

/**
 * Live Nado venue. Orders are signed locally (EIP-712) and sent to the Nado sequencer.
 * Use a linked signer key: it can trade the subaccount but you can revoke it any time.
 */
export class NadoVenue implements Venue {
  readonly id = 'nado' as const;
  readonly label = 'Nado';
  readonly isPaper = false;
  private client!: NadoClient;
  private markets = new Map<string, NadoMarket>();
  private funding = nadoPublicSource();

  constructor(private creds: NadoCredentials) {}

  private ready = false;

  async init() {
    if (this.ready) return;
    const account = privateKeyToAccount(normalizeKey(this.creds.privateKey));
    // Ink's OP-stack block formatters make the chain-specific client type differ from the SDK's generic one.
    const publicClient = createPublicClient({ chain: ink, transport: http() }) as unknown as PublicClient;
    const walletClient = createWalletClient({ account, chain: ink, transport: http() });
    this.client = createNadoClient({ chainEnv: 'inkMainnet', clientType: 'retrodrop' }, { publicClient, walletClient });
    this.markets = await fetchNadoMarkets();
    await this.funding.load();
    // Fails fast on a wrong address / missing subaccount.
    const summary = await this.client.subaccount.getSubaccountSummary(this.subaccount());
    if (!summary.exists) throw new Error('Nado: субаккаунт не найден — сделай депозит на nado.xyz (минимум $5 USDT0)');
    this.ready = true;
  }

  private subaccount() {
    return { subaccountOwner: this.creds.address, subaccountName: this.creds.subaccount || 'default' };
  }

  private market(coin: string): NadoMarket {
    const m = this.markets.get(coin);
    if (!m) throw new Error(`Nado: no market ${coin}`);
    return m;
  }

  hasMarket(coin: string) {
    return this.markets.has(coin);
  }

  spec(coin: string): MarketSpec {
    return this.market(coin).spec;
  }

  book(coin: string): Promise<Book> {
    return fetchNadoBook(this.market(coin).symbol);
  }

  async position(coin: string): Promise<number> {
    const { productId } = this.market(coin);
    const summary = await this.client.subaccount.getSubaccountSummary(this.subaccount());
    const bal = summary.balances.find((b) => b.productId === productId);
    return bal ? Number(bal.amount.toString()) / X18 : 0;
  }

  async equityUsd(): Promise<number | null> {
    const summary = await this.client.subaccount.getSubaccountSummary(this.subaccount());
    return Number(summary.health.unweighted.health.toString()) / X18;
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
    const limit = roundPrice(ref * (1 + (Math.sign(qty) * slippageBps) / 10_000), m.spec.priceTick, qty > 0 ? 'up' : 'down');

    const before = await this.position(coin);
    const res = await this.client.market.placeOrder({
      productId: m.productId,
      order: {
        ...this.subaccount(),
        price: limit,
        amount: addDecimals(qty.toString()),
        expiration: Math.floor(Date.now() / 1000) + 60,
        appendix: packOrderAppendix({ orderExecutionType: 'ioc', reduceOnly }),
      },
      nonce: getOrderNonce(),
    });
    if (res.status !== 'success') throw new Error(`Nado order rejected: ${JSON.stringify(res)}`);

    // IOC is matched synchronously by the sequencer; the position delta is the filled amount.
    const after = await this.position(coin);
    const filled = Math.abs(after - before);
    if (filled === 0) return { filledSize: 0, avgPx: 0, feeUsd: 0 };
    // Exact average price and fee come from the indexer (it lags the sequencer by ~1s).
    const exact = await this.orderFill(res.data.digest);
    if (exact) return { filledSize: filled, avgPx: exact.avgPx, feeUsd: exact.feeUsd };
    return { filledSize: filled, avgPx: ref, feeUsd: filled * ref * (m.spec.takerFeeBps / 10_000) };
  }

  /** Average fill price and fee of an order, read from the Nado indexer. */
  private async orderFill(digest: string): Promise<{ avgPx: number; feeUsd: number } | null> {
    for (let i = 0; i < 6; i++) {
      try {
        const [o] = await this.client.context.indexerClient.getOrders({ digests: [digest] });
        if (o && !o.baseFilled.isZero()) {
          const base = Math.abs(Number(o.baseFilled.toString()) / X18);
          const quote = Math.abs(Number(o.quoteFilled.toString()) / X18);
          const fee = Number(o.totalFee.toString()) / X18;
          // quoteFilled includes the fee: buys pay base*px + fee, sells receive base*px - fee.
          const notional = o.baseFilled.isPositive() ? quote - fee : quote + fee;
          return { avgPx: notional / base, feeUsd: fee };
        }
      } catch {
        // indexer not caught up yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  async postOnly(coin: string, size: number, price: number, reduceOnly = false): Promise<string | null> {
    const m = this.market(coin);
    const qty = roundToStep(size, m.spec.sizeStep);
    if (qty === 0) return null;
    const px = roundPrice(price, m.spec.priceTick, qty > 0 ? 'down' : 'up');
    try {
      const res = await this.client.market.placeOrder({
        productId: m.productId,
        order: {
          ...this.subaccount(),
          price: px,
          amount: addDecimals(qty.toString()),
          expiration: Math.floor(Date.now() / 1000) + 600,
          appendix: packOrderAppendix({ orderExecutionType: 'post_only', reduceOnly }),
        },
        nonce: getOrderNonce(),
      });
      return res.status === 'success' ? res.data.digest : null;
    } catch (err) {
      // Post-only orders that would cross the book are rejected by the engine.
      if (/post.?only|cross/i.test(String(err))) return null;
      throw err;
    }
  }

  async cancel(coin: string, orderId: string) {
    const m = this.market(coin);
    try {
      await this.client.market.cancelOrders({ ...this.subaccount(), productIds: [m.productId], digests: [orderId] });
    } catch (err) {
      // Already filled or expired — nothing to cancel.
      if (!/not found|does not exist|unknown order/i.test(String(err))) throw err;
    }
  }
}

function normalizeKey(k: string): `0x${string}` {
  const key = k.trim();
  return (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`;
}
