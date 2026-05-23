import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { closePool, queryRows } from "../db/client.js";
import { listMigrationFiles, resolveMigrationsDir, runMigrations } from "../db/migrations.js";
import { readConfig } from "../config.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface MigrationCertificationReport {
  readonly generatedAt: string;
  readonly benchmark: "migration_certification_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly passed: boolean;
  readonly metrics: {
    readonly migrationFileCount: number;
    readonly duplicateMigrationNameCount: number;
    readonly freshDbMigrationPass: boolean;
    readonly freshDbAppliedCount: number;
    readonly existingDbMigrationPass: boolean;
    readonly existingDbAppliedCount: number;
    readonly currentSchemaMigrationCount: number;
    readonly missingCurrentSchemaMigrations: readonly string[];
    readonly queryTimeModelCalls: 0;
  };
  readonly freshDbName: string;
  readonly failures: readonly string[];
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

function databaseUrlWithDatabase(connectionString: string, database: string): string {
  if (/^postgres(?:ql)?:\/\/\//u.test(connectionString) && !/^postgres(?:ql)?:\/\/[^/]/u.test(connectionString)) {
    return `postgresql:///${database}`;
  }
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function randomDbName(stamp: string): string {
  return `ai_brain_migration_cert_${stamp.toLowerCase().replace(/[^a-z0-9]+/gu, "_").slice(0, 40)}`;
}

async function applyMigrationsToClient(client: Client): Promise<number> {
  const migrationFiles = await listMigrationFiles();
  const migrationsDir = await resolveMigrationsDir();
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  let applied = 0;
  for (const migrationFile of migrationFiles) {
    const sql = await readFile(path.join(migrationsDir, migrationFile), "utf8");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migrationFile]);
    applied += 1;
  }
  return applied;
}

async function certifyFreshDb(databaseName: string): Promise<{ readonly passed: boolean; readonly appliedCount: number; readonly failures: readonly string[] }> {
  const config = readConfig();
  const maintenance = new Client({ connectionString: databaseUrlWithDatabase(config.databaseUrl, "postgres") });
  const failures: string[] = [];
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE ${databaseName}`);
  } catch (error) {
    failures.push(`fresh_db_create_failed:${error instanceof Error ? error.message : String(error)}`);
    await maintenance.end().catch(() => undefined);
    return { passed: false, appliedCount: 0, failures };
  }

  let appliedCount = 0;
  const fresh = new Client({ connectionString: databaseUrlWithDatabase(config.databaseUrl, databaseName) });
  try {
    await fresh.connect();
    appliedCount = await applyMigrationsToClient(fresh);
  } catch (error) {
    failures.push(`fresh_db_migration_failed:${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await fresh.end().catch(() => undefined);
    await maintenance.query(
      `
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()
      `,
      [databaseName]
    ).catch(() => undefined);
    await maintenance.query(`DROP DATABASE IF EXISTS ${databaseName}`).catch((error) => {
      failures.push(`fresh_db_drop_failed:${error instanceof Error ? error.message : String(error)}`);
    });
    await maintenance.end().catch(() => undefined);
  }
  return { passed: failures.length === 0, appliedCount, failures };
}

function duplicateCount(values: readonly string[]): number {
  return values.length - new Set(values).size;
}

function toMarkdown(report: MigrationCertificationReport): string {
  return [
    "# Migration Certification Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- migrationFileCount: ${report.metrics.migrationFileCount}`,
    `- freshDbMigrationPass: ${report.metrics.freshDbMigrationPass}`,
    `- freshDbAppliedCount: ${report.metrics.freshDbAppliedCount}`,
    `- existingDbMigrationPass: ${report.metrics.existingDbMigrationPass}`,
    `- existingDbAppliedCount: ${report.metrics.existingDbAppliedCount}`,
    `- currentSchemaMigrationCount: ${report.metrics.currentSchemaMigrationCount}`,
    `- missingCurrentSchemaMigrations: ${report.metrics.missingCurrentSchemaMigrations.join(", ") || "-"}`,
    "",
    "## Failures",
    "",
    ...report.failures.map((failure) => `- ${failure}`),
    ""
  ].join("\n");
}

export async function runAndWriteMigrationCertificationPack(): Promise<{
  readonly report: MigrationCertificationReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const migrationFiles = await listMigrationFiles();
  const freshDbName = randomDbName(stamp);
  const failures: string[] = [];
  const fresh = await certifyFreshDb(freshDbName);
  failures.push(...fresh.failures);
  let existingAppliedCount = 0;
  try {
    existingAppliedCount = (await runMigrations()).length;
  } catch (error) {
    failures.push(`existing_db_migration_failed:${error instanceof Error ? error.message : String(error)}`);
  }
  const schemaRows = await queryRows<{ readonly name: string }>("SELECT name FROM schema_migrations ORDER BY name").catch((error) => {
    failures.push(`schema_migrations_read_failed:${error instanceof Error ? error.message : String(error)}`);
    return [];
  });
  const appliedNames = new Set(schemaRows.map((row) => row.name));
  const missingCurrentSchemaMigrations = migrationFiles.filter((file) => !appliedNames.has(file));
  const metrics = {
    migrationFileCount: migrationFiles.length,
    duplicateMigrationNameCount: duplicateCount(migrationFiles),
    freshDbMigrationPass: fresh.passed && fresh.appliedCount === migrationFiles.length,
    freshDbAppliedCount: fresh.appliedCount,
    existingDbMigrationPass: missingCurrentSchemaMigrations.length === 0,
    existingDbAppliedCount: existingAppliedCount,
    currentSchemaMigrationCount: schemaRows.length,
    missingCurrentSchemaMigrations,
    queryTimeModelCalls: 0 as const
  };
  const report: MigrationCertificationReport = {
    generatedAt,
    benchmark: "migration_certification_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: {
        migrationFileCount: migrationFiles.length,
        freshDbName
      }
    }),
    passed:
      metrics.duplicateMigrationNameCount === 0 &&
      metrics.freshDbMigrationPass &&
      metrics.existingDbMigrationPass &&
      metrics.queryTimeModelCalls === 0 &&
      failures.length === 0,
    metrics,
    freshDbName,
    failures
  };
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `migration-certification-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `migration-certification-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdown(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runMigrationCertificationPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteMigrationCertificationPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await closePool().catch(() => undefined);
  }
}
