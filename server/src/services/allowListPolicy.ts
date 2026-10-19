/**
 * Strict allow-list validation for URLs, file types, and destinations (#1025).
 *
 * Every user-supplied URL the server stores or later contacts is checked
 * against a named policy that lists what IS allowed (schemes, ports, hosts,
 * file types) instead of trying to enumerate what is dangerous:
 *
 *   webhook_destination — outbound webhook targets: https only, default/8443
 *                         port, public DNS names only (no IP literals, no
 *                         localhost / .local / .internal names), optional
 *                         operator host allow-list (WEBHOOK_ALLOWED_HOSTS).
 *   listing_image       — prompt cover images: http(s), no IP literals, and
 *                         when the path names a file it must be a raster image
 *                         type (SVG is refused: it can carry script).
 *   report_evidence     — moderation evidence links: http(s), no IP literals,
 *                         and the file type must match the declared kind.
 *
 * Delivery-time SSRF protection (DNS pinning, redirect re-validation) stays in
 * ssrfGuard.ts; this module rejects bad destinations at the door so they are
 * never persisted.
 *
 * `ALLOWLIST_MODE=report` turns enforcement into logging only — the rollback
 * lever if a policy turns out to reject legitimate traffic. See
 * docs/operations/allow-list-validation.md.
 */

import * as net from "net";
import { isDisallowedAddress } from "./ssrfGuard";
import { logger } from "./structuredLogger";

export type AllowListPolicyName = "webhook_destination" | "listing_image" | "report_evidence";
export type AllowListMode = "enforce" | "report";

export type AllowListViolationCode =
  | "url_invalid"
  | "url_too_long"
  | "scheme_not_allowed"
  | "credentials_not_allowed"
  | "port_not_allowed"
  | "ip_literal_not_allowed"
  | "host_not_allowed"
  | "file_type_not_allowed"
  | "file_type_mismatch";

export type FileKind = "image" | "pdf" | "json" | "csv" | "text";

export interface FileTypeRule {
  extensions: readonly string[];
  mimeTypes: readonly string[];
  /** Leading-byte signatures; any one match is enough. Empty = text format. */
  magic: readonly (readonly number[])[];
}

export const FILE_TYPE_ALLOW_LIST: Record<FileKind, FileTypeRule> = {
  image: {
    extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif"],
    mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"],
    magic: [
      [0x89, 0x50, 0x4e, 0x47], // PNG
      [0xff, 0xd8, 0xff], // JPEG
      [0x47, 0x49, 0x46, 0x38], // GIF8
      [0x52, 0x49, 0x46, 0x46], // RIFF (WebP container)
      [0x00, 0x00, 0x00], // ISO-BMFF box (AVIF) — size prefix, checked with ftyp below
    ],
  },
  pdf: { extensions: ["pdf"], mimeTypes: ["application/pdf"], magic: [[0x25, 0x50, 0x44, 0x46, 0x2d]] },
  json: { extensions: ["json"], mimeTypes: ["application/json"], magic: [] },
  csv: { extensions: ["csv"], mimeTypes: ["text/csv"], magic: [] },
  text: { extensions: ["txt", "md"], mimeTypes: ["text/plain", "text/markdown"], magic: [] },
};

interface UrlPolicy {
  schemes: readonly string[];
  /** Explicit ports allowed in addition to the scheme default. */
  ports: readonly number[];
  allowIpLiterals: false;
  /** File kinds a path extension may name; `null` = extension not checked. */
  fileKinds: readonly FileKind[] | null;
  /** Env var holding an optional comma-separated host allow-list. */
  hostAllowListEnv: string;
}

const MAX_URL_LENGTH = 2048;

export const ALLOW_LIST_POLICIES: Record<AllowListPolicyName, UrlPolicy> = {
  webhook_destination: {
    schemes: ["https:"],
    ports: [8443],
    allowIpLiterals: false,
    fileKinds: null,
    hostAllowListEnv: "WEBHOOK_ALLOWED_HOSTS",
  },
  listing_image: {
    schemes: ["https:", "http:"],
    ports: [],
    allowIpLiterals: false,
    fileKinds: ["image"],
    hostAllowListEnv: "IMAGE_ALLOWED_HOSTS",
  },
  report_evidence: {
    schemes: ["https:", "http:"],
    ports: [],
    allowIpLiterals: false,
    fileKinds: ["image", "pdf", "text"],
    hostAllowListEnv: "EVIDENCE_ALLOWED_HOSTS",
  },
};

