import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

/**
 * HTTP-level tests for the abuse-risk admin review surface (#1046).
 *
 * `requireAdminScope` is replaced with a deterministic header-driven stub so
 * these tests exercise the ROUTING and authorization wiring (which scope each
 * route demands, deny-before-handler) without standing up the HMAC admin
 * token infrastructure — that is covered by adminAuth.test.ts.
 *
 * The review queue and activity ledger are the real singletons, so the
 * one-shot approval semantics and the "approval releases a held operation"
 * round-trip are verified end-to-end.
 */

const auditCalls = vi.hoisted(() => [] as any[]);

vi.mock("../services/auditTrail", () => ({
  recordAuditEvent: (event: any) => {
    auditCalls.push(event);
    return Promise.resolve();
  },
}));

vi.mock("../middleware/adminAuth", () => ({
  requireAdminScope: (scope: string) => (req: any, res: any, next: any) => {
    const header = req.headers["x-test-admin"];
    if (!header) {
      res
        .status(401)
        .json({ error: "Unauthorized: admin bearer token required." });
      return;
    }
    const [sub, scopes] = String(header).split("|");
    if (scopes && !scopes.split(",").includes(scope)) {
      res
        .status(401)
        .json({ error: "Unauthorized: invalid or insufficient admin token." });
      return;
    }
    req.admin = { sub: sub || "admin-test" };
    next();
  },
}));

import { abuseRiskRouter } from "../routes/abuseRiskRoutes";
import {
  abuseActivityLedger,
  abuseReviewQueue,
  evaluateOperation,
} from "../services/abuseRiskScoring";

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ADMIN = {
  headers: { "x-test-admin": "admin-test|abuse-risk:read,abuse-risk:write" },
};
const READ_ONLY = { headers: { "x-test-admin": "admin-test|abuse-risk:read" } };

let server: Server;
let base: string;

function heat() {
  for (let i = 0; i < 25; i++) {
    abuseActivityLedger.record(
      {
        operation: "payout_request",
        wallet: WALLET,
        ip: `3.3.3.${i}`,
        target: "t",
      },
      false,
    );
  }
}

/** Queue one pending review and return its id. */
function seedReview(): string {
  heat();
  const outcome = evaluateOperation(
    {
      operation: "payout_request",
      wallet: WALLET,
      target: "t",
      amount: 900,
      now: Date.now(),
    },
    "enforce",
  );
  expect(outcome.reviewId).toBeDefined();
  return outcome.reviewId!;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/abuse-risk", abuseRiskRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}/api/admin/abuse-risk`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  abuseActivityLedger.reset();
  abuseReviewQueue.clear();
  auditCalls.length = 0;
});

describe("GET /reviews", () => {
  it("denies unauthenticated requests before touching the queue", async () => {
    seedReview();
    const res = await fetch(`${base}/reviews`);
    expect(res.status).toBe(401);
    expect(await res.json()).toHaveProperty("error");
  });

  it("denies a token missing abuse-risk:read", async () => {
    const res = await fetch(`${base}/reviews`, {
      headers: { "x-test-admin": "admin-test|other:scope" },
    });
    expect(res.status).toBe(401);
  });

  it("lists queued reviews for an authorized admin", async () => {
    const reviewId = seedReview();
    const res = await fetch(`${base}/reviews`, ADMIN);
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: any[] };
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(reviewId);
    expect(items[0].status).toBe("pending");
    expect(items[0].operation).toBe("payout_request");
    expect(typeof items[0].score).toBe("number");
    expect(items[0].signals.length).toBeGreaterThan(0);
    // The queue stores only the hashed subject — never the raw wallet.
    expect(items[0].subject).not.toBe(WALLET);
    expect(items[0].subject).toMatch(/^[0-9a-f]{64}$/);
  });

  it("filters by status and rejects unknown statuses", async () => {
    seedReview();
    const pending = await fetch(`${base}/reviews?status=pending`, ADMIN);
    expect(((await pending.json()) as { items: any[] }).items).toHaveLength(1);

    const approved = await fetch(`${base}/reviews?status=approved`, ADMIN);
    expect(((await approved.json()) as { items: any[] }).items).toHaveLength(0);

    const bad = await fetch(`${base}/reviews?status=banana`, ADMIN);
    expect(bad.status).toBe(400);
  });
});

