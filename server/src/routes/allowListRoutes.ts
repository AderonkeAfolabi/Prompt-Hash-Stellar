import { Router, type Response } from "express";
import { requireAdminScope, type AdminRequest } from "../middleware/adminAuth";
import {
  ALLOW_LIST_POLICIES,
  FILE_TYPE_ALLOW_LIST,
  checkFileType,
  checkUrlAgainstPolicy,
  describeAllowListPolicies,
  type AllowListPolicyName,
  type FileKind,
} from "../services/allowListPolicy";

/**
 * Operator view of the allow-list policies (#1025).
 *
 * GET  /api/admin/allow-list        — effective policies and enforcement mode
 * POST /api/admin/allow-list/check  — dry-run a URL or file descriptor against
 *                                     a policy without storing anything
 *
 * Both require `allowlist:read`; neither can change a policy (policies are
 * code + environment, so changes go through review and deploy).
 */
export const allowListRouter = Router();

allowListRouter.get("/", requireAdminScope("allowlist:read"), (_req: AdminRequest, res: Response) => {
  res.json(describeAllowListPolicies());
});

allowListRouter.post("/check", requireAdminScope("allowlist:read"), (req: AdminRequest, res: Response) => {
  const { policy, url, expectedKind, file } = req.body ?? {};

  if (file !== undefined) {
    const kind = file?.kind as FileKind;
    if (!(kind in FILE_TYPE_ALLOW_LIST)) {
      return res.status(400).json({ error: `file.kind must be one of: ${Object.keys(FILE_TYPE_ALLOW_LIST).join(", ")}` });
    }
    const bytes =
      typeof file.base64Prefix === "string" ? new Uint8Array(Buffer.from(file.base64Prefix, "base64")) : undefined;
    return res.json(
      checkFileType({
        kind,
        filename: typeof file.filename === "string" ? file.filename : undefined,
        contentType: typeof file.contentType === "string" ? file.contentType : undefined,
        bytes,
      }),
    );
  }

  if (!(policy in ALLOW_LIST_POLICIES)) {
    return res.status(400).json({ error: `policy must be one of: ${Object.keys(ALLOW_LIST_POLICIES).join(", ")}` });
  }
  if (expectedKind !== undefined && !(expectedKind in FILE_TYPE_ALLOW_LIST)) {
    return res.status(400).json({ error: "expectedKind is not a known file kind." });
  }
  // Always the pure check: the dry run reports what enforce mode would do,
  // regardless of the current ALLOWLIST_MODE.
  return res.json(
    checkUrlAgainstPolicy(url, policy as AllowListPolicyName, { expectedKind: expectedKind as FileKind | undefined }),
  );
});
