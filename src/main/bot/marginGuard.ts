import type { IsolatedLeg, Venue } from './venue';

/** Top a leg up when the price is this close (fraction of price) to its liquidation price… */
export const ALERT_DISTANCE = 0.2;
/** …so that it is at least this far away again. */
export const SAFE_DISTANCE = 0.3;
/** Closer than this and no money to add: the position must be reduced. */
export const DANGER_DISTANCE = 0.1;

/** How far the price may move against the leg before it is liquidated (fraction of price). */
export function liqDistance(leg: IsolatedLeg | null): number {
  if (!leg || leg.liquidationPx === null || !(leg.markPx > 0)) return Infinity;
  const d = leg.size > 0 ? (leg.markPx - leg.liquidationPx) / leg.markPx : (leg.liquidationPx - leg.markPx) / leg.markPx;
  return Math.max(0, d);
}

/** Margin that moves the liquidation price far enough away (adding X USD moves it by X/size). */
export function marginNeeded(leg: IsolatedLeg): number {
  const d = liqDistance(leg);
  return d >= ALERT_DISTANCE ? 0 : leg.positionValueUsd * (SAFE_DISTANCE - d);
}

/** Margin a winning leg can give away while staying comfortably safe itself. */
export function marginSpare(leg: IsolatedLeg): number {
  if (!leg.isolated || !leg.removable) return 0;
  const d = liqDistance(leg);
  if (!Number.isFinite(d)) return Math.max(0, leg.marginUsd - leg.positionValueUsd / 2);
  return Math.max(0, leg.positionValueUsd * (d - SAFE_DISTANCE - 0.05));
}

export interface GuardResult {
  events: string[];
  /** A leg is close to liquidation and could not be topped up: reduce the position. */
  danger: boolean;
}

/**
 * Both legs of a mirrored position use isolated margin, so a big price move can liquidate the
 * losing leg while the winning one sits on the profit. Each tick: move spare margin from the
 * winner (or free collateral) to the loser.
 */
export async function guardIsolatedMargin(a: Venue, b: Venue, coin: string): Promise<GuardResult> {
  const res: GuardResult = { events: [], danger: false };
  if (!a.isolatedLeg || !b.isolatedLeg || !a.adjustIsolatedMargin || !b.adjustIsolatedMargin) return res;
  const [legA, legB] = await Promise.all([a.isolatedLeg(coin), b.isolatedLeg(coin)]);
  const sides: [Venue, IsolatedLeg | null, Venue, IsolatedLeg | null][] = [
    [a, legA, b, legB],
    [b, legB, a, legA],
  ];
  for (const [venue, leg, otherVenue, other] of sides) {
    if (!leg?.isolated) continue; // a cross-margin leg already draws on the free balance
    let need = marginNeeded(leg);
    if (need <= 0) continue;
    const free = Math.max(0, ((await venue.freeCollateralUsd?.()) ?? 0) - 1);
    if (free < need && other) {
      const take = Math.min(need - free, marginSpare(other));
      if (take >= 1) {
        try {
          await otherVenue.adjustIsolatedMargin!(coin, -take);
          res.events.push(`${otherVenue.label}: забрал $${take.toFixed(0)} лишней маржи с выигрывающей ноги`);
        } catch (err) {
          res.events.push(`${otherVenue.label}: не удалось забрать маржу (${err instanceof Error ? err.message : err})`);
        }
      }
    }
    const avail = Math.max(0, ((await venue.freeCollateralUsd?.()) ?? 0) - 1);
    const add = Math.min(need, avail);
    let added = 0;
    if (add >= 1) {
      try {
        await venue.adjustIsolatedMargin!(coin, add);
        added = add;
        res.events.push(`${venue.label}: добавил $${add.toFixed(0)} маржи — цена близко к ликвидации ${coin}`);
      } catch (err) {
        res.events.push(`${venue.label}: не удалось добавить маржу (${err instanceof Error ? err.message : err})`);
      }
    }
    need -= added;
    if (need > 0 && liqDistance(leg) + added / leg.positionValueUsd < DANGER_DISTANCE) res.danger = true;
  }
  return res;
}
