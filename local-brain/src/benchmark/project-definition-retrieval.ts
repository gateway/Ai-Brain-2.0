import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { rebuildContractProjectionsNamespace } from "../contract-projections/service.js";
import { closePool, queryRows, withClient } from "../db/client.js";
import { searchMemory } from "../retrieval/service.js";

interface ProjectDefinitionCase {
  readonly id: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly shouldHaveEvidence: boolean;
}

interface ProjectDefinitionResult extends ProjectDefinitionCase {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly claim: string;
  readonly finalClaimSource: string | null;
  readonly queryContractName: string | null;
  readonly retrievalDomain: string | null;
  readonly evidenceCount: number;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
}

interface ProjectDefinitionRetrievalReport {
  readonly generatedAt: string;
  readonly benchmark: "project_definition_retrieval";
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly metrics: {
    readonly caseCount: number;
    readonly coverageRate: number;
    readonly projectionHeadCount: number;
    readonly projectionEntryCount: number;
    readonly sourceEvidenceViolationCount: number;
    readonly unsupportedNoEvidenceSuccessCount: number;
    readonly evidenceZeroBackedSuccessCount: number;
    readonly queryTimeModelCalls: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly failures: readonly string[];
  readonly results: readonly ProjectDefinitionResult[];
}

const DEFAULT_NAMESPACE = "benchmark_project_definition_retrieval";
const CASES: readonly ProjectDefinitionCase[] = [
  { id: "two_way_definition", query: "What is Two Way?", expectedTerms: ["Two Way", "work"], shouldHaveEvidence: true },
  { id: "ai_brain_definition", query: "What is AI Brain?", expectedTerms: ["AI Brain", "memory"], shouldHaveEvidence: true },
  { id: "well_inked_definition", query: "What is Well Inked?", expectedTerms: ["Well Inked", "work"], shouldHaveEvidence: true },
  { id: "unknown_project_abstention", query: "What is Zednock?", expectedTerms: [], shouldHaveEvidence: false }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(2));
}

