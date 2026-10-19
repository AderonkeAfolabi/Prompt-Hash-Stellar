import { Router } from "express";
import { requireAdminScope, type AdminRequest } from "../middleware/adminAuth";
import connectDb from "../db/connectDb";
import {
  createTransfer,
  getTransfer,
  cancelTransfer,
  TransferError,
} from "../services/transferExecution";

export const transferRouter = Router();
transferRouter.use(requireAdminScope("transfers:write"));
transferRouter.post("/", async (req: AdminRequest, res) => {
  if (!["import", "export"].includes(req.body?.kind))
    return res.status(400).json({ error: "kind must be import or export" });
  await connectDb();
  const run = await createTransfer(req.admin!.sub, req.body.kind);
  return res.status(201).json({ transferId: run._id, status: run.status });
});
for (const action of ["status", "cancel"] as const) {
  const handler: import("express").RequestHandler = async (
    req: AdminRequest,
    res,
  ) => {
    try {
      await connectDb();
      const run = await (action === "cancel" ? cancelTransfer : getTransfer)(
        String(req.params.id),
        req.admin!.sub,
      );
      res.json({
        transferId: run._id,
        kind: run.kind,
        status: run.status,
        cancelRequested: run.cancelRequested,
        steps: run.steps,
      });
    } catch (err) {
      if (err instanceof TransferError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  };
  if (action === "cancel") transferRouter.post("/:id/cancel", handler);
  else transferRouter.get("/:id", handler);
}
