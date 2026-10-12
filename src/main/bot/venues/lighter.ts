import type { Book, Fill, MarketSpec, Venue } from '../venue';
import { fetchLighterBook, fetchLighterMarkets, LIGHTER_API, type LighterMarket } from '../../data/lighterPublic';
import { loadLighterWasm, type LighterWasm } from '../../data/lighterSigner';
import { lighterPublicSource } from './sources';
import { roundPrice, roundToStep } from '../math';

const CHAIN_ID = 304; // Lighter mainnet signer chain
const ORDER_TYPE_LIMIT = 0;
const TIF_IOC = 0;
const TIF_POST_ONLY = 2;
const IOC_EXPIRY = 0;
const DEFAULT_EXPIRY = -1; // 28 days
const NIL = 0;

export interface LighterCredentials {
  /** Lighter account index (shown in the app / API page). */
  accountIndex: number;
  /** API key slot (2-254 for user keys). */
  apiKeyIndex: number;
  /** Lighter API private key (NOT an Ethereum key) — it can trade but cannot withdraw without L1 signature. */
  apiKeyPrivateKey: string;
}

interface AccountResponse {
  accounts: {
    collateral: string;
    total_asset_value?: string;
    positions: { market_id: number; sign: number; position: string }[] | null;
  }[];
}

/**
 * Live Lighter venue: 0% fees for standard accounts, which makes it the cheapest hedge leg.
 * Transactions are signed locally by Lighter's official Go signer (WebAssembly).
 */
export class LighterVenue implements Venue {
  readonly id = 'lighter' as const;
  readonly label = 'Lighter';
  readonly isPaper = false;
  private ready = false;
  private wasm!: LighterWasm;
  private markets = new Map<string, LighterMarket>();
  private funding = lighterPublicSource();
  private nonce: number | null = null;
  private orderSeq = Date.now() % 1_000_000_000;

  constructor(private creds: LighterCredentials) {}

  async init() {
    if (this.ready) return;
    this.wasm = await loadLighterWasm();
    const r = this.wasm.CreateClient(LIGHTER_API, this.creds.apiKeyPrivateKey.trim(), CHAIN_ID, this.creds.apiKeyIndex, this.creds.accountIndex);
    if (r?.error) throw new Error(`Lighter: ${r.error}`);
    this.markets = await fetchLighterMarkets();
    await this.funding.load();
    await this.account(); // validates the account index
    this.ready = true;
  }

  private market(coin: string): LighterMarket {
    const m = this.markets.get(coin);
    if (!m) throw new Error(`Lighter: no market ${coin}`);
    return m;
  }

  hasMarket(coin: string) {
    return this.markets.has(coin);
  }

  spec(coin: string): MarketSpec {
    return this.market(coin).spec;
  }

  book(coin: string): Promise<Book> {
    return fetchLighterBook(this.market(coin).marketId);
  }

  private async account() {
    const res = await fetch(`${LIGHTER_API}/api/v1/account?by=index&value=${this.creds.accountIndex}`, { signal: AbortSignal.timeout(10_000) });
    const r = (await res.json()) as AccountResponse & { message?: string };
    if (!r.accounts?.length) throw new Error(`Lighter: аккаунт ${this.creds.accountIndex} не найден (${r.message ?? res.status})`);
    return r.accounts[0];
  }

  async position(coin: string): Promise<number> {
    const { marketId } = this.market(coin);
    const acc = await this.account();
    const p = (acc.positions ?? []).find((x) => x.market_id === marketId);
    return p ? p.sign * Number(p.position) : 0;
  }

  async equityUsd(): Promise<number | null> {
    const acc = await this.account();
    return Number(acc.total_asset_value ?? acc.collateral);
  }

  fundingApr(coin: string) {
    return this.funding.fundingApr(coin);
  }

  private async nextNonce(): Promise<number> {
    if (this.nonce === null) {
      const r = await fetch(`${LIGHTER_API}/api/v1/nextNonce?account_index=${this.creds.accountIndex}&api_key_index=${this.creds.apiKeyIndex}`);
      this.nonce = ((await r.json()) as { nonce: number }).nonce;
    }
    return this.nonce++;
  }

