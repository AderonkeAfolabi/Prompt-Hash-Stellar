import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import Notification from "../models/Notification";
import WebhookSubscription from "../models/WebhookSubscription";
import WebhookOutboxEvent from "../models/WebhookOutboxEvent";
import { NotificationService } from "../services/notificationService";
import { deliverNotification } from "../services/notificationRouting";
import { defaultEffectivePreferences } from "../services/notificationPreferences";
import { enqueue, replayDeadLetter } from "../services/webhookOutbox";
import { deliverRow } from "../services/webhookOutboxWorker";
import { postSignedWebhook } from "../services/ssrfGuard";

vi.mock("../services/auditTrail", () => ({ recordAuditEvent: vi.fn() }));
vi.mock("../services/ssrfGuard", () => ({
  postSignedWebhook: vi.fn(),
  UnsafeWebhookUrlError: class extends Error {},
}));
let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([
    Notification.init(),
    WebhookSubscription.init(),
    WebhookOutboxEvent.init(),
  ]);
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(postSignedWebhook).mockReset();
  await Promise.all([
    Notification.deleteMany({}),
    WebhookSubscription.deleteMany({}),
    WebhookOutboxEvent.deleteMany({}),
  ]);
});
describe("concurrent notification and webhook suppression", () => {
  it("collapses concurrent legacy notifications per recipient/type/event and propagates real failures", async () => {
    const input = {
      recipientWallet: " Alice ",
      type: "security_alert" as const,
      message: "Alert",
      idempotencyKey: "event-1",
    };
    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        NotificationService.createNotification(input),
      ),
    );
    expect(new Set(results.map((r) => String(r._id))).size).toBe(1);
    await NotificationService.createNotification({
      ...input,
      recipientWallet: "bob",
    });
    await NotificationService.createNotification({
      ...input,
      type: "account_lifecycle",
    });
    expect(await Notification.countDocuments()).toBe(3);
    vi.spyOn(Notification, "create").mockRejectedValueOnce(
      new Error("DB unavailable"),
    );
    await expect(NotificationService.createNotification(input)).rejects.toThrow(
      "DB unavailable",
    );
    expect((await NotificationService.createNotification(input))._id).toEqual(
      results[0]._id,
    );
  });
  it("scopes routed notification keys to each recipient and type", async () => {
    const input = {
      recipientWallet: "alice",
      type: "security_alert" as const,
      message: "Alert",
      dedupeKey: "event",
      preferences: defaultEffectivePreferences(),
    };
    const receipts = await Promise.all(
      Array.from({ length: 10 }, () => deliverNotification(input)),
    );
    expect(receipts.filter((r) => r.delivered)).toHaveLength(1);
    await deliverNotification({ ...input, recipientWallet: "bob" });
    expect(await Notification.countDocuments()).toBe(2);
  });
  it("never reuses webhook sequences under duplicate races and retains subscriber isolation", async () => {
    const sub = await WebhookSubscription.create({
      walletAddress: "alice",
      url: "https://example.com",
      secret: "key",
    });
    await Promise.all(
      Array.from({ length: 15 }, () =>
        enqueue("alice", "PromptPurchased", { promptId: "1" }, "event-1"),
      ),
    );
    await Promise.all([
      enqueue("alice", "PromptPurchased", {}, "event-2"),
      enqueue("alice", "PromptPurchased", {}, "event-3"),
    ]);
    const rows = await WebhookOutboxEvent.find({
      subscriptionId: sub._id,
    }).lean();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.sequence)).size).toBe(3);
    const other = await WebhookSubscription.create({
      walletAddress: "bob",
      url: "https://example.com",
      secret: "key",
    });
    await enqueue("bob", "PromptPurchased", {}, "event-1");
    expect(
      await WebhookOutboxEvent.countDocuments({ subscriptionId: other._id }),
    ).toBe(1);
  });
  it("checkpoints before HTTP, keeps retry identity, and never resends an acknowledged delivery after local failure", async () => {
    await WebhookSubscription.create({
      walletAddress: "alice",
      url: "https://example.com",
      secret: "key",
    });
    await enqueue("alice", "PromptPurchased", {}, "event");
    const row = await WebhookOutboxEvent.findOne();
    vi.mocked(postSignedWebhook).mockImplementationOnce(async () => {
      const prepared = await WebhookOutboxEvent.findById(row._id);
      expect(prepared.deliveryCheckpoint).toBe("prepared");
      expect(prepared.attempts).toBe(1);
      return { status: 503, headers: {}, body: "down" };
    });
    await deliverRow(row);
    const retry = await WebhookOutboxEvent.findById(row._id);
    expect(retry.deliveryId).toBe(row.deliveryId);
    vi.mocked(postSignedWebhook).mockResolvedValue({
      status: 200,
      headers: {},
      body: "ok",
    });
    const update =
      WebhookOutboxEvent.findByIdAndUpdate.bind(WebhookOutboxEvent);
    vi.spyOn(WebhookOutboxEvent, "findByIdAndUpdate").mockImplementation(
      (id: any, mutation: any, ...rest: any[]) => {
        if (mutation.$set?.status === "delivered")
          throw new Error("local completion failed");
        return update(id, mutation, ...rest);
      },
    );
    await deliverRow(retry);
    const acknowledged = await WebhookOutboxEvent.findById(row._id);
    expect(acknowledged.deliveryCheckpoint).toBe("acknowledged");
    vi.restoreAllMocks();
    const calls = vi.mocked(postSignedWebhook).mock.calls.length;
    await deliverRow(acknowledged);
    expect(vi.mocked(postSignedWebhook).mock.calls.length).toBe(calls);
    expect((await WebhookOutboxEvent.findById(row._id)).status).toBe(
      "delivered",
    );
    expect(await replayDeadLetter(String(row._id))).toBe(false);
  });
});
