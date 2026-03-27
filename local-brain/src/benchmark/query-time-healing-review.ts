import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { searchMemory } from "../retrieval/service.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

type Verdict = "pass" | "warning" | "fail";

interface CheckResult {
  readonly name: string;
  readonly verdict: Verdict;
  readonly failures: readonly string[];
}

export interface QueryTimeHealingReviewReport {
  readonly generatedAt: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: string;
  readonly checks: readonly CheckResult[];
  readonly firstQuery: {
    readonly confidence: string | null;
    readonly sufficiency: string | null;
    readonly subjectMatch: string | null;
    readonly summaryEvidenceUsed: boolean;
    readonly noteWritebackTriggered: boolean;
    readonly noteWritebackFamily: string | null;
  };
  readonly secondQuery: {
    readonly confidence: string | null;
    readonly sufficiency: string | null;
    readonly summaryEvidenceUsed: boolean;
  };
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

function verdictForFailures(failures: readonly string[]): Verdict {
  return failures.length === 0 ? "pass" : "fail";
}

async function insertSourceEpisodic(
  namespaceId: string,
  content: string,
  occurredAt: string,
  metadata: Record<string, unknown>
): Promise<string> {
  const checksum = `benchmark-${randomUUID()}`;
  const uri = `benchmark://query-time-healing/${checksum}.md`;
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
      "benchmark_query_time_healing",
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
  validFrom: string
): Promise<string> {
  const sourceMemoryId = await insertSourceEpisodic(
    namespaceId,
    `${stateType} ${stateKey}\n${JSON.stringify(stateValue)}`,
    validFrom,
    { state_type: stateType, state_key: stateKey, source: "query_time_healing_review" }
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
        metadata
      )
      VALUES ($1, $2, $3, $4::jsonb, 1, $5::timestamptz, $5::timestamptz, NULL, $6::jsonb)
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
      validFrom,
      JSON.stringify({ benchmark_seed: true, source: "query_time_healing_review" })
    ]
  );
  return row.id;
}

async function loadActiveWritebackSummary(namespaceId: string, canonicalKey: string): Promise<{
  readonly content: string;
  readonly metadata: Record<string, unknown>;
} | null> {
  const rows = await queryRows<{ content: string; metadata: Record<string, unknown> }>(
    `
      SELECT content_abstract AS content, metadata
      FROM semantic_memory
      WHERE namespace_id = $1
        AND canonical_key = $2
        AND memory_kind = 'profile_summary'
        AND status = 'active'
      ORDER BY valid_from DESC, id DESC
      LIMIT 1
    `,
    [namespaceId, canonicalKey]
  );
  return rows[0] ?? null;
}

