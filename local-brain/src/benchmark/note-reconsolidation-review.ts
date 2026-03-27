import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryRows, closePool } from "../db/client.js";
import { executeReconsolidationWorker } from "../ops/runtime-worker-service.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

type Verdict = "pass" | "warning" | "fail";

interface CheckResult {
  readonly name: string;
  readonly verdict: Verdict;
  readonly failures: readonly string[];
}

export interface NoteReconsolidationReviewReport {
  readonly generatedAt: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: string;
  readonly checks: readonly CheckResult[];
  readonly summary: {
    readonly pass: number;
    readonly warning: number;
    readonly fail: number;
  };
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

function approxTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.trim().split(/\s+/u).filter(Boolean).length * 1.3));
}

async function insertSourceEpisodic(
  namespaceId: string,
  content: string,
  occurredAt: string,
  metadata: Record<string, unknown>
): Promise<string> {
  const checksum = `benchmark-${randomUUID()}`;
  const uri = `benchmark://note-reconsolidation/${checksum}.md`;
  const [artifact] = await queryRows<{ artifact_id: string }>(
    `
      INSERT INTO artifacts (
        namespace_id,
        artifact_type,
        uri,
        latest_checksum_sha256,
        mime_type,
        source_channel,
        metadata
      )
      VALUES ($1, 'markdown_session', $2, $3, 'text/markdown', 'benchmark', $4::jsonb)
      RETURNING id AS artifact_id
    `,
    [namespaceId, uri, checksum, JSON.stringify({ benchmark_seed: true, ...metadata })]
  );
  const [observation] = await queryRows<{ observation_id: string }>(
    `
      INSERT INTO artifact_observations (
        artifact_id,
        version,
        checksum_sha256,
        byte_size,
        observed_at,
        metadata
      )
      VALUES ($1, 1, $2, $3, $4::timestamptz, $5::jsonb)
      RETURNING id AS observation_id
    `,
    [artifact.artifact_id, checksum, content.length, occurredAt, JSON.stringify({ benchmark_seed: true, ...metadata })]
  );
  const [chunk] = await queryRows<{ chunk_id: string }>(
    `
      INSERT INTO artifact_chunks (
        artifact_id,
        artifact_observation_id,
        chunk_index,
        char_start,
        char_end,
        text_content,
        metadata
      )
      VALUES ($1, $2, 0, 0, $3, $4, $5::jsonb)
      RETURNING id AS chunk_id
    `,
    [artifact.artifact_id, observation.observation_id, content.length, content, JSON.stringify({ benchmark_seed: true, ...metadata })]
  );
  const [episodic] = await queryRows<{ memory_id: string }>(
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
        source_offset,
        token_count,
        metadata
      )
      VALUES ($1, $2, 'import', $3, $4::timestamptz, $4::timestamptz, $5, $6, $7, $8::jsonb, $9, $10::jsonb)
      RETURNING id AS memory_id
    `,
    [
      namespaceId,
      "benchmark_note_reconsolidation",
      content,
      occurredAt,
      artifact.artifact_id,
      observation.observation_id,
      chunk.chunk_id,
      JSON.stringify({ char_start: 0, char_end: content.length }),
      approxTokenCount(content),
      JSON.stringify({ benchmark_seed: true, ...metadata })
    ]
  );
  return episodic.memory_id;
}

async function insertProcedural(
  namespaceId: string,
  stateType: string,
  stateKey: string,
  stateValue: Record<string, unknown>,
  validFrom: string,
  validUntil: string | null,
  version: number,
  supersedesId: string | null = null
): Promise<string> {
  const sourceMemoryId = await insertSourceEpisodic(
    namespaceId,
    `${stateType} ${stateKey}\n${JSON.stringify(stateValue)}`,
    validFrom,
    { state_type: stateType, state_key: stateKey, source: "note_reconsolidation_review" }
  );
  const [row] = await queryRows<{ id: string }>(
    `
      INSERT INTO procedural_memory (
        namespace_id,
        state_type,
        state_key,
        state_value,
        version,
        updated_at,
        valid_from,
        valid_until,
        supersedes_id,
        metadata
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz, $6::timestamptz, $7::timestamptz, $8, $9::jsonb)
      RETURNING id
    `,
    [
      namespaceId,
      stateType,
      stateKey,
      JSON.stringify({
        ...stateValue,
        source_memory_id: sourceMemoryId
      }),
      version,
      validFrom,
      validUntil,
      supersedesId,
      JSON.stringify({ benchmark_seed: true, source: "note_reconsolidation_review" })
    ]
  );
  return row.id;
}

async function loadSummary(namespaceId: string, canonicalKey: string, status: "active" | "superseded"): Promise<{ content: string; metadata: Record<string, unknown> } | null> {
  const rows = await queryRows<{ content: string; metadata: Record<string, unknown> }>(
    `
      SELECT content_abstract AS content, metadata
      FROM semantic_memory
      WHERE namespace_id = $1
        AND canonical_key = $2
        AND status = $3
      ORDER BY valid_from DESC
      LIMIT 1
    `,
    [namespaceId, canonicalKey, status]
  );
  return rows[0] ?? null;
}

function verdictForFailures(failures: readonly string[]): Verdict {
  return failures.length === 0 ? "pass" : "fail";
}

function toMarkdown(report: NoteReconsolidationReviewReport): string {
  const lines = [
    "# Note Reconsolidation Review",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- benchmarkMode: ${report.runtime.benchmarkMode}`,
    `- retrievalFusionVersion: ${report.runtime.retrievalFusionVersion}`,
    `- rerankerVersion: ${report.runtime.rerankerVersion}`,
    `- relationIeSchemaVersion: ${report.runtime.relationIeSchemaVersion}`,
    "",
    "## Checks",
    ""
  ];
  for (const check of report.checks) {
    lines.push(`- ${check.name}: ${check.verdict}`);
    for (const failure of check.failures) {
      lines.push(`  - ${failure}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteNoteReconsolidationReviewBenchmark(): Promise<{
  readonly report: NoteReconsolidationReviewReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const namespaceId = `note_reconsolidation_${randomUUID().slice(0, 8)}`;
  const ava = "Ava Chen";

  await insertProcedural(namespaceId, "identity", "ava_identity", { person: ava, identity: "healthcare product operator" }, "2026-03-10T09:00:00.000Z", null, 1);
  const firstEmployerId = await insertProcedural(namespaceId, "current_employer", "ava_current_employer", { person: ava, organization: "Northstar Labs" }, "2026-03-10T09:05:00.000Z", null, 1);
  const firstProjectId = await insertProcedural(namespaceId, "current_project", "ava_current_project", { person: ava, project: "Patient Support Pilot", status: "active" }, "2026-03-10T09:10:00.000Z", null, 1);
  await insertProcedural(namespaceId, "project_role", "ava_project_role", { person: ava, role: "Research Lead", project: "Patient Support Pilot" }, "2026-03-10T09:12:00.000Z", null, 1);
  const firstRelationshipId = await insertProcedural(namespaceId, "current_relationship", "ava_current_relationship", { person: ava, partner_name: "Jon Rivera", relationship_status: "dating Jon Rivera" }, "2026-03-10T09:15:00.000Z", null, 1);

  await executeReconsolidationWorker({
    namespaceId,
    triggerType: "manual",
    workerId: "benchmark:note-reconsolidation:first"
  });

  await queryRows(
    `
      UPDATE procedural_memory
      SET valid_until = $2::timestamptz
      WHERE id = $1::uuid
    `,
    [firstEmployerId, "2026-03-20T08:59:59.000Z"]
  );
  await queryRows(
    `
      UPDATE procedural_memory
      SET valid_until = $2::timestamptz
      WHERE id = $1::uuid
    `,
    [firstProjectId, "2026-03-20T08:59:59.000Z"]
  );
  await queryRows(
    `
      UPDATE procedural_memory
      SET valid_until = $2::timestamptz
      WHERE id = $1::uuid
    `,
    [firstRelationshipId, "2026-03-20T08:59:59.000Z"]
  );

  await insertProcedural(namespaceId, "current_employer", "ava_current_employer", { person: ava, organization: "Harbor Health" }, "2026-03-20T09:00:00.000Z", null, 2, firstEmployerId);
  await insertProcedural(namespaceId, "current_project", "ava_current_project", { person: ava, project: "Harbor Care Rollout", status: "paused for vendor review" }, "2026-03-20T09:05:00.000Z", null, 2, firstProjectId);
  await insertProcedural(namespaceId, "current_relationship", "ava_current_relationship", { person: ava, relationship_status: "single" }, "2026-03-20T09:08:00.000Z", null, 2, firstRelationshipId);

  const secondRun = await executeReconsolidationWorker({
    namespaceId,
    triggerType: "manual",
    workerId: "benchmark:note-reconsolidation:second"
  });

  const identityKey = "reconsolidated:profile_summary:identity_summary:ava_chen";
  const projectKey = "reconsolidated:profile_summary:project_status:ava_chen";
  const relationshipKey = "reconsolidated:profile_summary:relationship_status:ava_chen";

  const activeIdentity = await loadSummary(namespaceId, identityKey, "active");
  const activeProject = await loadSummary(namespaceId, projectKey, "active");
  const supersededProject = await loadSummary(namespaceId, projectKey, "superseded");
  const activeRelationship = await loadSummary(namespaceId, relationshipKey, "active");
  const supersededRelationship = await loadSummary(namespaceId, relationshipKey, "superseded");

  const workerRows = await queryRows<{ status: string; summary_json: Record<string, unknown> }>(
    `
      SELECT status, summary_json
      FROM ops.worker_runs
      WHERE worker_key = 'reconsolidation'
        AND namespace_id = $1
      ORDER BY started_at DESC
      LIMIT 2
    `,
    [namespaceId]
  );

  const checks: CheckResult[] = [];

  {
    const failures = [
      !activeIdentity ? "missing active identity_summary" : "",
      activeIdentity && !JSON.stringify(activeIdentity.content).toLowerCase().includes("healthcare product operator") ? "identity_summary missing identity text" : "",
      activeIdentity && !JSON.stringify(activeIdentity.content).toLowerCase().includes("research lead") ? "identity_summary missing role text" : "",
      activeIdentity && activeIdentity.metadata?.note_family !== "profile_note" ? "identity_summary missing profile_note metadata" : "",
      activeIdentity && !Array.isArray(activeIdentity.metadata?.support_episodic_ids) ? "identity_summary missing support_episodic_ids metadata" : ""
    ].filter(Boolean);
    checks.push({ name: "identity_summary_active", verdict: verdictForFailures(failures), failures });
  }

  {
    const failures = [
      !activeProject ? "missing active project_status" : "",
      activeProject && !JSON.stringify(activeProject.content).toLowerCase().includes("paused for vendor review") ? "active project_status missing latest status" : "",
      activeProject && activeProject.metadata?.note_family !== "fact_note" ? "active project_status missing fact_note metadata" : "",
      !supersededProject ? "missing superseded project_status" : "",
      supersededProject && !JSON.stringify(supersededProject.content).toLowerCase().includes("patient support pilot") ? "superseded project_status missing prior project" : ""
    ].filter(Boolean);
    checks.push({ name: "project_status_supersedes", verdict: verdictForFailures(failures), failures });
  }

  {
    const failures = [
      !activeRelationship ? "missing active relationship_status" : "",
      activeRelationship && !JSON.stringify(activeRelationship.content).toLowerCase().includes("single") ? "active relationship_status missing latest status" : "",
      activeRelationship && activeRelationship.metadata?.note_family !== "fact_note" ? "active relationship_status missing fact_note metadata" : "",
      !supersededRelationship ? "missing superseded relationship_status" : "",
      supersededRelationship && !JSON.stringify(supersededRelationship.content).toLowerCase().includes("jon rivera") ? "superseded relationship_status missing previous partner" : ""
    ].filter(Boolean);
    checks.push({ name: "relationship_status_supersedes", verdict: verdictForFailures(failures), failures });
  }

  {
    const failures = [
      secondRun.processedKeys.length === 0 ? "reconsolidation worker processed zero keys" : "",
      workerRows.length < 2 ? "expected reconsolidation worker runs to be logged" : "",
      workerRows[0] && workerRows[0].status !== "succeeded" && workerRows[0].status !== "partial" ? `unexpected latest worker status ${workerRows[0].status}` : ""
    ].filter(Boolean);
    checks.push({ name: "reconsolidation_worker_logged", verdict: verdictForFailures(failures), failures });
  }

  {
    const eventRows = await queryRows<{ action: string; reason: string; metadata: Record<string, unknown> }>(
      `
        SELECT action, reason, metadata
        FROM memory_reconsolidation_events
        WHERE namespace_id = $1
          AND target_memory_kind = 'profile_summary'
        ORDER BY created_at DESC
        LIMIT 20
      `,
      [namespaceId]
    );
    const failures = [
      !eventRows.some((row) => row.action === "supersede" && typeof row.reason === "string" && row.reason.toLowerCase().includes("project_status")) ? "missing project_status supersede event" : "",
      !eventRows.some((row) => row.action === "supersede" && typeof row.reason === "string" && row.reason.toLowerCase().includes("relationship_status")) ? "missing relationship_status supersede event" : "",
      !eventRows.some((row) => row.metadata?.reconsolidation_decision === "update") ? "missing update decision metadata" : "",
      !eventRows.some((row) => row.metadata?.reconsolidation_decision === "supersede") ? "missing supersede decision metadata" : "",
      !eventRows.some((row) => row.metadata?.adjudication_action === "update") ? "missing update adjudication metadata" : "",
      !eventRows.some((row) => row.metadata?.adjudication_action === "supersede") ? "missing supersede adjudication metadata" : ""
    ].filter(Boolean);
    checks.push({ name: "typed_reconsolidation_events_present", verdict: verdictForFailures(failures), failures });
  }

  const report: NoteReconsolidationReviewReport = {
    generatedAt: new Date().toISOString(),
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        benchmark: "note_reconsolidation_review",
        namespaceId
      }
    }),
    namespaceId,
    checks,
    summary: {
      pass: checks.filter((item) => item.verdict === "pass").length,
      warning: checks.filter((item) => item.verdict === "warning").length,
      fail: checks.filter((item) => item.verdict === "fail").length
    }
  };

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `note-reconsolidation-review-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `note-reconsolidation-review-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runNoteReconsolidationReviewBenchmarkCli(): Promise<void> {
  try {
    const result = await runAndWriteNoteReconsolidationReviewBenchmark();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