/** Names that only ever resolve inside a private network. */
const INTERNAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

export interface AllowListDecision {
  allowed: boolean;
  /** True when a violation was found but `report` mode let it through. */
  reportOnly: boolean;
  code?: AllowListViolationCode;
  message?: string;
  normalizedUrl?: string;
}

export function getAllowListMode(): AllowListMode {
  return process.env.ALLOWLIST_MODE === "report" ? "report" : "enforce";
}

/** Parse an operator host allow-list: exact hosts or `*.example.com` wildcards. */
export function parseHostAllowList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function hostMatchesAllowList(hostname: string, allowList: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  // `*.example.com` matches subdomains only, never `example.com` itself.
  return allowList.some((entry) => (entry.startsWith("*.") ? host.endsWith(entry.slice(1)) : host === entry));
}

function extensionOf(pathname: string): string | null {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* malformed escape — inspect the raw path */
  }
  const last = decoded.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return dot > 0 && dot < last.length - 1 ? last.slice(dot + 1).toLowerCase() : null;
}

function kindForExtension(extension: string): FileKind | null {
  for (const [kind, rule] of Object.entries(FILE_TYPE_ALLOW_LIST) as [FileKind, FileTypeRule][]) {
    if (rule.extensions.includes(extension)) return kind;
  }
  return null;
}

function violation(code: AllowListViolationCode, message: string): AllowListDecision {
  return { allowed: false, reportOnly: false, code, message };
}

/** Pure policy check — no mode handling, no logging. */
export function checkUrlAgainstPolicy(
  rawUrl: unknown,
  policyName: AllowListPolicyName,
  options: { expectedKind?: FileKind; hostAllowList?: readonly string[]; skipFileType?: boolean } = {},
): AllowListDecision {
  const policy = ALLOW_LIST_POLICIES[policyName];
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return violation("url_invalid", "URL is required.");
  const trimmed = rawUrl.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    return violation("url_too_long", `URL must be ${MAX_URL_LENGTH} characters or fewer.`);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return violation("url_invalid", "Not a valid absolute URL.");
  }

  if (!policy.schemes.includes(url.protocol)) {
    return violation(
      "scheme_not_allowed",
      `Only ${policy.schemes.map((s) => s.replace(":", "")).join(", ")} URLs are allowed.`,
    );
  }
  if (url.username || url.password) {
    return violation("credentials_not_allowed", "URLs may not embed credentials.");
  }
  if (url.port && !policy.ports.includes(Number(url.port))) {
    return violation("port_not_allowed", `Port ${url.port} is not allowed.`);
  }

  // WHATWG URL keeps brackets around IPv6 hosts and normalizes numeric IPv4
  // forms (e.g. 2130706433, 0x7f.1) to dotted quads, so net.isIP catches all.
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(host)) {
    return violation(
      "ip_literal_not_allowed",
      isDisallowedAddress(host)
        ? "URLs may not point at private or internal addresses."
        : "URLs must use a DNS host name, not an IP address.",
    );
  }
  if (
    !host.includes(".") ||
    host === "localhost" ||
    INTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return violation("host_not_allowed", "URL host must be a public DNS name.");
  }

  const hostAllowList = options.hostAllowList ?? parseHostAllowList(process.env[policy.hostAllowListEnv]);
  if (hostAllowList.length > 0 && !hostMatchesAllowList(host, hostAllowList)) {
    return violation("host_not_allowed", "URL host is not on the allow-list.");
  }

  if (policy.fileKinds && !options.skipFileType) {
    const extension = extensionOf(url.pathname);
    if (extension) {
      const kind = kindForExtension(extension);
      if (!kind || !policy.fileKinds.includes(kind)) {
        return violation("file_type_not_allowed", `.${extension} files are not allowed here.`);
      }
      if (options.expectedKind && kind !== options.expectedKind) {
        return violation("file_type_mismatch", `.${extension} is not a ${options.expectedKind} file.`);
      }
    }
  }

  return { allowed: true, reportOnly: false, normalizedUrl: url.toString() };
}

/**
 * Policy check plus enforcement mode. In `report` mode a violation is logged
 * and the request is let through (`reportOnly: true`), so operators can see
 * what a policy change would reject before enforcing it.
 */
