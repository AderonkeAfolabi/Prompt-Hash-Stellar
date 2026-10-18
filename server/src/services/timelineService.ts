/**
 * Activity Timeline service — privacy-aware event filtering (#838).
 *
 * Provides paginated, visibility-filtered timeline queries.
 */

import TimelineEvent, {
  type TimelineEventType,
  type TimelineVisibility,
} from "../models/TimelineEvent";
import { minimizeOperationalMetadata } from "./operationalMetadata";

type TimelineCursor = { createdAt: string; id: string };

/**
 * Hard ceiling on timeline page size (#983). The controllers forward
 * `parseInt(req.query.limit) || 20` straight through, so without this a
 * caller could ask for `.limit(1000001)` and pull a user's entire event
 * history in one response. Keeps the documented default of 20 for normal use.
 */
export const TIMELINE_PAGE_SIZE_MAX = 100;

/** Clamp a caller-supplied timeline page size into `[1, TIMELINE_PAGE_SIZE_MAX]`. */
export function clampTimelineLimit(limit: number | undefined, fallback = 20): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), TIMELINE_PAGE_SIZE_MAX);
}

function encodeCursor(event: { createdAt: Date; _id: unknown }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: event.createdAt.toISOString(), id: String(event._id) }),
  ).toString("base64url");
}

function decodeCursor(cursor: string): TimelineCursor | { id: string } {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof decoded?.createdAt === "string" && typeof decoded?.id === "string") {
      const date = new Date(decoded.createdAt);
      if (!Number.isNaN(date.getTime())) return decoded;
    }
  } catch {
    // Fall through to the legacy ObjectId cursor for compatibility.
  }
  return { id: cursor };
}

function applyCursor(query: Record<string, any>, cursor?: string): void {
  if (!cursor) return;
  const decoded = decodeCursor(cursor);
  if ("createdAt" in decoded) {
    query.$or = [
      { createdAt: { $lt: new Date(decoded.createdAt) } },
      { createdAt: new Date(decoded.createdAt), _id: { $lt: decoded.id } },
    ];
  } else {
    query._id = { $lt: decoded.id };
  }
}

export class TimelineService {
  /**
   * Record a timeline event.
   */
  static async record(params: {
    eventType: TimelineEventType;
    visibility: TimelineVisibility;
    actorWallet?: string;
    recipientWallet: string;
    resourceType: string;
    resourceId?: string;
    summary: string;
    metadata?: Record<string, unknown>;
  }) {
    const event = new TimelineEvent({
      ...params,
      metadata: minimizeOperationalMetadata(params.metadata),
    });
    await event.save();
    return event;
  }

  /**
   * Get a user's timeline with privacy-aware filtering.
   * Maintainer-only events are excluded unless `includeMaintainer` is true.
   */
  static async getTimeline(params: {
    wallet: string;
    limit?: number;
    cursor?: string;
    includeMaintainer?: boolean;
    eventTypes?: TimelineEventType[];
  }) {
    const {
      wallet,
      limit: rawLimit = 20,
      cursor,
      includeMaintainer = false,
      eventTypes,
    } = params;

    // Worst-case page work stays bounded no matter what the caller sent.
    const limit = clampTimelineLimit(rawLimit);

    const visibilityFilter: TimelineVisibility[] = ["public"];
    if (includeMaintainer) {
      visibilityFilter.push("maintainer");
    }

    const query: any = {
      recipientWallet: wallet.toLowerCase(),
      visibility: { $in: visibilityFilter },
    };

    if (eventTypes?.length) {
      query.eventType = { $in: eventTypes };
    }

    applyCursor(query, cursor);

    const results = await TimelineEvent.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1);

    let hasNextPage = false;
    let nextCursor = null;

    if (results.length > limit) {
      hasNextPage = true;
      results.pop();
      nextCursor = encodeCursor(results[results.length - 1]);
    }

    return { data: results, metadata: { hasNextPage, nextCursor } };
  }

  /**
   * Get timeline for a specific resource (e.g., all events for a prompt).
   */
  static async getResourceTimeline(params: {
    resourceType: string;
    resourceId: string;
    limit?: number;
    cursor?: string;
  }) {
    const { resourceType, resourceId, limit = 20, cursor } = params;

    const query: any = {
      resourceType,
      resourceId,
      visibility: { $in: ["public"] },
    };

    applyCursor(query, cursor);

    const results = await TimelineEvent.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1);

    let hasNextPage = false;
    let nextCursor = null;

    if (results.length > limit) {
      hasNextPage = true;
      results.pop();
      nextCursor = encodeCursor(results[results.length - 1]);
    }

    return { data: results, metadata: { hasNextPage, nextCursor } };
  }
}
