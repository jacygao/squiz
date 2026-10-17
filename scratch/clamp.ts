/** Clamps `value` to the inclusive range from `low` to `high`. */
export function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}
