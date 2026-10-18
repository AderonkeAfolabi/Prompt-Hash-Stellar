import express, { Request, Response } from "express";
import connectDb from "../db/connectDb";
import { requireAdminScope } from "../middleware/adminAuth";
import { requireIdempotency } from "../middleware/idempotency";
import {
  recordLedgerEntry,
  getCreatorPayoutSummaryView,
  getAdminPayoutSummaryView,
  exportLedgerReportBounded,
} from "../services/payoutLedgerService";
import { buildCsv, contentDispositionValue } from "../services/sensitiveContent";

export const payoutLedgerRouter = express.Router();

/**
 * GET /api/payouts/creator/:walletAddress/ledger
 * Creator view: ledger balances recalculated from immutable entries + Stellar reconciliation status.
 */
payoutLedgerRouter.get(
  "/creator/:walletAddress/ledger",
  async (req: Request, res: Response) => {
    try {
      await connectDb();
      const walletAddress = String(req.params.walletAddress);
      if (!walletAddress) {
        return res.status(400).json({ error: "walletAddress is required" });
      }

      const data = await getCreatorPayoutSummaryView(walletAddress);
      return res.json({
        success: true,
        data,
      });
    } catch (err: any) {
      console.error("Error fetching creator payout ledger:", err);
      return res.status(500).json({ error: err.message || "Failed to fetch creator payout ledger" });
    }
  },
);

/**
 * GET /api/payouts/admin/summary
 * Admin view: overview of creator balances, mismatches with remediation notes.
 */
payoutLedgerRouter.get(
  "/admin/summary",
  requireAdminScope("payouts:read"),
  async (req: Request, res: Response) => {
    try {
      await connectDb();
      const data = await getAdminPayoutSummaryView();
      return res.json({
        success: true,
        data,
      });
    } catch (err: any) {
      console.error("Error fetching admin payout summary:", err);
      return res.status(500).json({ error: err.message || "Failed to fetch admin payout summary" });
    }
  },
);

/**
 * GET /api/payouts/admin/export
 * Admin view: export-ready dataset for accounting review.
 */
payoutLedgerRouter.get(
  "/admin/export",
  requireAdminScope("payouts:read"),
  async (req: Request, res: Response) => {
    try {
      await connectDb();
      const creatorAddress = req.query.creatorAddress as string | undefined;
      const format = (req.query.format as string) || "json";
      const { rows, truncated, scanLimit } = await exportLedgerReportBounded(creatorAddress);

      // Truncation must be visible to accounting, never silent (#983).
      if (truncated) {
        console.warn("Ledger export hit the scan ceiling", {
          action: "ledgerExportTruncated",
          scanLimit,
          creatorAddress: creatorAddress ?? "all",
        });
      }

      if (format === "csv") {
        const headers = ["entryId", "createdAt", "creatorAddress", "entryType", "promptId", "amount", "currency", "stellarTxRef", "referenceId", "description"];
        // CSV cells are escaped (RFC4180 + formula injection) because
        // referenceId/description carry operator-supplied content.
        const csv = buildCsv(
          headers,
          rows.map((r) => [
            r.entryId,
            r.createdAt,
            r.creatorAddress,
            r.entryType,
            r.promptId,
            r.amount,
            r.currency,
            r.stellarTxRef,
            r.referenceId,
            r.description,
          ]),
        );
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          contentDispositionValue(`ledger_export_${Date.now()}.csv`, "ledger_export.csv"),
        );
        // Header carries truncation so an operator piping the CSV can tell.
        res.setHeader("X-Ledger-Export-Truncated", truncated ? "true" : "false");
        res.setHeader("X-Ledger-Export-Scan-Limit", String(scanLimit));
        return res.send(csv);
      }

      return res.json({
        success: true,
        total: rows.length,
        truncated,
        scanLimit,
        rows,
      });
    } catch (err: any) {
      console.error("Error exporting ledger data:", err);
      return res.status(500).json({ error: err.message || "Failed to export ledger data" });
    }
  },
);

/**
 * POST /api/payouts/entry
 * Create an append-only ledger entry.
 */
payoutLedgerRouter.post(
  "/entry",
  requireAdminScope("payouts:write"),
  requireIdempotency,
  async (req: Request, res: Response) => {
    try {
      await connectDb();
      const { entryType, creatorAddress, promptId, amount, currency, stellarTxRef, referenceId, description, metadata } = req.body;

      if (!entryType || !creatorAddress || amount === undefined || !referenceId || !description) {
        return res.status(400).json({ error: "entryType, creatorAddress, amount, referenceId, and description are required" });
      }

      const entry = await recordLedgerEntry({
        entryType,
        creatorAddress,
        promptId,
        amount: Number(amount),
        currency,
        stellarTxRef,
        referenceId,
        description,
        metadata,
      });

      return res.json({
        success: true,
        entry,
      });
    } catch (err: any) {
      console.error("Error recording ledger entry:", err);
      return res.status(500).json({ error: err.message || "Failed to record ledger entry" });
    }
  },
);
