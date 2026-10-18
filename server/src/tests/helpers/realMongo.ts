import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

/**
 * Shared in-memory MongoDB lifecycle for concurrency tests (#1041).
 *
 * Extracted from the `jobQueue.test.ts` pattern so duplicate-submission and
 * stale-version suites spin up a REAL mongod (not a mock) and can assert
 * database-level guarantees — unique-index atomicity, the idempotency insert
 * gate, and the optimistic-version compare-and-swap — which are exactly the
 * properties a mocked model cannot prove.
 *
 * `setupRealMongo` never throws: when the mongod binary is unavailable it
 * returns `false` and the suite skips its DB-dependent tests, mirroring the
 * graceful-skip convention the repo already uses.
 */

let mongod: MongoMemoryServer | null = null;

/** Start an in-memory MongoDB and connect the default mongoose connection. */
export async function setupRealMongo(): Promise<boolean> {
  if (mongoose.connection.readyState === 1) return true;
  try {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    return true;
  } catch (err) {
    console.warn(
      "[tests/helpers/realMongo] MongoMemoryServer unavailable, DB tests will be skipped:",
      err,
    );
    return false;
  }
}

/** Disconnect and stop the in-memory MongoDB (idempotent, never throws). */
export async function teardownRealMongo(): Promise<void> {
  try {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  } catch {
    /* ignore — teardown must not mask a test failure */
  }
  try {
    if (mongod) await mongod.stop();
  } catch {
    /* ignore */
  }
  mongod = null;
}

/** Delete every document in every collection for inter-test isolation. */
export async function resetRealMongo(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const collections = await db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}