function rate(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

async function seedProjectDefinitionFixture(namespaceId: string): Promise<void> {
  await withClient(async (client) => {
    await client.query("DELETE FROM contract_projection_entries WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM contract_projection_heads WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM episodic_memory WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM artifact_chunks WHERE artifact_id IN (SELECT id FROM artifacts WHERE namespace_id = $1)", [namespaceId]);
    await client.query("DELETE FROM artifact_observations WHERE artifact_id IN (SELECT id FROM artifacts WHERE namespace_id = $1)", [namespaceId]);
    await client.query("DELETE FROM artifacts WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM entities WHERE namespace_id = $1", [namespaceId]);

    const content = [
      "Two Way is a client/product work context in Steve's notes. Omi works with Steve through Two Way on forum and backend work.",
      "AI Brain is a memory and retrieval system project. The AI Brain project stores source-bound memory and retrieves it through projections.",
      "Well Inked is a work project in Steve's notes, connected to content and backend operations."
    ].join("\n\n");
    const checksum = stableHash(content);
    const artifact = await client.query<{ id: string }>(
      `
        INSERT INTO artifacts (namespace_id, artifact_type, uri, latest_checksum_sha256, mime_type, source_channel, metadata)
        VALUES ($1, 'markdown', 'project-definition://fixture', $2, 'text/markdown', 'benchmark:project-definition', $3::jsonb)
        RETURNING id::text
      `,
      [namespaceId, checksum, JSON.stringify({ benchmark_seed: true, source_route: "markdown" })]
    );
    const artifactId = artifact.rows[0]!.id;
    const observation = await client.query<{ id: string }>(
      `
        INSERT INTO artifact_observations (artifact_id, version, checksum_sha256, byte_size, observed_at, metadata)
        VALUES ($1::uuid, 1, $2, $3, '2026-05-16T00:00:00Z', $4::jsonb)
        RETURNING id::text
      `,
      [artifactId, checksum, content.length, JSON.stringify({ benchmark_seed: true })]
    );
    const observationId = observation.rows[0]!.id;
    const chunk = await client.query<{ id: string }>(
      `
        INSERT INTO artifact_chunks (artifact_id, artifact_observation_id, chunk_index, char_start, char_end, text_content, metadata)
        VALUES ($1::uuid, $2::uuid, 0, 0, $3, $4, $5::jsonb)
        RETURNING id::text
      `,
      [artifactId, observationId, content.length, content, JSON.stringify({ benchmark_seed: true, source_route: "markdown" })]
    );
    await client.query(
      `
        INSERT INTO episodic_memory (
          namespace_id, session_id, role, content, occurred_at, captured_at, artifact_id, artifact_observation_id, source_chunk_id, metadata
        )
        VALUES ($1, 'project-definition-fixture', 'import', $2, '2026-05-16T00:00:00Z', '2026-05-16T00:00:00Z', $3::uuid, $4::uuid, $5::uuid, $6::jsonb)
      `,
      [namespaceId, content, artifactId, observationId, chunk.rows[0]!.id, JSON.stringify({ benchmark_seed: true, source_route: "markdown" })]
    );
  });
}

async function loadProjectionStats(namespaceId: string): Promise<{ heads: number; entries: number; evidenceViolations: number }> {
  const rows = await queryRows<{ heads: string; entries: string; evidence_violations: string }>(
    `
      WITH heads AS (
        SELECT id FROM contract_projection_heads
        WHERE namespace_id = $1
          AND contract_name = 'project_definition'
          AND projection_version = 'project_definition_projection_v1'
      ),
      entries AS (
        SELECT entry.*
        FROM contract_projection_entries entry
        JOIN heads ON heads.id = entry.projection_head_id
      )
      SELECT
        (SELECT count(*) FROM heads)::text AS heads,
        (SELECT count(*) FROM entries)::text AS entries,
        (SELECT count(*) FROM entries WHERE source_row_id IS NULL OR NULLIF(metadata->>'source_quote', '') IS NULL)::text AS evidence_violations
    `,
    [namespaceId]
  );
  const row = rows[0];
  return {
    heads: Number(row?.heads ?? 0),
    entries: Number(row?.entries ?? 0),
    evidenceViolations: Number(row?.evidence_violations ?? 0)
  };
}

async function runCase(namespaceId: string, testCase: ProjectDefinitionCase): Promise<ProjectDefinitionResult> {
  const startedAt = performance.now();
  const response = await searchMemory({ namespaceId, query: testCase.query, limit: 8 });
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const claim = response.duality.claim.text;
  const claimLower = claim.toLowerCase();
  const finalClaimSource = response.meta.finalClaimSource ?? null;
  const evidenceCount = response.evidence.length;
  const queryTimeModelCalls = Number((response.meta as Record<string, unknown>).queryTimeModelCalls ?? 0);
  const failures: string[] = [];
  if (testCase.shouldHaveEvidence) {
    if (response.meta.queryContractName !== "project_definition") failures.push("query_contract_not_project_definition");
    if (response.meta.queryContractRetrievalDomain !== "project_definition") failures.push("retrieval_domain_not_project_definition");
    if (finalClaimSource !== "project_definition_projection") failures.push("final_claim_source_not_project_definition_projection");
    if (evidenceCount <= 0) failures.push("missing_evidence");
    for (const term of testCase.expectedTerms) {
      if (!claimLower.includes(term.toLowerCase())) failures.push(`missing_claim_term:${term}`);
    }
  } else if (evidenceCount > 0 && finalClaimSource === "project_definition_projection") {
    failures.push("unsupported_unknown_project_answered");
  }
  if (queryTimeModelCalls !== 0) failures.push("query_time_model_calls_nonzero");
  return {
    ...testCase,
    passed: failures.length === 0,
    failures,
    claim,
    finalClaimSource,
    queryContractName: response.meta.queryContractName ?? null,
    retrievalDomain: response.meta.queryContractRetrievalDomain ?? null,
    evidenceCount,
    queryTimeModelCalls,
    latencyMs
  };
}

export async function runProjectDefinitionRetrievalBenchmark(namespaceId = DEFAULT_NAMESPACE): Promise<ProjectDefinitionRetrievalReport> {
  const previousFlag = process.env.BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION;
  process.env.BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION = "1";
  try {
    await seedProjectDefinitionFixture(namespaceId);
    await rebuildContractProjectionsNamespace(namespaceId);
    const stats = await loadProjectionStats(namespaceId);
    const results = await Promise.all(CASES.map((testCase) => runCase(namespaceId, testCase)));
    const sourceBacked = results.filter((result) => result.shouldHaveEvidence);
    const failures = results.flatMap((result) => result.failures.map((failure) => `${result.id}:${failure}`));
    if (stats.evidenceViolations > 0) failures.push("projection_source_evidence_violation");
    if (stats.heads < 3) failures.push("project_definition_projection_heads_missing");
    const latencies = results.map((result) => result.latencyMs);
    return {
      generatedAt: new Date().toISOString(),
      benchmark: "project_definition_retrieval",
      namespaceId,
      passed: failures.length === 0 && rate(sourceBacked.filter((result) => result.passed).length, sourceBacked.length) >= 0.95,
      metrics: {
        caseCount: results.length,
        coverageRate: rate(sourceBacked.filter((result) => result.passed).length, sourceBacked.length),
        projectionHeadCount: stats.heads,
        projectionEntryCount: stats.entries,
        sourceEvidenceViolationCount: stats.evidenceViolations,
        unsupportedNoEvidenceSuccessCount: results.filter((result) => !result.shouldHaveEvidence && result.evidenceCount > 0).length,
        evidenceZeroBackedSuccessCount: results.filter((result) => result.shouldHaveEvidence && result.passed && result.evidenceCount === 0).length,
        queryTimeModelCalls: results.reduce((sum, result) => sum + result.queryTimeModelCalls, 0),
        p50LatencyMs: percentile(latencies, 50),
        p95LatencyMs: percentile(latencies, 95),
        maxLatencyMs: percentile(latencies, 100)
      },
      failures,
      results
    };
  } finally {
    if (previousFlag === undefined) {
      delete process.env.BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION;
    } else {
      process.env.BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION = previousFlag;
    }
  }
}

function markdown(report: ProjectDefinitionRetrievalReport): string {
  return [
    "# Project Definition Retrieval",
    "",
    `- passed: ${report.passed}`,
    `- coverageRate: ${report.metrics.coverageRate}`,
    `- projectionHeadCount: ${report.metrics.projectionHeadCount}`,
    `- sourceEvidenceViolationCount: ${report.metrics.sourceEvidenceViolationCount}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    `- failures: ${report.failures.length === 0 ? "none" : report.failures.join(", ")}`
  ].join("\n");
}

export async function runAndWriteProjectDefinitionRetrievalBenchmark(): Promise<ProjectDefinitionRetrievalReport> {
  const report = await runProjectDefinitionRetrievalBenchmark();
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  await writeFile(path.join(dir, `project-definition-retrieval-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(dir, `project-definition-retrieval-${stamp}.md`), `${markdown(report)}\n`);
  await closePool();
  if (!report.passed) {
    throw new Error(`project-definition-retrieval failed: ${report.failures.join(", ")}`);
  }
  return report;
}

export async function runProjectDefinitionRetrievalCli(): Promise<void> {
  const report = await runAndWriteProjectDefinitionRetrievalBenchmark();
  console.log(JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2));
}
