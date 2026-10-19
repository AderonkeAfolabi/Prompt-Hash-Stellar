/**
 * Bounded queue backpressure for expensive background work (#1009).
 *
 * Uses a real in-memory MongoDB so admission counts include pending AND
 * processing jobs, and exercises the HTTP edge: enqueue returns 429 with a
 * Retry-After header while reads/writes remain protected by admin scopes.
 */

vi.mock("../middleware/adminAuth", () => ({
  requireAdminScope: (scope: string) => (req: any, res: any, next: any) => {
    const header = String(req.headers["x-test-admin"] ?? "");
    const [sub, scopes = ""] = header.split("|");
    if (!scopes.split(",").includes(scope)) {
      res.status(401).json({ error: "Unauthorized: invalid or insufficient admin token." });
      return;
    }
    req.admin = { sub };
    next();
  },
}));

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QueueBackpressureError,
  assertQueueCapacity,
  claimNextJob,
  enqueueJob,
  getQueuePressure,
  markJobCompleted,
  maxPendingForType,
} from "../jobs/jobQueue";
import JobRecord from "../models/JobRecord";
import { jobRouter } from "../routes/jobRoutes";
import { jsonCall, startHttpServer, type HttpTestServer } from "./helpers/httpApp";
import { resetRealMongo, setupRealMongo, teardownRealMongo } from "./helpers/realMongo";

let mongoUp = false;
let http: HttpTestServer | null = null;
const WRITER = { "x-test-admin": "ops-alice|jobs:read,jobs:write" };
const READER = { "x-test-admin": "ops-bob|jobs:read" };

function exportPayload(label: string) {
  return {
    version: 1 as const,
    creatorWallet: `G${label.toUpperCase()}`,
    requestedBy: `G${label.toUpperCase()}`,
  };
}

beforeAll(async () => {
  mongoUp = await setupRealMongo();
  if (mongoUp) await JobRecord.init();
  http = await startHttpServer((app) => app.use("/api/jobs", jobRouter));
}, 60_000);

afterAll(async () => {
  await http?.close();
  await teardownRealMongo();
}, 30_000);

beforeEach(async () => {
  vi.restoreAllMocks();
  delete process.env.JOB_QUEUE_MAX_PENDING_EXPORT_CSV;
  if (mongoUp) await resetRealMongo();
});

afterEach(() => {
  delete process.env.JOB_QUEUE_MAX_PENDING_EXPORT_CSV;
});

describe("queue admission ceilings", () => {
  it("accepts work up to the ceiling and rejects the next job with a retryable error", async () => {
    if (!mongoUp) return;

    await enqueueJob("export_csv", exportPayload("one"), { maxPending: 2 });
    await enqueueJob("export_csv", exportPayload("two"), { maxPending: 2 });

    const error = await enqueueJob("export_csv", exportPayload("three"), { maxPending: 2 }).catch(
      (err) => err,
    );
    expect(error).toBeInstanceOf(QueueBackpressureError);
    expect(error).toMatchObject({
      code: "queue_backpressure",
      httpStatus: 429,
      type: "export_csv",
      limit: 2,
      pending: 2,
      processing: 0,
    });
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(1_000);
    expect(await JobRecord.countDocuments({ status: "pending" })).toBe(2);
  });

  it("counts processing jobs against the ceiling", async () => {
    if (!mongoUp) return;

    await enqueueJob("export_csv", exportPayload("one"), { maxPending: 2 });
    await enqueueJob("export_csv", exportPayload("two"), { maxPending: 2 });
    const claimed = await claimNextJob("worker-1");
    expect(claimed).not.toBeNull();

    const pressure = await getQueuePressure("export_csv", 2);
    expect(pressure).toMatchObject({ pending: 1, processing: 1, total: 2, saturated: true });
    await expect(
      enqueueJob("export_csv", exportPayload("three"), { maxPending: 2 }),
    ).rejects.toBeInstanceOf(QueueBackpressureError);
  });

  it("re-opens capacity when work completes", async () => {
    if (!mongoUp) return;

    const first = await enqueueJob("export_csv", exportPayload("one"), { maxPending: 1 });
    await expect(
      enqueueJob("export_csv", exportPayload("two"), { maxPending: 1 }),
    ).rejects.toBeInstanceOf(QueueBackpressureError);

    await markJobCompleted(first.id);
    await expect(
      enqueueJob("export_csv", exportPayload("two"), { maxPending: 1 }),
    ).resolves.toMatchObject({ type: "export_csv", status: "pending" });
  });

  it("hops the saturation check for a duplicate retry of an already queued job", async () => {
    if (!mongoUp) return;

    const first = await enqueueJob("export_csv", exportPayload("one"), {
      maxPending: 1,
      dedupeKey: "same-export",
    });

    // The queue is saturated, but a client retry with the same idempotency key
    // must receive the original job id instead of a 429.
    const retry = await enqueueJob("export_csv", exportPayload("one"), {
      maxPending: 1,
      dedupeKey: "same-export",
    });
    expect(retry.id).toBe(first.id);
    expect(await JobRecord.countDocuments()).toBe(1);
  });

  it("honours per-type environment overrides and validates option values", async () => {
    if (!mongoUp) return;

    process.env.JOB_QUEUE_MAX_PENDING_EXPORT_CSV = "1";
    expect(maxPendingForType("export_csv")).toBe(1);

    await enqueueJob("export_csv", exportPayload("one"));
    await expect(enqueueJob("export_csv", exportPayload("two"))).rejects.toBeInstanceOf(
      QueueBackpressureError,
    );

    // Invalid values fall back to the safe default, never to "unlimited".
    process.env.JOB_QUEUE_MAX_PENDING_EXPORT_CSV = "not-a-number";
    expect(maxPendingForType("export_csv")).toBe(25);

    await expect(assertQueueCapacity("export_csv", { maxPending: -1 })).rejects.toThrow(
      /maxPending/,
    );
  });

  it("allows a zero override to disable the ceiling for a controlled window", async () => {
    if (!mongoUp) return;
    process.env.JOB_QUEUE_MAX_PENDING_EXPORT_CSV = "0";
    expect(maxPendingForType("export_csv")).toBe(0);

    for (let i = 0; i < 4; i++) {
      await enqueueJob("export_csv", exportPayload(`job-${i}`));
    }
    const pressure = await getQueuePressure("export_csv", 0);
    expect(pressure.saturated).toBe(false);
    expect(pressure.total).toBe(4);
  });
});

