import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { executeReconsolidationWorker } from "../ops/runtime-worker-service.js";
import { searchMemory } from "../retrieval/service.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

type Verdict = "pass" | "warning" | "fail";

interface CheckResult {
  readonly name: string;
  readonly verdict: Verdict;
  readonly failures: readonly string[];
}

export interface GraphRetrievalReviewReport {
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

async function insertSourceEpisodic(namespaceId: string, content: string, occurredAt: string, metadata: Record<string, unknown>): Promise<string> {
  const checksum = `benchmark-${randomUUID()}`;
  const uri = `benchmark://graph-retrieval/${checksum}.md`;
  const [artifact] = await queryRows<{ artifact_id: string }>(
    `
      INSERT INTO artifacts (
        namespace_id, artifact_type, uri, latest_checksum_sha256, mime_type, source_channel, metadata
      )
      VALUES ($1, 'markdown_session', $2, $3, 'text/markdown', 'benchmark', $4::jsonb)
      RETURNING id AS artifact_id
    `,
    [namespaceId, uri, checksum, JSON.stringify({ benchmark_seed: true, ...metadata })]
  );
  const [observation] = await queryRows<{ observation_id: string }>(
    `
      INSERT INTO artifact_observations (
        artifact_id, version, checksum_sha256, byte_size, observed_at, metadata
      )
      VALUES ($1, 1, $2, $3, $4::timestamptz, $5::jsonb)
      RETURNING id AS observation_id
    `,
    [artifact.artifact_id, checksum, content.length, occurredAt, JSON.stringify({ benchmark_seed: true, ...metadata })]
  );
  const [chunk] = await queryRows<{ chunk_id: string }>(
    `
      INSERT INTO artifact_chunks (
        artifact_id, artifact_observation_id, chunk_index, char_start, char_end, text_content, metadata
      )
      VALUES ($1, $2, 0, 0, $3, $4, $5::jsonb)
      RETURNING id AS chunk_id
    `,
    [artifact.artifact_id, observation.observation_id, content.length, content, JSON.stringify({ benchmark_seed: true, ...metadata })]
  );
  const [episodic] = await queryRows<{ memory_id: string }>(
    `
      INSERT INTO episodic_memory (
        namespace_id, session_id, role, content, occurred_at, captured_at,
        artifact_id, artifact_observation_id, source_chunk_id, source_offset, token_count, metadata
      )
      VALUES ($1, 'benchmark_graph_retrieval', 'import', $2, $3::timestamptz, $3::timestamptz, $4, $5, $6, $7::jsonb, $8, $9::jsonb)
      RETURNING id AS memory_id
    `,
    [
      namespaceId,
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
): Promise<void> {
  const sourceMemoryId = await insertSourceEpisodic(
    namespaceId,
    `${stateType} ${stateKey}\n${JSON.stringify(stateValue)}`,
    validFrom,
    { state_type: stateType, state_key: stateKey, source: "graph_retrieval_review" }
  );
  await queryRows(
    `
      INSERT INTO procedural_memory (
        namespace_id, state_type, state_key, state_value, version, updated_at, valid_from, metadata
      )
      VALUES ($1, $2, $3, $4::jsonb, 1, $5::timestamptz, $5::timestamptz, $6::jsonb)
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
      JSON.stringify({ benchmark_seed: true, source: "graph_retrieval_review" })
    ]
  );
}

async function seedFixture(namespaceId: string): Promise<void> {
  await insertProcedural(namespaceId, "current_location", "ava_home", { person: "Ava Chen", place: "Chiang Mai" }, "2026-01-10T09:00:00.000Z");
  await insertProcedural(namespaceId, "current_project", "ava_project", { person: "Ava Chen", project: "Northstar Atlas" }, "2026-01-12T09:00:00.000Z");
  await insertProcedural(namespaceId, "goal", "ava_goal", { person: "Ava Chen", goal: "Ship the Northstar Atlas launch plan" }, "2026-01-14T09:00:00.000Z");
  await insertProcedural(namespaceId, "routine", "ava_routine", { person: "Ava Chen", routine: "coworking on Saturdays with Omar" }, "2026-01-15T09:00:00.000Z");
}

function verdictForFailures(failures: readonly string[]): Verdict {
  return failures.length === 0 ? "pass" : "fail";
}

export async function runAndWriteGraphRetrievalReviewBenchmark(): Promise<{
  readonly report: GraphRetrievalReviewReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  const namespaceId = `benchmark_graph_review_${Date.now()}`;
  await seedFixture(namespaceId);
  await executeReconsolidationWorker({ namespaceId });

  const response = await searchMemory({
    namespaceId,
    query: "What does Ava Chen's life look like right now and what is she focused on lately?",
    limit: 8
  });

  const failures: string[] = [];
  if (response.meta.synthesisMode !== "reflect") {
    failures.push(`expected synthesisMode reflect, got ${response.meta.synthesisMode ?? "none"}`);
  }
  if (response.meta.graphRoutingUsed !== true) {
    failures.push("expected graphRoutingUsed true");
  }
  if ((response.meta.graphEvidenceCount ?? 0) < 1) {
    failures.push(`expected graphEvidenceCount >= 1, got ${response.meta.graphEvidenceCount ?? 0}`);
  }
  const payload = JSON.stringify(response).toLowerCase();
  if (!payload.includes("northstar atlas")) {
    failures.push("missing Northstar Atlas in graph-routed answer");
  }
  if (!payload.includes("chiang mai")) {
    failures.push("missing Chiang Mai in graph-routed answer");
  }

  const checks: CheckResult[] = [
    {
      name: "graph_routing_profile_query",
      verdict: verdictForFailures(failures),
      failures
    }
  ];

  const summary = {
    pass: checks.filter((item) => item.verdict === "pass").length,
    warning: 0,
    fail: checks.filter((item) => item.verdict === "fail").length
  };

  const report: GraphRetrievalReviewReport = {
    generatedAt: new Date().toISOString(),
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        benchmark: "graph_retrieval_review",
        namespaceId
      }
    }),
    namespaceId,
    checks,
    summary
  };

  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `graph-retrieval-review-${stamp}.json`);
  const markdownPath = path.join(dir, `graph-retrieval-review-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    `# Graph Retrieval Review\n\n- generatedAt: ${report.generatedAt}\n- namespaceId: ${namespaceId}\n- pass: ${summary.pass}\n- fail: ${summary.fail}\n`,
    "utf8"
  );

  return {
    report,
    output: {
      jsonPath,
      markdownPath
    }
  };
}

export async function runGraphRetrievalReviewBenchmarkCli(): Promise<void> {
  try {
    const result = await runAndWriteGraphRetrievalReviewBenchmark();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closePool();
  }
}
