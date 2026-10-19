/**
 * Prompt v3 migration compatibility gate (#1010).
 *
 * Usage:
 *   ts-node scripts/checkSchemaCompatibility.ts --input snapshot.json
 *   ts-node scripts/checkSchemaCompatibility.ts --mongo [--collection prompts] [--limit 10000]
 *
 * Options:
 *   --input <file>   JSON array, or {"records": [...]}, exported from a backup.
 *   --mongo          Read documents directly from MONGODB_URI (read-only).
 *   --collection <n> Collection to scan with --mongo (default: prompts).
 *   --limit <n>      Maximum documents to scan from Mongo (default: 10000).
 *   --to-version <n> Target schema version (default: the next version this build knows).
 *   --json           Print the full machine-readable report.
 *   --allow-warnings Exit 0 even when warnings are present (default: warnings do not fail).
 *
 * Exit codes:
 *   0  Every record can be migrated without information loss.
 *   1  At least one record is blocked, or the input could not be read.
 *   2  Bad command-line arguments.
 *
 * The command never writes to MongoDB. Run it against a backup/restore point
 * before a migration, and again against the post-migration snapshot.
 * See docs/operations/schema-migration-compatibility.md.
 */

import "dotenv/config";
import fs from "fs";
import mongoose from "mongoose";
import {
  checkPromptMigrationCompatibility,
  type PromptMigrationCompatibilityReport,
} from "../src/services/schemaMigrationCompatibility";

interface CliOptions {
  input?: string;
  mongo: boolean;
  collection: string;
  limit: number;
  toVersion?: number;
  json: boolean;
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  ts-node scripts/checkSchemaCompatibility.ts --input <snapshot.json> [--json]",
      "  ts-node scripts/checkSchemaCompatibility.ts --mongo [--collection prompts] [--limit 10000]",
      "",
      "See docs/operations/schema-migration-compatibility.md.",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mongo: false,
    collection: "prompts",
    limit: 10_000,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--input":
        options.input = argv[++i];
        if (!options.input) usage();
        break;
      case "--mongo":
        options.mongo = true;
        break;
      case "--collection":
        options.collection = argv[++i];
        if (!options.collection) usage();
        break;
      case "--limit": {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 1) usage();
        options.limit = value;
        break;
      }
      case "--to-version": {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 1) usage();
        options.toVersion = value;
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "--allow-warnings":
        // Warnings never fail the gate; accepted for runbook compatibility.
        break;
      case "--help":
      case "-h":
        usage();
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        usage();
    }
  }

  if (!options.input && !options.mongo) {
    console.error("Choose exactly one input source: --input <file> or --mongo.");
    usage();
  }
  if (options.input && options.mongo) {
    console.error("--input and --mongo are mutually exclusive.");
    usage();
  }
  return options;
}

function recordsFromJson(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const object = raw as Record<string, unknown>;
    for (const key of ["records", "prompts", "documents", "data"]) {
      if (Array.isArray(object[key])) return object[key] as unknown[];
    }
    // A single exported document is still a valid one-record snapshot.
    return [raw];
  }
  throw new Error("Input JSON must be an array or an object containing a records array.");
}

async function loadRecords(options: CliOptions): Promise<unknown[]> {
  if (options.input) {
    const text = fs.readFileSync(options.input, "utf8");
    return recordsFromJson(JSON.parse(text));
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not configured.");
  await mongoose.connect(uri, { readPreference: "secondaryPreferred" });
  try {
    const collection = mongoose.connection.collection(options.collection);
    return await collection
      .find({}, { projection: { content: 0, encryptedPrompt: 0, wrappedKey: 0 } })
      .limit(options.limit)
      .toArray();
  } finally {
    await mongoose.disconnect();
  }
}

function printHuman(report: PromptMigrationCompatibilityReport): void {
  console.log(
    `[schema-compat] Prompt v${report.fromVersion} → v${report.toVersion}: ` +
      `${report.checked} checked, ${report.blockedRecords} blocked, ` +
      `${report.errorCount} error(s), ${report.warningCount} warning(s)`,
  );
  console.log(`[schema-compat] fingerprint: ${report.fingerprint}`);

  for (const entry of report.issues) {
    const field = entry.field ? ` field=${entry.field}` : "";
    console.log(
      `[schema-compat] ${entry.severity.toUpperCase()} ${entry.code} ` +
        `record=${entry.recordId}${field}: ${entry.message}`,
    );
    console.log(`[schema-compat]   remediation: ${entry.remediation}`);
  }

  if (report.compatible) {
    console.log("[schema-compat] compatible=true — the snapshot can be migrated.");
    console.log("[schema-compat] Migration plan:");
    for (const step of report.migrationPlan) console.log(`  ${step}`);
  } else {
    console.log("[schema-compat] compatible=false — migration is blocked.");
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const records = await loadRecords(options);
  const report = checkPromptMigrationCompatibility(records, {
    toVersion: options.toVersion,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  process.exitCode = report.compatible ? 0 : 1;
}

main().catch((err) => {
  console.error(
    "[schema-compat] Failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