export function enforceUrlAllowList(
  rawUrl: unknown,
  policyName: AllowListPolicyName,
  options: { expectedKind?: FileKind; skipFileType?: boolean; context?: string } = {},
): AllowListDecision {
  const decision = checkUrlAgainstPolicy(rawUrl, policyName, options);
  if (decision.allowed) return decision;

  const mode = getAllowListMode();
  logger.warn("allow-list violation", {
    action: "allow_list_check",
    policy: policyName,
    code: decision.code,
    mode,
    context: options.context,
  });
  return mode === "report" ? { ...decision, allowed: true, reportOnly: true } : decision;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.length <= bytes.length && signature.every((b, i) => bytes[i] === b);
}

/**
 * Identify a binary file kind from its leading bytes. Returns `null` for
 * anything not on the allow-list (including SVG, HTML and executables).
 */
export function sniffFileKind(bytes: Uint8Array): FileKind | null {
  for (const [kind, rule] of Object.entries(FILE_TYPE_ALLOW_LIST) as [FileKind, FileTypeRule][]) {
    for (const signature of rule.magic) {
      if (!startsWith(bytes, signature)) continue;
      if (kind === "image" && signature[0] === 0x52) {
        // RIFF is only an image when the container type is WEBP.
        if (String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP") continue;
      }
      if (kind === "image" && signature[0] === 0x00) {
        if (String.fromCharCode(...bytes.slice(4, 12)) !== "ftypavif") continue;
      }
      return kind;
    }
  }
  return null;
}

/**
 * Validate an uploaded/fetched file against the allow-list for `kind`: the
 * extension, the declared MIME type and (for binary kinds) the magic bytes
 * must all agree, so a renamed `.svg` or an HTML page served as `image/png`
 * is rejected.
 */
export function checkFileType(input: {
  kind: FileKind;
  filename?: string;
  contentType?: string;
  bytes?: Uint8Array;
}): AllowListDecision {
  const rule = FILE_TYPE_ALLOW_LIST[input.kind];

  if (input.filename !== undefined) {
    const extension = extensionOf(input.filename);
    if (!extension || !rule.extensions.includes(extension)) {
      return violation("file_type_not_allowed", `File extension must be one of: ${rule.extensions.join(", ")}.`);
    }
  }
  if (input.contentType !== undefined) {
    const mime = input.contentType.split(";")[0].trim().toLowerCase();
    if (!rule.mimeTypes.includes(mime)) {
      return violation("file_type_not_allowed", `Content type ${mime || "(none)"} is not allowed.`);
    }
  }
  if (input.bytes && rule.magic.length > 0 && sniffFileKind(input.bytes) !== input.kind) {
    return violation("file_type_mismatch", `File contents are not a valid ${input.kind} file.`);
  }
  return { allowed: true, reportOnly: false };
}

/** Effective policy view for operators (no secrets involved). */
export function describeAllowListPolicies() {
  return {
    mode: getAllowListMode(),
    urlPolicies: Object.fromEntries(
      (Object.entries(ALLOW_LIST_POLICIES) as [AllowListPolicyName, UrlPolicy][]).map(([name, policy]) => [
        name,
        {
          schemes: policy.schemes.map((s) => s.replace(":", "")),
          extraPorts: policy.ports,
          ipLiterals: "denied",
          internalHostSuffixes: INTERNAL_HOST_SUFFIXES,
          fileKinds: policy.fileKinds,
          hostAllowList: parseHostAllowList(process.env[policy.hostAllowListEnv]),
          hostAllowListEnv: policy.hostAllowListEnv,
        },
      ]),
    ),
    fileTypes: Object.fromEntries(
      (Object.entries(FILE_TYPE_ALLOW_LIST) as [FileKind, FileTypeRule][]).map(([kind, rule]) => [
        kind,
        { extensions: rule.extensions, mimeTypes: rule.mimeTypes, magicChecked: rule.magic.length > 0 },
      ]),
    ),
  };
}

const EVIDENCE_KIND_TO_FILE_KIND: Record<string, FileKind | null> = {
  image: "image",
  pdf: "pdf",
  text: "text",
  // A plain web page; its path may legitimately end in .html, .php, etc.
  link: null,
};

/** Allow-list check for one moderation evidence item of a declared kind. */
export function enforceEvidenceUrl(url: unknown, kind: string): AllowListDecision {
  const expectedKind = EVIDENCE_KIND_TO_FILE_KIND[kind];
  return enforceUrlAllowList(url, "report_evidence", {
    expectedKind: expectedKind ?? undefined,
    skipFileType: expectedKind === null,
    context: `report_evidence:${kind}`,
  });
}
