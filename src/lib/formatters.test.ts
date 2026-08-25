import { describe, expect, it } from 'vitest';

import {
  formatDuration,
  formatLatency,
  formatPercent,
  formatPrice,
  formatTimestamp,
  inferPriceDecimals,
} from './formatters';
import { bubbleRadius, liquidityIntensity, normalizeLiquidityLevels, quantile } from './visualizationMath';

describe('market formatters', () => {
  it('infers decimals from an instrument tick size', () => {
    expect(inferPriceDecimals(0.01)).toBe(2);
    expect(inferPriceDecimals(0.00005)).toBe(5);
    expect(formatPrice(1234.567, { locale: 'en-US', tickSize: 0.01 })).toBe('1,234.57');
  });

  it('formats percentages, latency, duration, and UTC timestamps', () => {
    expect(formatPercent(0.125, { locale: 'en-US' })).toBe('+12.5%');
    expect(formatLatency(1_250)).toBe('1.3 s');
    expect(formatDuration(3_661_000)).toBe('1:01:01');
    expect(
      formatTimestamp(Date.UTC(2025, 0, 2, 3, 4, 5), {
        locale: 'en-GB',
        timeZone: 'UTC',
      }),
    ).toContain('03:04:05');
  });

  it('uses a dash for missing data', () => {
    expect(formatPrice(null)).toBe('—');
    expect(formatLatency(Number.NaN)).toBe('—');
  });
});

describe('visualization math', () => {
  it('computes interpolated quantiles and log-scaled intensity', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(liquidityIntensity(10, 10)).toBe(1);
    expect(liquidityIntensity(100, 10)).toBe(1);
  });

  it('normalizes levels against a percentile and bounds bubble size', () => {
    const levels = normalizeLiquidityLevels([
      { price: 100, quantity: 1 },
      { price: 101, quantity: 9 },
    ], 1);

    expect(levels[0]?.intensity).toBeGreaterThan(0);
    expect(levels[1]?.intensity).toBe(1);
    expect(bubbleRadius(10_000, 1, { maximum: 20 })).toBe(20);
    expect(bubbleRadius(0, 1, { minimum: 4 })).toBe(4);
  });
});