describe("job route backpressure contract", () => {
  it("requires jobs:read for pressure and jobs:write for enqueue", async () => {
    if (!mongoUp || !http) return;

    expect((await jsonCall(http.baseUrl, "/api/jobs/pressure")).status).toBe(401);
    expect(
      (await jsonCall(http.baseUrl, "/api/jobs/pressure", { headers: READER })).status,
    ).toBe(200);

    const denied = await jsonCall(http.baseUrl, "/api/jobs/enqueue", {
      method: "POST",
      headers: READER,
      body: JSON.stringify({ type: "export_csv", payload: exportPayload("denied") }),
    });
    expect(denied.status).toBe(401);
    expect(await JobRecord.countDocuments()).toBe(0);
  });

  it("returns 429 + Retry-After at the ceiling and still reports depth", async () => {
    if (!mongoUp || !http) return;
    process.env.JOB_QUEUE_MAX_PENDING_EXPORT_CSV = "1";

    const first = await jsonCall(http.baseUrl, "/api/jobs/enqueue", {
      method: "POST",
      headers: WRITER,
      body: JSON.stringify({
        type: "export_csv",
        payload: exportPayload("one"),
        options: { maxPending: 1 },
      }),
    });
    expect(first.status).toBe(201);

    const rejected = await jsonCall(http.baseUrl, "/api/jobs/enqueue", {
      method: "POST",
      headers: WRITER,
      body: JSON.stringify({
        type: "export_csv",
        payload: exportPayload("two"),
        options: { maxPending: 1 },
      }),
    });
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBeTruthy();
    expect(rejected.body).toMatchObject({
      error: "queue_backpressure",
      type: "export_csv",
      limit: 1,
      pending: 1,
    });

    const pressure = await jsonCall(http.baseUrl, "/api/jobs/pressure", { headers: READER });
    const exportPressure = pressure.body.find((row: any) => row.type === "export_csv");
    expect(exportPressure).toMatchObject({ saturated: true, total: 1, limit: 1 });
  });

  it("rejects unknown job types before they reach the queue", async () => {
    if (!mongoUp || !http) return;
    const res = await jsonCall(http.baseUrl, "/api/jobs/enqueue", {
      method: "POST",
      headers: WRITER,
      body: JSON.stringify({ type: "definitely_not_a_job", payload: { version: 1 } }),
    });
    expect(res.status).toBe(400);
    expect(await JobRecord.countDocuments()).toBe(0);
  });
});