function toMarkdown(report: QueryTimeHealingReviewReport): string {
  const lines = [
    "# Query-Time Healing Review",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- benchmarkMode: ${report.runtime.benchmarkMode}`,
    `- benchmarkLane: ${report.runtime.benchmarkLane ?? "unset"}`,
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

export async function runAndWriteQueryTimeHealingReviewBenchmark(): Promise<{
  readonly report: QueryTimeHealingReviewReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const namespaceId = `query_time_healing_${randomUUID().slice(0, 8)}`;
  const person = "Maya Torres";

  await insertProcedural(namespaceId, "current_employer", "maya_current_employer", { person, organization: "Signal Harbor" }, "2026-03-22T09:00:00.000Z");
  await insertProcedural(namespaceId, "project_role", "maya_role", { person, role: "product strategist", project: "Onboarding System" }, "2026-03-22T09:02:00.000Z");
  await insertProcedural(namespaceId, "current_project", "maya_current_project", { person, project: "Onboarding System", status: "shipping the first rollout" }, "2026-03-22T09:03:00.000Z");
  await insertProcedural(namespaceId, "goal", "maya_goal", { person, goal: "reduce onboarding drop-off for new users" }, "2026-03-22T09:05:00.000Z");
  await insertProcedural(namespaceId, "plan", "maya_plan", { person, plan: "pair better activation prompts with the rollout" }, "2026-03-22T09:07:00.000Z");

  const query = "What has Maya Torres been doing lately on the Onboarding System?";
  const first = await searchMemory({
    namespaceId,
    query,
    limit: 8
  });

  const canonicalKey = "reconsolidated:profile_summary:current_picture:maya_torres";
  const activeSummary = await loadActiveWritebackSummary(namespaceId, canonicalKey);

  const second = await searchMemory({
    namespaceId,
    query,
    limit: 8
  });

  const checks: CheckResult[] = [];

  {
    const failures = [
      first.meta.answerAssessment?.sufficiency !== "supported" ? `expected first query sufficiency supported, got ${first.meta.answerAssessment?.sufficiency ?? "missing"}` : "",
      first.meta.answerAssessment?.subjectMatch !== "matched" ? `expected first query subjectMatch matched, got ${first.meta.answerAssessment?.subjectMatch ?? "missing"}` : "",
      first.meta.noteWritebackTriggered !== true ? "expected first query to trigger note writeback" : "",
      first.meta.noteWritebackFamily !== "profile_note" ? `expected first query noteWritebackFamily profile_note, got ${first.meta.noteWritebackFamily ?? "missing"}` : ""
    ].filter(Boolean);
    checks.push({ name: "first_query_triggers_writeback", verdict: verdictForFailures(failures), failures });
  }

  {
    const failures = [
      !activeSummary ? "missing active current_picture summary after first query" : "",
      activeSummary && activeSummary.metadata?.source !== "query_time_writeback" ? "current_picture summary missing query_time_writeback source metadata" : "",
      activeSummary && activeSummary.metadata?.note_family !== "profile_note" ? "current_picture summary missing profile_note metadata" : "",
      activeSummary && !Array.isArray(activeSummary.metadata?.support_procedural_ids) ? "current_picture summary missing support_procedural_ids" : "",
      activeSummary && !Array.isArray(activeSummary.metadata?.support_episodic_ids) ? "current_picture summary missing support_episodic_ids" : ""
    ].filter(Boolean);
    checks.push({ name: "writeback_summary_persisted", verdict: verdictForFailures(failures), failures });
  }

  {
    const failures = [
      second.meta.answerAssessment?.summaryEvidenceUsed !== true ? "expected second query to use summary evidence" : "",
      second.meta.answerAssessment?.sufficiency !== "supported" ? `expected second query sufficiency supported, got ${second.meta.answerAssessment?.sufficiency ?? "missing"}` : ""
    ].filter(Boolean);
    checks.push({ name: "second_query_uses_summary", verdict: verdictForFailures(failures), failures });
  }

  const report: QueryTimeHealingReviewReport = {
    generatedAt: new Date().toISOString(),
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        benchmark: "query_time_healing_review",
        namespaceId
      }
    }),
    namespaceId,
    checks,
    firstQuery: {
      confidence: first.meta.answerAssessment?.confidence ?? null,
      sufficiency: first.meta.answerAssessment?.sufficiency ?? null,
      subjectMatch: first.meta.answerAssessment?.subjectMatch ?? null,
      summaryEvidenceUsed: first.meta.answerAssessment?.summaryEvidenceUsed === true,
      noteWritebackTriggered: first.meta.noteWritebackTriggered === true,
      noteWritebackFamily: first.meta.noteWritebackFamily ?? null
    },
    secondQuery: {
      confidence: second.meta.answerAssessment?.confidence ?? null,
      sufficiency: second.meta.answerAssessment?.sufficiency ?? null,
      summaryEvidenceUsed: second.meta.answerAssessment?.summaryEvidenceUsed === true
    },
    summary: {
      pass: checks.filter((item) => item.verdict === "pass").length,
      warning: checks.filter((item) => item.verdict === "warning").length,
      fail: checks.filter((item) => item.verdict === "fail").length
    }
  };

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `query-time-healing-review-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `query-time-healing-review-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runQueryTimeHealingReviewBenchmarkCli(): Promise<void> {
  try {
    const result = await runAndWriteQueryTimeHealingReviewBenchmark();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
