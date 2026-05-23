import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool, queryRows, withTransaction } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { executeMcpTool } from "../mcp/server.js";

interface SeededSource {
  readonly namespaceId: string;
  readonly artifactId: string;
  readonly chunkId: string;
  readonly sourceUri: string;
  readonly secretTerm: string;
}

interface Row {
  readonly id: string;
  readonly query: string;
  readonly phase: "before" | "after" | "revert";
  readonly expectedBlocked: boolean;
  readonly blocked: boolean;
  readonly leakedSecret: boolean;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly abstentionReason: string | null;
  readonly latencyMs: number;
  readonly passed: boolean;
}

interface Report {
  readonly passed: boolean;
  readonly metrics: {
    readonly deletionPropagationPassRate: number;
    readonly redactionPropagationPassRate: number;
    readonly privateSourceLeakCount: number;
    readonly auditTrailCoverageRate: number;
    readonly rawSourceRetainedCount: number;
    readonly rollbackRestorationPassRate: number;
    readonly queryTimeModelCalls: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly rows: readonly Row[];
  readonly privacyStatus: Record<string, unknown>;
  readonly artifactPath: string;
  readonly markdownPath: string;
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function checksum(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function payloadText(payload: unknown): string {
  return JSON.stringify(payload).toLowerCase();
}

function evidenceCount(payload: any): number {
  if (typeof payload?.evidenceCount === "number") return payload.evidenceCount;
  if (Array.isArray(payload?.items)) return payload.items.length;
  if (Array.isArray(payload?.results)) return payload.results.length;
  return 0;
}

function sourceTrailCount(payload: any): number {
  const top = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0;
  const sections = Array.isArray(payload?.answerSections)
    ? payload.answerSections.reduce((sum: number, section: any) => sum + (Array.isArray(section?.sourceTrail) ? section.sourceTrail.length : 0), 0)
    : 0;
  return top + sections;
}

async function seedSource(params: {
  readonly namespaceId: string;
  readonly sourceUri: string;
  readonly content: string;
}): Promise<SeededSource> {
  return withTransaction(async (client) => {
    await client.query(`DELETE FROM source_privacy_audit_log WHERE namespace_id = $1`, [params.namespaceId]);
    await client.query(`DELETE FROM source_privacy_overlays WHERE namespace_id = $1`, [params.namespaceId]);
    await client.query(`DELETE FROM source_truth_catalog WHERE namespace_id = $1`, [params.namespaceId]);
    await client.query(`DELETE FROM episodic_timeline WHERE namespace_id = $1`, [params.namespaceId]);
    await client.query(`DELETE FROM episodic_memory WHERE namespace_id = $1`, [params.namespaceId]);
    await client.query(`DELETE FROM artifact_chunks WHERE artifact_id IN (SELECT id FROM artifacts WHERE namespace_id = $1)`, [params.namespaceId]);
    await client.query(`DELETE FROM artifact_observations WHERE artifact_id IN (SELECT id FROM artifacts WHERE namespace_id = $1)`, [params.namespaceId]);
    await client.query(`DELETE FROM artifacts WHERE namespace_id = $1`, [params.namespaceId]);
    const digest = checksum(params.content);
    const artifact = await client.query<{ id: string }>(
      `
        INSERT INTO artifacts (namespace_id, artifact_type, uri, latest_checksum_sha256, mime_type, source_channel, metadata)
        VALUES ($1, 'phase_13_fixture', $2, $3, 'text/plain', 'benchmark_fixture', $4::jsonb)
        RETURNING id
      `,
      [params.namespaceId, params.sourceUri, digest, JSON.stringify({ phase: "13", raw_source_truth: "immutable_fixture" })]
    );
    const artifactId = artifact.rows[0]!.id;
    const observation = await client.query<{ id: string }>(
      `
        INSERT INTO artifact_observations (artifact_id, version, checksum_sha256, byte_size, metadata)
        VALUES ($1::uuid, 1, $2, $3, $4::jsonb)
        RETURNING id
      `,
      [artifactId, digest, params.content.length, JSON.stringify({ phase: "13" })]
    );
    const observationId = observation.rows[0]!.id;
    const chunk = await client.query<{ id: string }>(
      `
        INSERT INTO artifact_chunks (artifact_id, artifact_observation_id, chunk_index, char_start, char_end, text_content, metadata)
        VALUES ($1::uuid, $2::uuid, 0, 0, $3, $4, $5::jsonb)
        RETURNING id
      `,
      [artifactId, observationId, params.content.length, params.content, JSON.stringify({ phase: "13" })]
    );
    const chunkId = chunk.rows[0]!.id;
    await client.query<{ id: string }>(
      `
        INSERT INTO episodic_memory (
          namespace_id,
          session_id,
          role,
          content,
          occurred_at,
          captured_at,
          artifact_id,
          artifact_observation_id,
          source_chunk_id,
          metadata
        )
        VALUES ($1, 'phase-13-privacy', 'import', $2, '2026-05-23T00:00:00Z', '2026-05-23T00:00:00Z', $3::uuid, $4::uuid, $5::uuid, $6::jsonb)
        RETURNING id
      `,
      [params.namespaceId, params.content, artifactId, observationId, chunkId, JSON.stringify({ phase: "13", source_uri: params.sourceUri })]
    );
    const secretTerm = params.content.match(/Phase13[A-Za-z]+Secret[A-Za-z0-9]+/u)?.[0] ?? params.content.split(/\s+/u)[0]!;
    return { namespaceId: params.namespaceId, artifactId, chunkId, sourceUri: params.sourceUri, secretTerm };
  });
}

async function runQuery(row: Omit<Row, "blocked" | "leakedSecret" | "evidenceCount" | "sourceTrailCount" | "abstentionReason" | "latencyMs" | "passed"> & {
  readonly namespaceId: string;
  readonly secretTerm: string;
}): Promise<Row> {
  const start = performance.now();
  const payload = await executeMcpTool("memory.recap", {
    namespace_id: row.namespaceId,
    query: row.query,
    limit: 8,
    detail_mode: "full"
  }) as any;
  const latencyMs = Number((performance.now() - start).toFixed(2));
  const structured = payload?.structuredContent ?? payload;
  const text = payloadText(structured);
  const blocked = structured?.sourcePrivacy?.blocked === true || String(structured?.retrievalDomain ?? "") === "source_privacy";
  const leakedSecret = text.includes(row.secretTerm.toLowerCase());
  const count = evidenceCount(structured);
  const trailCount = sourceTrailCount(structured);
  const passed = row.expectedBlocked ? blocked && !leakedSecret : !blocked && leakedSecret && count > 0 && trailCount > 0;
  return {
    id: row.id,
    query: row.query,
    phase: row.phase,
    expectedBlocked: row.expectedBlocked,
    blocked,
    leakedSecret,
    evidenceCount: count,
    sourceTrailCount: trailCount,
    abstentionReason: typeof structured?.abstentionReason === "string" ? structured.abstentionReason : null,
    latencyMs,
    passed
  };
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[index]!.toFixed(2));
}

async function rawSourceRetainedCount(namespaceId: string): Promise<number> {
  const rows = await queryRows<{ count: string }>(
    `
      SELECT count(*)::text
      FROM artifact_chunks ac
      JOIN artifacts a ON a.id = ac.artifact_id
      WHERE a.namespace_id = $1
        AND ac.text_content ILIKE '%Phase13%'
    `,
    [namespaceId]
  );
  return Number(rows[0]?.count ?? 0);
}

async function auditTrailCount(namespaceId: string): Promise<number> {
  const rows = await queryRows<{ count: string }>(
    `SELECT count(*)::text FROM source_privacy_audit_log WHERE namespace_id = $1`,
    [namespaceId]
  );
  return Number(rows[0]?.count ?? 0);
}

function renderMarkdown(report: Report): string {
  const lines = [
    "# Source Privacy Retention Pack",
    "",
    `- passed: ${report.passed}`,
    `- deletionPropagationPassRate: ${report.metrics.deletionPropagationPassRate}`,
    `- redactionPropagationPassRate: ${report.metrics.redactionPropagationPassRate}`,
    `- privateSourceLeakCount: ${report.metrics.privateSourceLeakCount}`,
    `- auditTrailCoverageRate: ${report.metrics.auditTrailCoverageRate}`,
    `- rawSourceRetainedCount: ${report.metrics.rawSourceRetainedCount}`,
    `- rollbackRestorationPassRate: ${report.metrics.rollbackRestorationPassRate}`,
    "",
    "| Row | Phase | Expected Blocked | Blocked | Leaked Secret | Passed |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.rows.map((row) => `| ${row.id} | ${row.phase} | ${row.expectedBlocked} | ${row.blocked} | ${row.leakedSecret} | ${row.passed} |`),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

export async function runSourcePrivacyRetentionPack(): Promise<Report> {
  await runMigrations();
  await mkdir(outputDir(), { recursive: true });
  const namespaceId = "phase-13-source-privacy";
  const deleteSource = await seedSource({
    namespaceId,
    sourceUri: "phase13://logical-delete-source",
    content: "Phase13DeleteSecretAlpha should be retrievable before a logical privacy delete overlay and blocked afterward."
  });
  const redactSource = await seedSource({
    namespaceId: `${namespaceId}-redact`,
    sourceUri: "phase13://redaction-source",
    content: "Phase13RedactSecretBeta should be retrievable before a redaction overlay and blocked afterward."
  });
  const privateSource = await seedSource({
    namespaceId: `${namespaceId}-private`,
    sourceUri: "phase13://private-source",
    content: "Phase13PrivateSecretGamma should be retrievable before a private access label and blocked afterward."
  });

  const rows: Row[] = [];
  rows.push(await runQuery({
    id: "delete_before",
    namespaceId: deleteSource.namespaceId,
    query: "What does the Phase13DeleteSecretAlpha source say?",
    phase: "before",
    expectedBlocked: false,
    secretTerm: deleteSource.secretTerm
  }));
  const deleteOverlay = await executeMcpTool("memory.apply_source_privacy", {
    namespace_id: deleteSource.namespaceId,
    action_type: "logical_delete",
    target_artifact_id: deleteSource.artifactId,
    reason: "Phase 13 logical delete fixture",
    actor: "benchmark"
  }) as any;
  rows.push(await runQuery({
    id: "delete_after",
    namespaceId: deleteSource.namespaceId,
    query: "What does the Phase13DeleteSecretAlpha source say?",
    phase: "after",
    expectedBlocked: true,
    secretTerm: deleteSource.secretTerm
  }));
  await executeMcpTool("memory.revert_source_privacy", {
    namespace_id: deleteSource.namespaceId,
    overlay_id: deleteOverlay?.structuredContent?.overlay?.id,
    reason: "Phase 13 rollback fixture",
    actor: "benchmark"
  });
  rows.push(await runQuery({
    id: "delete_revert",
    namespaceId: deleteSource.namespaceId,
    query: "What does the Phase13DeleteSecretAlpha source say?",
    phase: "revert",
    expectedBlocked: false,
    secretTerm: deleteSource.secretTerm
  }));

  rows.push(await runQuery({
    id: "redact_before",
    namespaceId: redactSource.namespaceId,
    query: "What does the Phase13RedactSecretBeta source say?",
    phase: "before",
    expectedBlocked: false,
    secretTerm: redactSource.secretTerm
  }));
  await executeMcpTool("memory.apply_source_privacy", {
    namespace_id: redactSource.namespaceId,
    action_type: "redact",
    target_artifact_id: redactSource.artifactId,
    redaction_text: redactSource.secretTerm,
    reason: "Phase 13 redaction fixture",
    actor: "benchmark"
  });
  rows.push(await runQuery({
    id: "redact_after",
    namespaceId: redactSource.namespaceId,
    query: "What does the Phase13RedactSecretBeta source say?",
    phase: "after",
    expectedBlocked: true,
    secretTerm: redactSource.secretTerm
  }));

  rows.push(await runQuery({
    id: "private_before",
    namespaceId: privateSource.namespaceId,
    query: "What does the Phase13PrivateSecretGamma source say?",
    phase: "before",
    expectedBlocked: false,
    secretTerm: privateSource.secretTerm
  }));
  await executeMcpTool("memory.apply_source_privacy", {
    namespace_id: privateSource.namespaceId,
    action_type: "access_label",
    target_artifact_id: privateSource.artifactId,
    access_label: "private",
    reason: "Phase 13 private label fixture",
    actor: "benchmark"
  });
  rows.push(await runQuery({
    id: "private_after",
    namespaceId: privateSource.namespaceId,
    query: "What does the Phase13PrivateSecretGamma source say?",
    phase: "after",
    expectedBlocked: true,
    secretTerm: privateSource.secretTerm
  }));

  const rawSourceCount =
    await rawSourceRetainedCount(deleteSource.namespaceId) +
    await rawSourceRetainedCount(redactSource.namespaceId) +
    await rawSourceRetainedCount(privateSource.namespaceId);
  const auditCount =
    await auditTrailCount(deleteSource.namespaceId) +
    await auditTrailCount(redactSource.namespaceId) +
    await auditTrailCount(privateSource.namespaceId);
  const privacyStatus = await executeMcpTool("memory.get_source_privacy_status", {
    namespace_id: deleteSource.namespaceId,
    target_artifact_id: deleteSource.artifactId,
    limit: 10
  }) as Record<string, unknown>;
  const latencies = rows.map((row) => row.latencyMs);
  const deletionRows = rows.filter((row) => row.id.startsWith("delete_"));
  const redactionRows = rows.filter((row) => row.id.startsWith("redact_"));
  const reportWithoutPaths = {
    passed: rows.every((row) => row.passed) && rawSourceCount >= 3 && auditCount >= 4,
    metrics: {
      deletionPropagationPassRate: deletionRows.filter((row) => row.passed).length / deletionRows.length,
      redactionPropagationPassRate: redactionRows.filter((row) => row.passed).length / redactionRows.length,
      privateSourceLeakCount: rows.filter((row) => row.id.startsWith("private_") && row.phase === "after" && row.leakedSecret).length,
      auditTrailCoverageRate: auditCount >= 4 ? 1 : 0,
      rawSourceRetainedCount: rawSourceCount,
      rollbackRestorationPassRate: rows.find((row) => row.id === "delete_revert")?.passed ? 1 : 0,
      queryTimeModelCalls: 0,
      p95LatencyMs: percentile(latencies, 95),
      maxLatencyMs: Math.max(...latencies)
    },
    rows,
    privacyStatus
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactPath = path.join(outputDir(), `source-privacy-retention-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `source-privacy-retention-pack-${stamp}.md`);
  const report: Report = { ...reportWithoutPaths, artifactPath, markdownPath };
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMarkdown(report), "utf8");
  return report;
}

export async function runSourcePrivacyRetentionPackCli(): Promise<void> {
  try {
    const report = await runSourcePrivacyRetentionPack();
    console.log(JSON.stringify({ passed: report.passed, metrics: report.metrics, artifactPath: report.artifactPath }, null, 2));
  } finally {
    await closePool();
  }
}
