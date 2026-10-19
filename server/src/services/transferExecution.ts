import { createHash, randomUUID } from "node:crypto";
import TransferRun from "../models/TransferRun";

export class TransferError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export class TransferCancelledError extends TransferError {
  constructor() {
    super("Transfer cancelled", 409);
  }
}
export async function createTransfer(owner: string, kind: "import" | "export") {
  if (!owner) throw new TransferError("Authenticated owner required", 403);
  return TransferRun.create({ owner, kind });
}
export async function getTransfer(id: string, owner: string) {
  if (!/^[a-f\d]{24}$/i.test(id))
    throw new TransferError("Invalid transfer id", 400);
  const run = await TransferRun.findOne({ _id: id, owner });
  if (!run) throw new TransferError("Transfer not found", 404);
  return run;
}
export async function cancelTransfer(id: string, owner: string) {
  await getTransfer(id, owner);
  // Completion and cancellation are serialized by the same document CAS.
  await TransferRun.updateOne(
    { _id: id, owner, status: { $in: ["pending", "running", "failed"] } },
    { $set: { cancelRequested: true } },
  );
  await TransferRun.updateOne(
    {
      _id: id,
      owner,
      status: { $in: ["pending", "failed"] },
      cancelRequested: true,
    },
    { $set: { status: "cancelled", finishedAt: new Date() } },
  );
  return getTransfer(id, owner);
}

export interface TransferExecution {
  id: string;
  check(): Promise<void>;
  step<T>(
    name: string,
    reference: string,
    effect: () => Promise<T>,
    options?: { settlement: boolean },
  ): Promise<T>;
  finish(status: "completed" | "failed" | "cancelled"): Promise<void>;
}

/** No expired-lease takeover: an ambiguous running operation requires operator
 * reconciliation after draining workers. Failed attempts can safely retry only
 * with identical input; each effect must itself use a deterministic reference. */
export async function beginTransfer(
  owner: string,
  kind: "import" | "export",
  input: unknown,
  id?: string,
  signal?: AbortSignal,
): Promise<TransferExecution> {
  const run = id
    ? await getTransfer(id, owner)
    : await createTransfer(owner, kind);
  const inputHash = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  if (run.kind !== kind || (run.inputHash && run.inputHash !== inputHash)) {
    throw new TransferError(
      "Transfer kind or input changed; create a new transfer",
    );
  }
  if (run.cancelRequested || run.status === "cancelled")
    throw new TransferCancelledError();
  const token = randomUUID();
  const claimed = await TransferRun.findOneAndUpdate(
    {
      _id: run._id,
      owner,
      status: { $in: ["pending", "failed"] },
      cancelRequested: false,
      $or: [{ inputHash: null }, { inputHash }],
    },
    {
      $set: { status: "running", token, inputHash },
      $unset: { finishedAt: "" },
    },
    { new: true },
  );
  if (!claimed)
    throw new TransferError("Transfer is already running or terminal");
  const filter = { _id: run._id, owner, token, status: "running" };
  const execution: TransferExecution = {
    id: String(run._id),
    async check() {
      const current = await TransferRun.findOne(filter);
      if (!current)
        throw new TransferError("Transfer execution no longer owns the run");
      if (signal?.aborted || current.cancelRequested)
        throw new TransferCancelledError();
    },
    async step(name, reference, effect, options) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(name))
        throw new Error("Invalid checkpoint name");
      if (options?.settlement) {
        if (!(await TransferRun.findOne(filter)))
          throw new TransferError("Checkpoint ownership lost");
      } else await execution.check();
      const prepared = await TransferRun.updateOne(
        {
          ...filter,
          ...(options?.settlement ? {} : { cancelRequested: false }),
        },
        { $set: { [`steps.${name}`]: { state: "prepared", reference } } },
      );
      if (!prepared.matchedCount) throw new TransferCancelledError();
      // Always re-run an idempotent effect on retry: a crash may have occurred
      // after the effect committed but before the following checkpoint.
      const result = await effect();
      const recorded = await TransferRun.updateOne(filter, {
        $set: { [`steps.${name}`]: { state: "committed", reference } },
      });
      if (!recorded.matchedCount)
        throw new TransferError("Checkpoint ownership lost");
      return result;
    },
    async finish(status) {
      const result = await TransferRun.updateOne(
        {
          ...filter,
          ...(status === "completed" ? { cancelRequested: false } : {}),
        },
        {
          $set: {
            status,
            ...(status === "failed" ? {} : { finishedAt: new Date() }),
          },
          $unset: { token: "" },
        },
      );
      if (!result.matchedCount && status === "completed")
        throw new TransferCancelledError();
    },
  };
  return execution;
}

/** Bind cancellation to a closed response, not IncomingMessage.close (which
 * also fires on a normally consumed request body). */
export function responseAbortSignal(
  res: import("express").Response,
): AbortSignal {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.once("close", onClose);
  res.once("finish", () => res.removeListener("close", onClose));
  return controller.signal;
}
