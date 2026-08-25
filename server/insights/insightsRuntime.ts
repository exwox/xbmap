import { SCHEMA_VERSION, type ServerEnvelope } from "../types.js";
import {
  InsightEngine,
  type InsightFrame,
} from "./insightEngine.js";
import {
  AlertEngine,
  ALERT_ALGO_VERSION,
  SIGNAL_HORIZONS_MS,
  type AlertRule,
  type TriggeredAlert,
} from "../alerts/alertEngine.js";
import type { DerivativesUpdate } from "../feeds/binanceDerivatives.js";
import type { LiquidationEvent } from "../feeds/binanceLiquidations.js";

export { ALERT_ALGO_VERSION, SIGNAL_HORIZONS_MS };

/**
 * Phase 5 glue: owns one `InsightEngine` per active market session, feeds it
 * from the gateway event stream, publishes bounded `insight` frames, evaluates
 * alert rules, and delivers triggered alerts through the configured channels
 * (WS always; webhook/Telegram when configured).
 */

export type PublishFn = (envelope: ServerEnvelope) => void;

export interface InsightsRuntimeOptions {
  alertEngine?: AlertEngine;
  shadowMode?: boolean;
  initialRules?: AlertRule[];
  /** Persistence sink invoked whenever the rule set changes. */
  onRulesPersist?: (rules: readonly AlertRule[]) => void;
  webhookUrl?: string | null;
  telegramBotToken?: string | null;
  telegramChatId?: string | null;
  fetchFn?: typeof fetch;
}

interface SessionState {
  engine: InsightEngine;
  tickSize: number;
  trendScore: number;
  trendDirection: "up" | "down" | null;
  volumeDelta: number;
  tradeVelocity: number;
  lastPrice: number | null;
  priceRing: number[];
}

const PRICE_RING_SIZE = 60;

export class InsightsRuntime {
  readonly alertEngine: AlertEngine;
  private readonly engines = new Map<string, SessionState>();
  private readonly sequences = new Map<string, number>();
  private publisher: PublishFn | null = null;
  private readonly webhookUrl: string | null;
  private readonly telegram: { botToken: string; chatId: string } | null;
  private readonly fetchFn: typeof fetch;

  constructor(options: InsightsRuntimeOptions = {}) {
    this.alertEngine =
      options.alertEngine ??
      new AlertEngine({
        shadowMode: options.shadowMode ?? false,
        onRulesChanged: options.onRulesPersist,
      });
    this.webhookUrl = options.webhookUrl ?? null;
    this.telegram =
      options.telegramBotToken && options.telegramChatId
        ? { botToken: options.telegramBotToken, chatId: options.telegramChatId }
        : null;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    const restored = this.alertEngine.restoreRules(options.initialRules ?? []);
    void restored;
  }

  /** Called once by the transport layer after the WS surface exists. */
  setPublisher(publish: PublishFn): void {
    this.publisher = publish;
  }

  ensureSession(symbol: string, tickSize: number): void {
    const normalized = symbol.trim().toUpperCase();
    if (this.engines.has(normalized)) return;
    this.engines.set(normalized, {
      engine: new InsightEngine({ symbol: normalized, tickSize }),
      tickSize,
      trendScore: 0,
      trendDirection: null,
      volumeDelta: 0,
      tradeVelocity: 0,
      lastPrice: null,
      priceRing: [],
    });
  }

  dropSession(symbol: string): void {
    this.engines.delete(symbol.trim().toUpperCase());
  }

  setDerivatives(update: DerivativesUpdate): void {
    const session = this.engines.get(update.symbol);
    session?.engine.setDerivatives({
      fundingRate: update.fundingRate,
      nextFundingTime: update.nextFundingTime,
      markPrice: update.markPrice,
      openInterest: update.openInterest,
      stale: update.stale,
      updatedAtMs: update.fetchedAtMs,
    });
  }

  /** Forwards one real-market forced liquidation to the session engine. */
  pushLiquidation(event: LiquidationEvent): void {
    this.engines.get(event.symbol)?.engine.pushLiquidation({
      liquidatedSide: event.liquidatedSide,
      price: event.price,
      quantity: event.quantity,
      timestamp: event.timestamp,
    });
  }

  activeSymbols(): string[] {
    return [...this.engines.keys()];
  }

  // PHASE5_RUNTIME_PART_B

