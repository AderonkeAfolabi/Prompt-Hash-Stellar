/**
 * analytics_aggregate — aggregates historical trend metrics from marketplace
 * events into the AggregatedAnalytics collection. Idempotent: recomputes
 * windows from source events; safe to rerun. (Issue #876)
 */
import type { JobRecordDTO } from "../types";
import { aggregateTrends, persistTrendMetrics, buildDailyTrendWindow } from "../services/trendAggregationService";
import Purchase from "../models/Purchase";
import Prompt from "../models/Prompt";

export interface AnalyticsAggregatePayload {
  version: 1;
  windowDays?: number;
  creatorWallet?: string;
}

export async function handleAnalyticsAggregate(job: JobRecordDTO): Promise<void> {
  const { windowDays = 30, creatorWallet } = job.payload as AnalyticsAggregatePayload;
  if (!windowDays || windowDays < 1 || windowDays > 365) {
    throw new Error("analytics_aggregate: windowDays must be 1..365");
  }

  try {
    const windows = buildDailyTrendWindow(windowDays);
    const endTime = new Date();
    const startTime = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const purchaseQuery: any = {
      createdAt: { $gte: startTime, $lte: endTime },
    };
    if (creatorWallet) {
      purchaseQuery.buyerWallet = creatorWallet;
    }

    const purchases = await Purchase.find(purchaseQuery).lean();

    const events = purchases.map((p) => ({
      eventType: "purchase",
      timestamp: p.createdAt,
      value: Number(p.amount) || 0,
      dimensions: {
        category: p.category ?? "uncategorized",
        status: p.status ?? "unknown",
      },
    }));

    const prompts = await Prompt.find({ createdAt: { $gte: startTime, $lte: endTime } }).lean();

    const promptEvents = prompts.map((p) => ({
      eventType: "listing_created",
      timestamp: p.createdAt,
      dimensions: {
        category: p.category ?? "uncategorized",
      },
    }));

    const allEvents = [...events, ...promptEvents];
    const result = aggregateTrends(allEvents, windows);
    await persistTrendMetrics(result);
  } catch (err: any) {
    if (err.name === "MongooseError" || err.message?.includes("not connected")) {
      throw new Error(`DB not ready for analytics_aggregate — will retry: ${err.message}`);
    }
    throw err;
  }
}