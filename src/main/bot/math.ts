// Pure helpers used by the engine and the venue adapters. Covered by unit tests.

export function roundToStep(value: number, step: number): number {
  if (!(step > 0)) return value;
  const sign = Math.sign(value);
  const steps = Math.floor(Math.abs(value) / step + 1e-9);
  return sign * Number((steps * step).toFixed(decimalsOf(step)));
}

export function roundPrice(px: number, tick: number, mode: 'up' | 'down'): number {
  if (!(tick > 0)) return px;
  const n = mode === 'up' ? Math.ceil(px / tick - 1e-9) : Math.floor(px / tick + 1e-9);
  return Number((n * tick).toFixed(decimalsOf(tick)));
}

export function decimalsOf(step: number): number {
  if (step >= 1) return 0;
  const s = step.toExponential();
  const [mantissa, exp] = s.split('e');
  const mantDecimals = (mantissa.split('.')[1] ?? '').length;
  return Math.max(0, mantDecimals - Number(exp));
}

export function spreadBps(bid: number, ask: number): number {
  const mid = (bid + ask) / 2;
  return mid > 0 ? ((ask - bid) / mid) * 10_000 : Infinity;
}

export function basisBps(midA: number, midB: number): number {
  const mid = (midA + midB) / 2;
  return mid > 0 ? (Math.abs(midA - midB) / mid) * 10_000 : Infinity;
}

/** Size both venues can trade: rounded down to the least common multiple of their size steps. */
export function commonSize(notionalUsd: number, px: number, stepA: number, stepB: number): number {
  return roundToStep(notionalUsd / px, lcmStep(stepA, stepB));
}

export function lcmStep(a: number, b: number): number {
  const d = Math.max(decimalsOf(a), decimalsOf(b));
  const scale = 10 ** d;
  const ai = Math.round(a * scale);
  const bi = Math.round(b * scale);
  return ((ai / gcd(ai, bi)) * bi) / scale;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

export function randomBetween(min: number, max: number, rnd: () => number = Math.random): number {
  if (max <= min) return min;
  return min + (max - min) * rnd();
}

/**
 * Which side to take on the farm leg (A). With 'funding' we go long on the venue
 * where longs pay less (or get paid), short on the other.
 * Returns +1 (A long / B short) or -1 (A short / B long).
 */
export function chooseDirection(
  mode: 'random' | 'funding',
  fundingA: number | null,
  fundingB: number | null,
  rnd: () => number = Math.random,
): 1 | -1 {
  if (mode === 'funding' && fundingA !== null && fundingB !== null && Math.abs(fundingA - fundingB) > 0.01) {
    return fundingA < fundingB ? 1 : -1;
  }
  return rnd() < 0.5 ? 1 : -1;
}

export function utcDay(ts: number = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}
