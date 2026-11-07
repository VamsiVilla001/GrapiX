// Frame-rate choices for a graphic (11.43's "rational frame rate").
//
// A rate is always the exact rational the contract carries (invariant 12):
// 29.97 is 30000/1001 and 59.94 is 60000/1001, never a decimal. The broadcast
// list is what an author picks from; anything else is entered as `num/den`
// and refused unless both terms are positive integers, so a graphic can never
// hold a rate the engine cannot count in whole frames.

import type { RationalRate } from "@grapix/contracts";

export interface RateChoice {
  /// The option's value: `"num/den"`.
  readonly key: string;
  readonly label: string;
  readonly rate: RationalRate;
}

const choice = (num: number, den: number, label: string): RateChoice => ({
  key: `${num}/${den}`,
  label,
  rate: { num, den },
});

/// The broadcast rates offered by name, in ascending order.
export const BROADCAST_RATES: readonly RateChoice[] = [
  choice(24, 1, "24 fps (film)"),
  choice(25, 1, "25 fps (PAL)"),
  choice(30000, 1001, "29.97 fps (NTSC)"),
  choice(30, 1, "30 fps"),
  choice(50, 1, "50 fps (PAL progressive)"),
  choice(60000, 1001, "59.94 fps (NTSC progressive)"),
  choice(60, 1, "60 fps"),
];

/// The value a rate select shows for a rate, or `"custom"` when the rate is
/// not one of the named choices.
export function rateKey(rate: RationalRate): string {
  const key = `${rate.num}/${rate.den}`;
  return BROADCAST_RATES.some((entry) => entry.key === key) ? key : "custom";
}

export type RateParse = { readonly ok: true; readonly rate: RationalRate } | { readonly ok: false; readonly refused: string };

/// Read a rate from a select value, or from the custom `num`/`den` text when
/// the select says `custom`. Decimal input such as "29.97" is refused with
/// the rational it should be, rather than rounded into a drifting rate.
export function parseRateChoice(key: string, customNum: string, customDen: string): RateParse {
  if (key !== "custom") {
    const named = BROADCAST_RATES.find((entry) => entry.key === key);
    return named ? { ok: true, rate: named.rate } : { ok: false, refused: `unknown frame rate ${key}` };
  }
  const num = customNum.trim();
  const den = customDen.trim();
  if (/^\d+(\.\d+)$/.test(num)) {
    const decimal = Number(num);
    const hint = Math.abs(decimal - 29.97) < 0.01 ? " (29.97 is 30000/1001)" : Math.abs(decimal - 59.94) < 0.01 ? " (59.94 is 60000/1001)" : Math.abs(decimal - 23.976) < 0.01 ? " (23.976 is 24000/1001)" : "";
    return { ok: false, refused: `a frame rate is a whole-number ratio, not ${num}${hint}` };
  }
  if (!/^\d+$/.test(num) || !/^\d+$/.test(den)) {
    return { ok: false, refused: "enter the frame rate as two whole numbers, numerator and denominator" };
  }
  const rate = { num: Number(num), den: Number(den) };
  if (rate.num === 0 || rate.den === 0 || rate.num > 0xffffffff || rate.den > 0xffffffff) {
    return { ok: false, refused: `invalid rate: ${rate.num}/${rate.den}` };
  }
  return { ok: true, rate };
}

export function sameRate(a: RationalRate, b: RationalRate): boolean {
  return a.num === b.num && a.den === b.den;
}