  private async send(signed: { txType?: number; txInfo?: string; error?: string }): Promise<void> {
    if (signed.error || signed.txType === undefined || !signed.txInfo) throw new Error(`Lighter sign: ${signed.error ?? 'empty result'}`);
    const body = new URLSearchParams({ tx_type: String(signed.txType), tx_info: signed.txInfo });
    const res = await fetch(`${LIGHTER_API}/api/v1/sendTx`, { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
    const r = (await res.json()) as { code: number; message?: string };
    if (r.code !== 200) {
      this.nonce = null; // resync the nonce after any rejection
      throw new Error(`Lighter: ${r.message ?? r.code}`);
    }
  }

  private signOrder(m: LighterMarket, qty: number, price: number, tif: number, reduceOnly: boolean, nonce: number, clientIndex: number) {
    return this.wasm.SignCreateOrder(
      m.marketId,
      clientIndex,
      Math.round(Math.abs(qty) * 10 ** m.sizeDecimals),
      Math.round(price * 10 ** m.priceDecimals),
      qty < 0 ? 1 : 0, // is_ask
      ORDER_TYPE_LIMIT,
      tif,
      reduceOnly ? 1 : 0,
      NIL, // trigger price
      tif === TIF_IOC ? IOC_EXPIRY : DEFAULT_EXPIRY,
      NIL, // integrator account
      NIL, // integrator taker fee
      NIL, // integrator maker fee
      0, // self-trade behaviour: expire maker
      0, // self-trade equality: account index
      0, // skip nonce: disabled
      nonce,
      this.creds.apiKeyIndex,
      this.creds.accountIndex,
    );
  }

  async ioc(coin: string, size: number, slippageBps: number, reduceOnly = false): Promise<Fill> {
    const m = this.market(coin);
    const qty = roundToStep(size, m.spec.sizeStep);
    if (qty === 0) return { filledSize: 0, avgPx: 0, feeUsd: 0 };
    const b = await this.book(coin);
    const ref = qty > 0 ? b.ask : b.bid;
    const limit = roundPrice(ref * (1 + (Math.sign(qty) * slippageBps) / 10_000), m.spec.priceTick, qty > 0 ? 'up' : 'down');
    const before = await this.position(coin);
    await this.send(this.signOrder(m, qty, limit, TIF_IOC, reduceOnly, await this.nextNonce(), ++this.orderSeq));
    // The sequencer executes within ~a block; poll until the position reflects the fill.
    let filled = 0;
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 250 + i * 150));
      filled = Math.abs((await this.position(coin)) - before);
      if (filled >= Math.abs(qty) - m.spec.sizeStep / 2) break;
    }
    return { filledSize: filled, avgPx: filled > 0 ? ref : 0, feeUsd: filled * ref * (m.spec.takerFeeBps / 10_000) };
  }

  async postOnly(coin: string, size: number, price: number, reduceOnly = false): Promise<string | null> {
    const m = this.market(coin);
    const qty = roundToStep(size, m.spec.sizeStep);
    if (qty === 0) return null;
    const px = roundPrice(price, m.spec.priceTick, qty > 0 ? 'down' : 'up');
    const clientIndex = ++this.orderSeq;
    try {
      await this.send(this.signOrder(m, qty, px, TIF_POST_ONLY, reduceOnly, await this.nextNonce(), clientIndex));
    } catch (err) {
      if (/post.?only|cross/i.test(String(err))) return null;
      throw err;
    }
    return String(clientIndex);
  }

  async cancel(coin: string, orderId: string) {
    const m = this.market(coin);
    try {
      await this.send(this.wasm.SignCancelOrder(m.marketId, Number(orderId), 0, await this.nextNonce(), this.creds.apiKeyIndex, this.creds.accountIndex));
    } catch (err) {
      if (!/not found|does not exist|already/i.test(String(err))) throw err;
    }
  }
}
