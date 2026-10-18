/**
 * Historical Trend Aggregation Service (Issue #876)
 *
 * Computes deterministic trend metrics over time windows for maintainer
 * analytics. Aggregates usage, failures, recovery actions, and domain
 * activity with schema-versioned output and private data redaction.
 */

import AggregatedAnalytics from "../models/AggregatedAnalytics";
import { logger } from "./structuredLogger";

export type TrendGranularity = "hour" | "day" | "week";
export type TrendMetricType = "count" | "sum" | "avg" | "min" | "max" | "p50" | "p95" | "p99";

export interface TrendMetricInput {
  eventType: string;
  timestamp: Date;
  value?: number;
  dimensions?: Record<string, string>;
}

export interface TrendWindow {
  start: Date;
  end: Date;
  granularity: TrendGranularity;
}

export interface TrendAggregationResult {
  schemaVersion: number;
  generatedAt: string;
  windows: TrendWindow[];
  metrics: Array<{
    eventType: string;
    timeWindow: Date;
    granularity: TrendGranularity;
    dimensions: Record<string, string>;
    metricName: string;
    metricType: TrendMetricType;
    value: number;
    count: number;
  }>;
  redacted: boolean;
}

const TREND_SCHEMA_VERSION = 1;

const SENSITIVE_DIMENSION_KEYS = [
  "wallet",
  "walletaddress",
  "address",
  "buyerwallet",
  "creatorwallet",
  "secret",
  "token",
  "apiKey",
  "privatekey",
  "seed",
  "mnemonic",
  "email",
  "phone",
];

/**
 * Redact private/sensitive dimension keys before storage or export.
 */
function redactDimensions(dimensions: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(dimensions)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_DIMENSION_KEYS.some((s) => lowerKey.includes(s));
    redacted[key] = isSensitive ? "[REDACTED]" : value;
  }
  return redacted;
}

/**
 * Compute a percentile from a sorted array of numbers.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = p / 100;
  const index = Math.ceil(rank * sorted.length) - 1;
  const clampedIndex = Math.max(0, Math.min(index, sorted.length - 1));
  return sorted[clampedIndex];
}

/**
 * Aggregate trend metrics for a set of events over time windows.
 * Deterministic: same input always produces same output.
 */
export function aggregateTrends(
  events: TrendMetricInput[],
  windows: TrendWindow[]
): TrendAggregationResult {
  const generatedAt = new Date().toISOString();
  const metrics: TrendAggregationResult["metrics"] = [];

  for (const window of windows) {
    const windowEvents = events.filter(
      (e) => e.timestamp >= window.start && e.timestamp <= window.end
    );

    const groups = new Map<
      string,
      { events: TrendMetricInput[]; dimensions: Record<string, string> }
    >();

    for (const event of windowEvents) {
      const dimKey = JSON.stringify(event.dimensions ?? {});
      const existing = groups.get(dimKey) || { events: [], dimensions: event.dimensions ?? {} };
      existing.events.push(event);
      groups.set(dimKey, existing);
    }

    for (const [, group] of groups) {
      const { events: groupEvents, dimensions } = group;
      const redactedDims = redactDimensions(dimensions);
      const eventType = groupEvents[0].eventType;

      metrics.push({
        eventType,
        timeWindow: window.start,
        granularity: window.granularity,
        dimensions: redactedDims,
        metricName: "count",
        metricType: "count",
        value: groupEvents.length,
        count: 1,
      });

      const values = groupEvents
        .map((e) => e.value ?? 0)
        .filter((v) => v !== 0);

      if (values.length > 0) {
        const sorted = [...values].sort((a, b) => a - b);
        const sum = values.reduce((a, b) => a + b, 0);
        const avg = sum / values.length;

        metrics.push({
          eventType,
          timeWindow: window.start,
          granularity: window.granularity,
          dimensions: redactedDims,
          metricName: "sum",
          metricType: "sum",
          value: sum,
          count: values.length,
        });

        metrics.push({
          eventType,
          timeWindow: window.start,
          granularity: window.granularity,
          dimensions: redactedDims,
          metricName: "avg",
          metricType: "avg",
          value: avg,
          count: values.length,
        });

        metrics.push({
          eventType,
          timeWindow: window.start,
          granularity: window.granularity,
          dimensions: redactedDims,
          metricName: "min",
          metricType: "min",
          value: sorted[0],
          count: 1,
        });

        metrics.push({
          eventType,
          timeWindow: window.start,
          granularity: window.granularity,
          dimensions: redactedDims,
          metricName: "max",
          metricType: "max",
          value: sorted[sorted.length - 1],
          count: 1,
        });

        metrics.push({
          eventType,
          timeWindow: window.start,
          granularity: window.granularity,
          dimensions: redactedDims,
          metricName: "p50",
          metricType: "p50",
          value: percentile(sorted, 50),
          count: 1,
        });

        metrics.push({
          eventType,
          timeWindow: window.start,
          granularity: window.granularity,
          dimensions: redactedDims,
          metricName: "p95",
          metricType: "p95",
          value: percentile(sorted, 95),
          count: 1,
        });

        metrics.push({
          eventType,
          timeWindow: window.start,
          granularity: window.granularity,
          dimensions: redactedDims,
          metricName: "p99",
          metricType: "p99",
          value: percentile(sorted, 99),
          count: 1,
        });
      }
    }
  }

  return {
    schemaVersion: TREND_SCHEMA_VERSION,
    generatedAt,
    windows,
    metrics,
    redacted: true,
  };
}

/**
 * Persist aggregated trend metrics to the database with TTL expiration.
 */
export async function persistTrendMetrics(
  result: TrendAggregationResult,
  ttlDays: number = 90
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  const docs = result.metrics.map((m) => ({
    eventType: m.eventType,
    timeWindow: m.timeWindow,
    granularity: m.granularity,
    dimensions: m.dimensions,
    metricName: m.metricName,
    metricType: m.metricType,
    value: m.value,
    count: m.count,
    expiresAt,
  }));

  if (docs.length > 0) {
    await AggregatedAnalytics.insertMany(docs, { ordered: false });
  }

  logger.info("Trend metrics persisted", {
    action: "trendAggregation",
    schemaVersion: result.schemaVersion,
    metricCount: docs.length,
    ttlDays,
  });
}

/**
 * Build standard trend windows for the last N days at daily granularity.
 */
export function buildDailyTrendWindow(days: number): TrendWindow[] {
  const windows: TrendWindow[] = [];
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);

  for (let i = days - 1; i >= 0; i--) {
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - i);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
    windows.push({ start, end, granularity: "day" });
  }

  return windows;
}

/**
 * Build standard trend windows for the last N hours at hourly granularity.
 */
export function buildHourlyTrendWindow(hours: number): TrendWindow[] {
  const windows: TrendWindow[] = [];
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);

  for (let i = hours - 1; i >= 0; i--) {
    const start = new Date(now);
    start.setUTCHours(start.getUTCHours() - i);
    const end = new Date(start);
    end.setUTCHours(end.getUTCHours() + 1);
    end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
    windows.push({ start, end, granularity: "hour" });
  }

  return windows;
}