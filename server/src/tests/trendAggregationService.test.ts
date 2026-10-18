import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  aggregateTrends,
  persistTrendMetrics,
  buildDailyTrendWindow,
  buildHourlyTrendWindow,
  type TrendWindow,
} from "../services/trendAggregationService";

vi.mock("../models/AggregatedAnalytics", () => ({
  default: {
    insertMany: vi.fn().mockResolvedValue([]),
  },
}));

import AggregatedAnalytics from "../models/AggregatedAnalytics";

const mockInsertMany = AggregatedAnalytics.insertMany as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("aggregateTrends - determinism (Issue #876)", () => {
  it("produces identical output for same input", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    const events = [
      { eventType: "purchase", timestamp: now, value: 10, dimensions: { category: "design" } },
      { eventType: "purchase", timestamp: now, value: 20, dimensions: { category: "design" } },
    ];
    const windows: TrendWindow[] = [
      { start: new Date("2026-01-14T00:00:00Z"), end: new Date("2026-01-15T23:59:59Z"), granularity: "day" },
    ];

    const result1 = aggregateTrends(events, windows);
    const result2 = aggregateTrends(events, windows);

    expect(result1).toEqual(result2);
    expect(result1.schemaVersion).toBe(1);
    expect(result1.redacted).toBe(true);
  });

  it("computes count metric correctly", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const events = [
      { eventType: "purchase", timestamp: now, dimensions: { category: "design" } },
      { eventType: "purchase", timestamp: now, dimensions: { category: "design" } },
      { eventType: "listing_created", timestamp: now, dimensions: { category: "writing" } },
    ];
    const windows: TrendWindow[] = [
      { start: new Date("2026-01-15T00:00:00Z"), end: new Date("2026-01-15T23:59:59Z"), granularity: "day" },
    ];

    const result = aggregateTrends(events, windows);
    const countMetrics = result.metrics.filter((m) => m.metricName === "count");
    expect(countMetrics).toHaveLength(2);
    const designCount = countMetrics.find((m) => m.dimensions.category === "design");
    expect(designCount?.value).toBe(2);
    const writingCount = countMetrics.find((m) => m.dimensions.category === "writing");
    expect(writingCount?.value).toBe(1);
  });

  it("computes sum, avg, min, max, p50, p95, p99 metrics", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const events = [
      { eventType: "purchase", timestamp: now, value: 10, dimensions: { category: "design" } },
      { eventType: "purchase", timestamp: now, value: 20, dimensions: { category: "design" } },
      { eventType: "purchase", timestamp: now, value: 30, dimensions: { category: "design" } },
      { eventType: "purchase", timestamp: now, value: 40, dimensions: { category: "design" } },
      { eventType: "purchase", timestamp: now, value: 50, dimensions: { category: "design" } },
    ];
    const windows: TrendWindow[] = [
      { start: new Date("2026-01-15T00:00:00Z"), end: new Date("2026-01-15T23:59:59Z"), granularity: "day" },
    ];

    const result = aggregateTrends(events, windows);
    const sumMetric = result.metrics.find((m) => m.metricName === "sum");
    expect(sumMetric?.value).toBe(150);
    const avgMetric = result.metrics.find((m) => m.metricName === "avg");
    expect(avgMetric?.value).toBe(30);
    const minMetric = result.metrics.find((m) => m.metricName === "min");
    expect(minMetric?.value).toBe(10);
    const maxMetric = result.metrics.find((m) => m.metricName === "max");
    expect(maxMetric?.value).toBe(50);
    const p50Metric = result.metrics.find((m) => m.metricName === "p50");
    expect(p50Metric?.value).toBe(30);
    const p95Metric = result.metrics.find((m) => m.metricName === "p95");
    expect(p95Metric?.value).toBe(50);
    const p99Metric = result.metrics.find((m) => m.metricName === "p99");
    expect(p99Metric?.value).toBe(50);
  });

  it("returns empty metrics when no events match windows", () => {
    const events = [
      { eventType: "purchase", timestamp: new Date("2026-01-01T00:00:00Z"), dimensions: {} },
    ];
    const windows: TrendWindow[] = [
      { start: new Date("2026-02-01T00:00:00Z"), end: new Date("2026-02-28T23:59:59Z"), granularity: "day" },
    ];

    const result = aggregateTrends(events, windows);
    expect(result.metrics).toEqual([]);
  });

  it("handles empty events array", () => {
    const windows: TrendWindow[] = [
      { start: new Date("2026-01-15T00:00:00Z"), end: new Date("2026-01-15T23:59:59Z"), granularity: "day" },
    ];
    const result = aggregateTrends([], windows);
    expect(result.metrics).toEqual([]);
  });
});

describe("redaction of private data (Issue #876)", () => {
  it("redacts sensitive dimension keys", () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const events = [
      {
        eventType: "purchase",
        timestamp: now,
        value: 10,
        dimensions: {
          walletAddress: "GAB...XYZ",
          buyerWallet: "GAC...ABC",
          email: "user@example.com",
          category: "design",
        },
      },
    ];
    const windows: TrendWindow[] = [
      { start: new Date("2026-01-15T00:00:00Z"), end: new Date("2026-01-15T23:59:59Z"), granularity: "day" },
    ];

    const result = aggregateTrends(events, windows);
    const countMetric = result.metrics.find((m) => m.metricName === "count");
    expect(countMetric?.dimensions.walletAddress).toBe("[REDACTED]");
    expect(countMetric?.dimensions.buyerWallet).toBe("[REDACTED]");
    expect(countMetric?.dimensions.email).toBe("[REDACTED]");
    expect(countMetric?.dimensions.category).toBe("design");
  });
});

describe("buildDailyTrendWindow (Issue #876)", () => {
  it("builds correct number of daily windows", () => {
    const windows = buildDailyTrendWindow(7);
    expect(windows).toHaveLength(7);
    expect(windows[0].granularity).toBe("day");
  });

  it("windows are contiguous and non-overlapping", () => {
    const windows = buildDailyTrendWindow(3);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].start.getTime()).toBeGreaterThan(windows[i - 1].start.getTime());
    }
  });
});

describe("buildHourlyTrendWindow (Issue #876)", () => {
  it("builds correct number of hourly windows", () => {
    const windows = buildHourlyTrendWindow(24);
    expect(windows).toHaveLength(24);
    expect(windows[0].granularity).toBe("hour");
  });
});

describe("persistTrendMetrics (Issue #876)", () => {
  it("calls insertMany with redacted metrics", async () => {
    const result = {
      schemaVersion: 1,
      generatedAt: "2026-01-15T00:00:00Z",
      windows: [],
      metrics: [
        {
          eventType: "purchase",
          timeWindow: new Date("2026-01-15T00:00:00Z"),
          granularity: "day",
          dimensions: { category: "design" },
          metricName: "count",
          metricType: "count",
          value: 5,
          count: 1,
        },
      ],
      redacted: true,
    };

    await persistTrendMetrics(result);

    expect(mockInsertMany).toHaveBeenCalledTimes(1);
    const docs = mockInsertMany.mock.calls[0][0];
    expect(docs[0].expiresAt).toBeDefined();
    expect(docs[0].schemaVersion).toBeUndefined();
  });

  it("does not call insertMany when no metrics", async () => {
    const result = {
      schemaVersion: 1,
      generatedAt: "2026-01-15T00:00:00Z",
      windows: [],
      metrics: [],
      redacted: true,
    };

    await persistTrendMetrics(result);
    expect(mockInsertMany).not.toHaveBeenCalled();
  });
});