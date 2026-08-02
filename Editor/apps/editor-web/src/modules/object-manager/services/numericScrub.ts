export function scrubNumericValue(
  startValue: number,
  deltaPixels: number,
  step: number,
  sensitivity = 1,
  min?: number,
  max?: number
): number {
  const finiteStep = Number.isFinite(step) && step > 0 ? step : 1;
  const finiteSensitivity = Number.isFinite(sensitivity) && sensitivity > 0 ? sensitivity : 1;
  const candidate = startValue + deltaPixels * finiteStep * finiteSensitivity;
  const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, candidate));
  const precision = Math.min(8, Math.max(0, decimalPlaces(finiteStep) + 2));
  return Number(clamped.toFixed(precision));
}

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
}
