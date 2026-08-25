import type { PriceLevel } from '../types/market';

export function clamp(value: number, minimum: number, maximum: number): number {
  if (minimum > maximum) throw new RangeError('minimum cannot be greater than maximum');
  return Math.min(maximum, Math.max(minimum, value));
}

export function quantile(values: readonly number[], percentile: number): number {
  const finite = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (finite.length === 0) return 0;
  const position = clamp(percentile, 0, 1) * (finite.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = finite[lowerIndex] ?? 0;
  const upper = finite[upperIndex] ?? lower;
  return lower + (upper - lower) * (position - lowerIndex);
}

/** Log-scaled heatmap intensity, robust to a single unusually large wall. */
export function liquidityIntensity(
  quantity: number,
  referenceQuantity: number,
): number {
  if (quantity <= 0 || referenceQuantity <= 0) return 0;
  return clamp(Math.log1p(quantity) / Math.log1p(referenceQuantity), 0, 1);
}

export interface LevelWithIntensity extends PriceLevel {
  intensity: number;
}

export function normalizeLiquidityLevels(
  levels: readonly PriceLevel[],
  referencePercentile = 0.95,
): LevelWithIntensity[] {
  const reference = quantile(
    levels.map((level) => level.quantity),
    referencePercentile,
  );
  return levels.map((level) => ({
    ...level,
    intensity: liquidityIntensity(level.quantity, reference),
  }));
}

/** Square-root bubble scaling from the product plan, with safe invalid-input handling. */
export function bubbleRadius(
  volume: number,
  medianVolume: number,
  options: { minimum?: number; maximum?: number; scale?: number } = {},
): number {
  const minimum = options.minimum ?? 3;
  const maximum = options.maximum ?? 28;
  const scale = options.scale ?? 7;
  if (!Number.isFinite(volume) || !Number.isFinite(medianVolume) || volume <= 0 || medianVolume <= 0) {
    return minimum;
  }
  return clamp(scale * Math.sqrt(volume / medianVolume), minimum, maximum);
}
