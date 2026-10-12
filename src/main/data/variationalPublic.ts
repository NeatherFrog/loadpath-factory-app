import { getJson } from './http';

const URL = 'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats';

interface Quote {
  bid: string;
  ask: string;
}

export interface OmniListing {
  ticker: string;
  name: string;
  mark_price: string;
  volume_24h: string;
  open_interest?: { long_open_interest: string; short_open_interest: string };
  funding_rate: string; // annualized decimal
  funding_interval_s: number;
  base_spread_bps: string;
  quotes?: { updated_at: string; base?: Quote; size_1k?: Quote; size_100k?: Quote; size_1m?: Quote };
}

export interface OmniStats {
  total_volume_24h: string;
  cumulative_volume: string;
  tvl: string;
  open_interest: string;
  num_markets: number;
  loss_refund?: { pool_size: string; refunded_24h: string };
  listings: OmniListing[];
}

export function fetchOmniStats(): Promise<OmniStats> {
  return getJson<OmniStats>(URL, 15_000);
}
