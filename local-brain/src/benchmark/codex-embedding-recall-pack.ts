import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { projectCodexSessionSpecCoverage } from "../codex-sessions/service.js";
import { resolveQueryEmbedding } from "../retrieval/search/embedding.js";
import { executeMcpTool } from "../mcp/server.js";
import { codexProjectMatchesText, normalizeProjectKey } from "../retrieval/codex-project-aliases.js";
import { buildBenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { payloadEvidenceCount, queryTimeModelCallsFromPayload, rate } from "./query-benchmark-utils.js";

interface EmbeddingScenario {
  readonly id: string;
  readonly namespaceId: string;
  readonly project: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
}

interface CandidateRow {
  readonly id: string;
  readonly memory_kind: string;
  readonly content_abstract: string;
  readonly metadata: Record<string, unknown> | null;
  readonly valid_from: string;
  readonly distance?: number | null;
}

interface CoverageMetrics {
  readonly curatedSemanticEmbeddingCoverage: number;
  readonly rawTranscriptEmbeddingCount: number;
  readonly rawTranscriptRetrievalCount: number;
  readonly vectorSyncFailedCount: number;
}

const SCENARIOS: readonly EmbeddingScenario[] = [
  {
    id: "media_estimated_pricing_kie",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    project: "Media Studio",
    query: "What did Media Studio establish about the estimated-pricing system and KIE pricing boundary?",
    expectedTerms: ["estimated-pricing", "KIE", "pricing"]
  },
  {
    id: "media_duplicate_workflow_tab",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    project: "Media Studio",
    query: "What happened in Media Studio with duplicate New workflow tabs and browser verification?",
    expectedTerms: ["browser", "duplicate", "New workflow"]
  },
  {
    id: "media_kie_onboarding_ci",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    project: "Media Studio",
    query: "What did Media Studio discuss about Kie model onboarding, Suno, and CI verification?",
    expectedTerms: ["Suno", "189 passed", "GitHub Actions"]
  },
  {
    id: "ai_brain_benchmark_hygiene",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    project: "AI Brain",
    query: "What did AI Brain establish about benchmark hygiene and disposable benchmark DBs?",
    expectedTerms: ["benchmark", "scratch", "recreate"]
  },
  {
    id: "ai_brain_duplicate_projection_fix",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    project: "AI Brain",
    query: "Which AI Brain maintenance work fixed repeated candidate rows colliding during projection?",
    expectedTerms: ["duplicate", "memory_candidates", "source_chunk_id"]
  },
  {
    id: "ai_brain_maintenance_artifact_pair",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    project: "AI Brain",
    query: "What did AI Brain discuss after the Codex session maintenance pass created artifacts?",
    expectedTerms: ["maintenance pass", "artifact pair"]
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function queryTerms(queryText: string, project: string): readonly string[] {
  const stop = new Set([
    "what", "which", "when", "where", "does", "did", "the", "and", "for", "about", "with", "that", "this", "work", "past", "codex",
    ...project.toLowerCase().split(/\s+/u)
  ]);
  return [...new Set(queryText.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/gu) ?? [])].filter((term) => !stop.has(term)).slice(0, 12);
}

function expectedTermHits(rows: readonly CandidateRow[], terms: readonly string[]): number {
  const text = rows.map((row) => row.content_abstract).join(" ").toLowerCase();
  return terms.filter((term) => text.includes(term.toLowerCase())).length;
}

function expectedTermHitsInText(value: unknown, terms: readonly string[]): number {
  const text = JSON.stringify(value ?? null).toLowerCase();
  return terms.filter((term) => text.includes(term.toLowerCase())).length;
}

function recallPassed(rows: readonly CandidateRow[], terms: readonly string[]): boolean {
  return expectedTermHits(rows, terms) === terms.length;
}

function projectMatches(row: CandidateRow, project: string): boolean {
  const haystack = [
    typeof row.metadata?.project === "string" ? row.metadata.project : "",
    typeof row.metadata?.repo_path === "string" ? row.metadata.repo_path : "",
    row.content_abstract
  ].join(" ");
  return codexProjectMatchesText(project, haystack);
}

async function loadLexicalRows(scenario: EmbeddingScenario, limit: number): Promise<readonly CandidateRow[]> {
  const terms = queryTerms(scenario.query, scenario.project);
  if (terms.length === 0) return [];
  return queryRows<CandidateRow>(
    `
      SELECT id::text, memory_kind, content_abstract, metadata, valid_from::text, NULL::double precision AS distance
      FROM semantic_memory
      WHERE namespace_id = $1
        AND memory_kind LIKE 'codex_%'
        AND status = 'active'
        AND valid_until IS NULL
        AND (
          regexp_replace(lower(COALESCE(metadata->>'project', '')), '[^a-z0-9]+', '', 'g')
            = $5
          OR lower(COALESCE(metadata->>'repo_path', '')) LIKE '%' || lower($2) || '%'
          OR regexp_replace(lower(COALESCE(metadata->>'repo_path', '')), '[^a-z0-9]+', '', 'g')
            LIKE '%' || $5 || '%'
          OR lower(content_abstract) LIKE '%' || lower($2) || '%'
        )
        AND EXISTS (
          SELECT 1
          FROM unnest($3::text[]) AS term
          WHERE lower(content_abstract) LIKE '%' || term || '%'
        )
      ORDER BY valid_from DESC
      LIMIT $4
    `,
    [scenario.namespaceId, scenario.project, terms, limit, normalizeProjectKey(scenario.project)]
  );
}

async function loadVectorRows(scenario: EmbeddingScenario, embedding: readonly number[], limit: number): Promise<readonly CandidateRow[]> {
  const vectorLiteral = `[${embedding.join(",")}]`;
  return queryRows<CandidateRow>(
    `
      SELECT id::text, memory_kind, content_abstract, metadata, valid_from::text, (embedding <=> $3::vector) AS distance
      FROM semantic_memory
      WHERE namespace_id = $1
        AND memory_kind LIKE 'codex_%'
        AND status = 'active'
        AND valid_until IS NULL
        AND embedding IS NOT NULL
        AND (
          regexp_replace(lower(COALESCE(metadata->>'project', '')), '[^a-z0-9]+', '', 'g')
            = $5
          OR lower(COALESCE(metadata->>'repo_path', '')) LIKE '%' || lower($2) || '%'
          OR regexp_replace(lower(COALESCE(metadata->>'repo_path', '')), '[^a-z0-9]+', '', 'g')
            LIKE '%' || $5 || '%'
          OR lower(content_abstract) LIKE '%' || lower($2) || '%'
        )
      ORDER BY embedding <=> $3::vector ASC, valid_from DESC
      LIMIT $4
    `,
    [scenario.namespaceId, scenario.project, vectorLiteral, limit, normalizeProjectKey(scenario.project)]
  );
}

function mergeRows(left: readonly CandidateRow[], right: readonly CandidateRow[]): readonly CandidateRow[] {
  const seen = new Set<string>();
  const output: CandidateRow[] = [];
  for (const row of [...left, ...right]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    output.push(row);
  }
  return output;
}

async function runScenario(scenario: EmbeddingScenario): Promise<Record<string, unknown>> {
  const lexicalRows = await loadLexicalRows(scenario, 8);
  const embedding = await resolveQueryEmbedding({ namespaceId: scenario.namespaceId, query: scenario.query, limit: 8 });
  const vectorRows = embedding.embedding ? await loadVectorRows(scenario, embedding.embedding, 8) : [];
  const hybridRows = mergeRows(lexicalRows, vectorRows);
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: scenario.namespaceId,
    query: scenario.query,
    detail_mode: "compact",
    limit: 8
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const lexicalRecall = recallPassed(lexicalRows, scenario.expectedTerms);
  const vectorRecall = recallPassed(vectorRows, scenario.expectedTerms);
  const hybridRecall = recallPassed(hybridRows, scenario.expectedTerms);
  const vectorProjectLeakCount = vectorRows.filter((row) => !projectMatches(row, scenario.project)).length;
  const finalClaimSource = String(payload?.finalClaimSource ?? payload?.meta?.finalClaimSource ?? "");
  const finalAnswerExpectedTermHits = expectedTermHitsInText(payload, scenario.expectedTerms);
  return {
    ...scenario,
    lexicalCandidateCount: lexicalRows.length,
    vectorCandidateCount: vectorRows.length,
    hybridCandidateCount: hybridRows.length,
    lexicalExpectedTermHits: expectedTermHits(lexicalRows, scenario.expectedTerms),
    vectorExpectedTermHits: expectedTermHits(vectorRows, scenario.expectedTerms),
    hybridExpectedTermHits: expectedTermHits(hybridRows, scenario.expectedTerms),
    lexicalRecall,
    vectorRecall,
    hybridRecall,
    vectorContribution: vectorRows.length > 0 ? "candidate_pool" : "none",
    vectorProjectLeakCount,
    queryEmbeddingSource: embedding.source,
    queryEmbeddingCacheHit: embedding.cacheHit ?? false,
    queryEmbeddingProviderCallCount: embedding.providerCallCount ?? 0,
    queryEmbeddingFallbackReason: embedding.fallbackReason ?? null,
    finalClaimSource,
    finalAnswerEvidenceCount: payloadEvidenceCount(payload),
    finalAnswerSourceTrailCount: Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0,
    finalAnswerClaimAuditCount: Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0,
    finalAnswerExpectedTermHits,
    finalAnswerExpectedTermCoverage: Number((finalAnswerExpectedTermHits / scenario.expectedTerms.length).toFixed(4)),
    finalAnswerQueryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    vectorAuthoritative: /^vector/iu.test(finalClaimSource) || payload?.meta?.vectorContribution === "final_support",
    passed:
      hybridRecall &&
      vectorProjectLeakCount === 0 &&
      payloadEvidenceCount(payload) > 0 &&
      finalAnswerExpectedTermHits === scenario.expectedTerms.length &&
      queryTimeModelCallsFromPayload(payload) === 0 &&
      !/^vector/iu.test(finalClaimSource) &&
      payload?.meta?.vectorContribution !== "final_support"
  };
}

async function coverageMetrics(): Promise<CoverageMetrics> {
  const namespaceIds = [...new Set(SCENARIOS.map((scenario) => scenario.namespaceId))];
  const projections = await Promise.all(namespaceIds.map((namespaceId) => projectCodexSessionSpecCoverage({ namespaceId })));
  return {
    curatedSemanticEmbeddingCoverage: projections.every((projection) => projection.metrics.codexCuratedEmbeddingCoverage === 1) ? 1 : 0,
    rawTranscriptEmbeddingCount: projections.reduce((sum, projection) => sum + projection.rawTranscriptEmbeddingCount, 0),
    rawTranscriptRetrievalCount: projections.reduce((sum, projection) => sum + projection.rawTranscriptRetrievalCount, 0),
    vectorSyncFailedCount: Number(
      (
        await queryRows<{ readonly count: string }>(
          "SELECT COUNT(*)::text AS count FROM vector_sync_jobs WHERE namespace_id = ANY($1::text[]) AND status = 'failed'",
          [namespaceIds]
        )
      )[0]?.count ?? 0
    )
  };
}

export async function runCodexEmbeddingRecallPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const rows = await Promise.all(SCENARIOS.map(runScenario));
  const coverage = await coverageMetrics();
  const lexicalOnlyRecallRate = rate(rows.filter((row) => row.lexicalRecall === true).length, rows.length);
  const hybridRecallRate = rate(rows.filter((row) => row.hybridRecall === true).length, rows.length);
  const metrics = {
    ...coverage,
    queryCount: rows.length,
    lexicalOnlyRecallRate,
    hybridRecallRate,
    hybridRecallLift: Number((hybridRecallRate - lexicalOnlyRecallRate).toFixed(4)),
    vectorAuthoritativeClaimCount: rows.filter((row) => row.vectorAuthoritative === true).length,
    filterBeforeVectorFinalSelectionRate: rate(rows.filter((row) => Number(row.vectorProjectLeakCount) === 0).length, rows.length),
    vectorContributionRate: rate(rows.filter((row) => Number(row.vectorCandidateCount) > 0).length, rows.length),
    vectorRecallRate: rate(rows.filter((row) => row.vectorRecall === true).length, rows.length),
    vectorUniqueExpectedTermRecoveryCount: rows.filter((row) => row.lexicalRecall !== true && row.hybridRecall === true).length,
    hybridQualityRegressionCount: rows.filter((row) => Number(row.hybridExpectedTermHits) < Number(row.lexicalExpectedTermHits)).length,
    finalAnswerExpectedTermCoverageRate: rate(rows.filter((row) => Number(row.finalAnswerExpectedTermHits) === (row.expectedTerms as readonly string[]).length).length, rows.length),
    wrongProjectCandidateCount: rows.reduce((sum, row) => sum + Number(row.vectorProjectLeakCount ?? 0), 0),
    queryEmbeddingProviderCallCount: rows.reduce((sum, row) => sum + Number(row.queryEmbeddingProviderCallCount ?? 0), 0),
    queryTimeModelCalls: rows.reduce((sum, row) => sum + Number(row.finalAnswerQueryTimeModelCalls ?? 0), 0),
    supportedEmptySourceTrailCount: rows.filter((row) => Number(row.finalAnswerEvidenceCount) > 0 && Number(row.finalAnswerSourceTrailCount) === 0).length,
    supportedMissingClaimAuditCount: rows.filter((row) => Number(row.finalAnswerEvidenceCount) > 0 && Number(row.finalAnswerClaimAuditCount) === 0).length
  };
  const failures = [
    metrics.curatedSemanticEmbeddingCoverage !== 1 ? "embedding_coverage_miss" : "",
    metrics.rawTranscriptEmbeddingCount !== 0 ? "raw_transcript_embedding_detected" : "",
    metrics.rawTranscriptRetrievalCount !== 0 ? "raw_transcript_retrieval_detected" : "",
    metrics.vectorSyncFailedCount !== 0 ? "vector_sync_miss" : "",
    metrics.vectorAuthoritativeClaimCount !== 0 ? "vector_authoritative_claim" : "",
    metrics.filterBeforeVectorFinalSelectionRate !== 1 ? "metadata_filter_order_miss" : "",
    metrics.hybridRecallLift < 0 ? "hybrid_recall_regressed" : "",
    metrics.hybridQualityRegressionCount !== 0 ? "hybrid_term_quality_regressed" : "",
    metrics.finalAnswerExpectedTermCoverageRate !== 1 ? "final_answer_term_coverage_miss" : "",
    metrics.wrongProjectCandidateCount !== 0 ? "wrong_project_vector_candidate" : "",
    rows.some((row) => row.passed !== true) ? "hybrid_recall_quality_below_gate" : "",
    metrics.queryTimeModelCalls !== 0 ? "query_time_model_calls_detected" : "",
    metrics.supportedEmptySourceTrailCount !== 0 ? "empty_source_trail" : "",
    metrics.supportedMissingClaimAuditCount !== 0 ? "missing_claim_audit" : ""
  ].filter(Boolean);
  const report = {
    generatedAt: new Date().toISOString(),
    benchmark: "codex_embedding_recall_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: { namespaces: [...new Set(SCENARIOS.map((scenario) => scenario.namespaceId))].join(",") }
    }),
    rows,
    metrics,
    passed: failures.length === 0,
    failures
  };
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const base = `codex-embedding-recall-pack-${stamp()}`;
  const jsonPath = path.join(dir, `${base}.json`);
  const markdownPath = path.join(dir, `${base}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    [
      "# Codex Embedding Recall Pack",
      "",
      `- passed: ${report.passed}`,
      `- lexicalOnlyRecallRate: ${metrics.lexicalOnlyRecallRate}`,
      `- hybridRecallRate: ${metrics.hybridRecallRate}`,
      `- hybridRecallLift: ${metrics.hybridRecallLift}`,
      `- vectorRecallRate: ${metrics.vectorRecallRate}`,
      `- vectorUniqueExpectedTermRecoveryCount: ${metrics.vectorUniqueExpectedTermRecoveryCount}`,
      `- hybridQualityRegressionCount: ${metrics.hybridQualityRegressionCount}`,
      `- finalAnswerExpectedTermCoverageRate: ${metrics.finalAnswerExpectedTermCoverageRate}`,
      `- curatedSemanticEmbeddingCoverage: ${metrics.curatedSemanticEmbeddingCoverage}`,
      `- vectorSyncFailedCount: ${metrics.vectorSyncFailedCount}`,
      `- vectorAuthoritativeClaimCount: ${metrics.vectorAuthoritativeClaimCount}`,
      `- filterBeforeVectorFinalSelectionRate: ${metrics.filterBeforeVectorFinalSelectionRate}`,
      `- queryTimeModelCalls: ${metrics.queryTimeModelCalls}`,
      "",
      ...rows.map((row: any) => `- ${row.id}: lexical=${row.lexicalRecall} vector=${row.vectorRecall} hybrid=${row.hybridRecall} finalTermCoverage=${row.finalAnswerExpectedTermCoverage} vectorCandidates=${row.vectorCandidateCount} source=${row.queryEmbeddingSource}`)
    ].join("\n") + "\n",
    "utf8"
  );
  return { report, output: { jsonPath, markdownPath } };
}

export async function runCodexEmbeddingRecallPackCli(): Promise<void> {
  try {
    const { report, output } = await runCodexEmbeddingRecallPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
    process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
    if (!report.passed) {
      throw new Error(`codex-embedding-recall-pack failed: ${report.failures.join(", ")}`);
    }
  } finally {
    await closePool();
  }
}