  /** Feeds one gateway envelope into the matching session engine. */
  handleGatewayEvent(envelope: ServerEnvelope): void {
    const session = this.engines.get(envelope.symbol?.trim().toUpperCase() ?? "");
    if (!session) return;
    switch (envelope.type) {
      case "snapshot":
      case "depth_frame":
      case "trade_bucket":
        session.engine.handleEvent(envelope);
        return;
      case "metric": {
        session.engine.handleEvent(envelope);
        const metric = envelope.data as { tradeRate?: number; delta?: number };
        if (typeof metric.tradeRate === "number") session.tradeVelocity = metric.tradeRate;
        if (typeof metric.delta === "number") session.volumeDelta = metric.delta;
        return;
      }
      case "trend_signal": {
        session.engine.handleEvent(envelope);
        const trend = envelope.data as { score?: number; direction?: string };
        if (typeof trend.score === "number") session.trendScore = trend.score;
        session.trendDirection =
          trend.direction === "up" || trend.direction === "down" ? trend.direction : null;
        return;
      }
      case "price": {
        const price = (envelope.data as { price?: number }).price;
        if (typeof price === "number" && Number.isFinite(price)) {
          session.lastPrice = price;
          session.priceRing.push(price);
          if (session.priceRing.length > PRICE_RING_SIZE) session.priceRing.shift();
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * One publish/evaluation cadence step. Returns every envelope that should
   * be broadcast: insight frames plus deliverable alert envelopes.
   */
  tick(): ServerEnvelope[] {
    const envelopes: ServerEnvelope[] = [];
    const now = Date.now();
    for (const [symbol, session] of this.engines) {
      const frame = session.engine.maybePublish();
      if (frame) envelopes.push(this.envelope("insight", symbol, frame));

      const triggers = this.alertEngine.evaluate({
        symbol,
        ts: now,
        price: session.lastPrice,
        trendScore: session.trendScore,
        trendDirection: session.trendDirection,
        wallTransitions: frame?.wallTransitions ?? [],
        volumeDelta: session.volumeDelta,
        tradeVelocity: session.tradeVelocity,
        realizedVolBps: realizedVolatilityBps(session.priceRing),
      });
      for (const trigger of triggers) {
        envelopes.push(this.envelope("alert", trigger.symbol, trigger));
        this.alertEngine.recordDelivery(trigger.ruleId, trigger.symbol, "ws");
        void this.deliverExternal(trigger);
      }
    }
    return envelopes;
  }

  currentInsight(symbol: string): InsightFrame | null {
    const normalized = symbol.trim().toUpperCase();
    return this.engines.get(normalized)?.engine.snapshotFrame() ?? null;
  }

  private async deliverExternal(trigger: TriggeredAlert): Promise<void> {
    const jobs: Array<{ channel: "webhook" | "telegram"; url: string; body: unknown }> = [];
    if (this.webhookUrl) {
      jobs.push({ channel: "webhook", url: this.webhookUrl, body: trigger });
    }
    if (this.telegram) {
      jobs.push({
        channel: "telegram",
        url: `https://api.telegram.org/bot${this.telegram.botToken}/sendMessage`,
        body: { chat_id: this.telegram.chatId, text: `[${trigger.kind}] ${trigger.symbol}: ${trigger.reason}` },
      });
    }
    await Promise.all(jobs.map(async (job) => {
      const ok = await this.postJson(job.url, job.body);
      this.alertEngine.recordDelivery(trigger.ruleId, trigger.symbol, job.channel, !ok);
    }));
  }

  private async postJson(url: string, body: unknown): Promise<boolean> {
    try {
      const response = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private envelope(type: "insight" | "alert", symbol: string, data: unknown): ServerEnvelope {
    const sequenceKey = `${type}:${symbol}`;
    const sequence = (this.sequences.get(sequenceKey) ?? 0) + 1;
    this.sequences.set(sequenceKey, sequence);
    return {
      type,
      schemaVersion: SCHEMA_VERSION,
      exchange: "binance",
      symbol,
      serverTimestamp: Date.now(),
      sequence,
      data,
    };
  }
}

/** Realized volatility proxy: range/mean ratio of recent prints, in bps. */
function realizedVolatilityBps(prices: number[]): number {
  if (prices.length < 4) return 0;
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const mean = prices.reduce((sum, value) => sum + value, 0) / prices.length;
  if (mean <= 0) return 0;
  return ((high - low) / mean) * 10_000;
}
