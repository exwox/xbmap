import { describe, expect, it } from "vitest";
import {
  INSTRUMENTS,
  instrumentFor,
  isSupportedSymbol,
  supportedSymbols,
} from "./instruments.js";

describe("instrument registry", () => {
  it("lists the three beta symbols with correct tick sizes", () => {
    expect(supportedSymbols()).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    expect(instrumentFor("BTCUSDT").tickSize).toBe(0.1);
    expect(instrumentFor("ethusdt").tickSize).toBe(0.01);
    expect(instrumentFor(" SOLUSDT ").tickSize).toBe(0.01);
  });

  it("normalizes case and whitespace but rejects unknown symbols", () => {
    expect(isSupportedSymbol(" btcusdt ")).toBe(true);
    expect(isSupportedSymbol("DOGEUSDT")).toBe(false);
    expect(() => instrumentFor("DOGEUSDT")).toThrow(/Unsupported symbol/);
  });

  it("keeps registry entries internally consistent", () => {
    for (const instrument of INSTRUMENTS) {
      expect(instrument.tickSize).toBeGreaterThan(0);
      expect(instrument.symbol).toBe(instrument.base + instrument.quote);
    }
  });
});