describe("POST /reviews/:id/resolve", () => {
  it("validates the decision", async () => {
    const res = await fetch(`${base}/reviews/risk_x/resolve`, {
      ...ADMIN,
      method: "POST",
      headers: { ...ADMIN.headers, "content-type": "application/json" },
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s for an unknown review id", async () => {
    const res = await fetch(`${base}/reviews/risk_missing/resolve`, {
      method: "POST",
      headers: { ...ADMIN.headers, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(res.status).toBe(404);
  });

  it("requires abuse-risk:write and audits the denial path via the auth layer", async () => {
    const reviewId = seedReview();
    const res = await fetch(`${base}/reviews/${reviewId}/resolve`, {
      method: "POST",
      headers: { ...READ_ONLY.headers, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    // Read-only token lacks abuse-risk:write → rejected before the handler.
    expect(res.status).toBe(401);
    expect(abuseReviewQueue.get(reviewId)?.status).toBe("pending");
  });

  it("approves exactly once (one-shot) and audits", async () => {
    const reviewId = seedReview();
    const first = await fetch(`${base}/reviews/${reviewId}/resolve`, {
      method: "POST",
      headers: { ...ADMIN.headers, "content-type": "application/json" },
      body: JSON.stringify({
        decision: "approved",
        note: "verified with owner",
      }),
    });
    expect(first.status).toBe(200);
    const { item } = (await first.json()) as { item: any };
    expect(item.status).toBe("approved");
    expect(item.resolvedBy).toBe("admin-test");
    expect(item.resolutionNote).toBe("verified with owner");

    const audit = auditCalls.find(
      (c) => c.action === "abuse_risk_review_resolved",
    );
    expect(audit).toBeDefined();
    expect(audit.reason).toContain(reviewId);

    // Replaying the approval must not resolve anything again.
    const second = await fetch(`${base}/reviews/${reviewId}/resolve`, {
      method: "POST",
      headers: { ...ADMIN.headers, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(second.status).toBe(404);
  });

  it("releases exactly one held operation after approval", async () => {
    const reviewId = seedReview();
    await fetch(`${base}/reviews/${reviewId}/resolve`, {
      method: "POST",
      headers: { ...ADMIN.headers, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });

    // The same risky operation now passes and consumes the approval.
    const released = evaluateOperation(
      {
        operation: "payout_request",
        wallet: WALLET,
        target: "t",
        amount: 900,
        now: Date.now(),
      },
      "enforce",
    );
    expect(released.action).toBe("allow");
    expect(released.releasedByReview).toBe(true);
    expect(abuseReviewQueue.get(reviewId)?.status).toBe("consumed");

    // The approval is spent: a second identical operation is held again.
    const again = evaluateOperation(
      {
        operation: "payout_request",
        wallet: WALLET,
        target: "t",
        amount: 900,
        now: Date.now(),
      },
      "enforce",
    );
    expect(again.action).toBe("review");
  });

  it("records a rejection that cannot be re-resolved", async () => {
    const reviewId = seedReview();
    const res = await fetch(`${base}/reviews/${reviewId}/resolve`, {
      method: "POST",
      headers: { ...ADMIN.headers, "content-type": "application/json" },
      body: JSON.stringify({ decision: "rejected", note: "false positive" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { item: any }).item.status).toBe("rejected");

    const replay = await fetch(`${base}/reviews/${reviewId}/resolve`, {
      method: "POST",
      headers: { ...ADMIN.headers, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(replay.status).toBe(404);
  });
});

describe("POST /subjects/reset", () => {
  it("requires a wallet", async () => {
    const res = await fetch(`${base}/subjects/reset`, {
      method: "POST",
      headers: { ...ADMIN.headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("clears a false positive's counters and audits the reset", async () => {
    heat();
    expect(abuseActivityLedger.history(WALLET).firstSeenAt).toBeDefined();

    const res = await fetch(`${base}/subjects/reset`, {
      method: "POST",
      headers: { ...ADMIN.headers, "content-type": "application/json" },
      body: JSON.stringify({ wallet: WALLET }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reset: boolean }).reset).toBe(true);
    expect(abuseActivityLedger.history(WALLET).firstSeenAt).toBeUndefined();

    const audit = auditCalls.find(
      (c) => c.action === "abuse_risk_subject_reset",
    );
    expect(audit).toBeDefined();
    expect(audit.result).toBe("success");
  });

  it("is a no-op reset for an unknown wallet (idempotent recovery)", async () => {
    const res = await fetch(`${base}/subjects/reset`, {
      method: "POST",
      headers: { ...ADMIN.headers, "content-type": "application/json" },
      body: JSON.stringify({ wallet: "GUNKNOWNWALLET" }),
    });
    expect(res.status).toBe(200);
  });
});
