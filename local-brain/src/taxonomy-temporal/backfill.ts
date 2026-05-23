import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryRows } from "../db/client.js";
import { runTaxonomyTemporalCompiler, persistCompilerRuns } from "./compiler.js";
import type { CompilerRunResult, ExtractionAssistantMode, ValidatedCandidate } from "./types.js";

interface SourceChunkRow {
  readonly chunk_id: string;
  readonly artifact_id: string;
  readonly observation_id: string;
  readonly namespace_id: string;
  readonly source_type: string;
  readonly source_channel: string | null;
  readonly uri: string;
  readonly chunk_index: number;
  readonly char_start: number | null;
  readonly char_end: number | null;
  readonly text_content: string;
  readonly chunk_metadata: Record<string, unknown> | null;
  readonly captured_at: string | null;
  readonly source_memory_id: string | null;
  readonly speaker: string | null;
}

export interface TaxonomyTemporalBackfillOptions {
  readonly namespaceId: string;
  readonly limit?: number;
  readonly sourceType?: string;
  readonly sourceChannel?: string;
  readonly sourceUriContains?: string;
  readonly mode?: ExtractionAssistantMode;
  readonly dryRun?: boolean;
  readonly skipProcessed?: boolean;
  readonly skipGliner2?: boolean;
  readonly latestFirst?: boolean;
  readonly includeBoilerplateChunks?: boolean;
}

export interface TaxonomyTemporalBackfillChunkResult {
  readonly chunkId: string;
  readonly sourceUri: string;
  readonly chunkIndex: number;
  readonly unitCount: number;
  readonly candidateCount: number;
  readonly promotedCount: number;
  readonly rejectedCount: number;
  readonly ambiguousCount: number;
  readonly suggestedTaxonomyCount: number;
  readonly needsClarificationCount: number;
  readonly jsonValid: boolean;
  readonly chunkBudgetPass: boolean;
  readonly taxonomyCompliancePass: boolean;
  readonly temporalNormalizationPass: boolean;
  readonly promotionSafetyPass: boolean;
  readonly llmCalled: boolean;
  readonly llmSkippedReason: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxTotalTokens: number;
  readonly gliner2Error: string | null;
  readonly compilerCacheHits: number;
  readonly compilerCacheMisses: number;
  readonly compilerCacheWrites: number;
  readonly assistantIssueCodes: readonly string[];
  readonly assistantWarnings: readonly string[];
  readonly sampleAcceptedCandidates: readonly TaxonomyTemporalBackfillCandidatePreview[];
  readonly sampleRejectedCandidates: readonly TaxonomyTemporalBackfillCandidatePreview[];
}

export interface TaxonomyTemporalBackfillReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly dryRun: boolean;
  readonly mode: ExtractionAssistantMode | null;
  readonly filters: {
    readonly limit: number | null;
    readonly sourceType: string | null;
    readonly sourceChannel: string | null;
    readonly sourceUriContains: string | null;
    readonly skipProcessed: boolean;
    readonly skipGliner2: boolean;
    readonly latestFirst: boolean;
    readonly includeBoilerplateChunks: boolean;
  };
  readonly summary: {
    readonly chunksSelected: number;
    readonly chunksProcessed: number;
    readonly chunksPersisted: number;
    readonly unitCount: number;
    readonly candidateCount: number;
    readonly promotedCount: number;
    readonly rejectedCount: number;
    readonly ambiguousCount: number;
    readonly suggestedTaxonomyCount: number;
    readonly needsClarificationCount: number;
    readonly jsonValidChunks: number;
    readonly chunkBudgetPassChunks: number;
    readonly taxonomyPassChunks: number;
    readonly temporalPassChunks: number;
    readonly promotionSafetyPassChunks: number;
    readonly llmCalledChunks: number;
    readonly llmSkippedChunks: number;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly maxTotalTokens: number;
    readonly avgInputTokens: number;
    readonly avgOutputTokens: number;
    readonly avgTotalTokens: number;
    readonly gliner2ErrorChunks: number;
    readonly compilerCacheHitChunks: number;
    readonly compilerCacheMissChunks: number;
    readonly compilerCacheWriteChunks: number;
  };
  readonly qualityGate: TaxonomyTemporalBackfillQualityGate;
  readonly persistenceCheck: TaxonomyTemporalBackfillPersistenceCheck | null;
  readonly sampleAcceptedCandidates: readonly TaxonomyTemporalBackfillCandidatePreview[];
  readonly sampleRejectedCandidates: readonly TaxonomyTemporalBackfillCandidatePreview[];
  readonly chunks: readonly TaxonomyTemporalBackfillChunkResult[];
}

export interface TaxonomyTemporalBackfillQualityGate {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly thresholds: {
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly requireLlmForNonOffMode: boolean;
  };
}

export interface TaxonomyTemporalBackfillPersistenceCheck {
  readonly selectedSourceChunkCount: number;
  readonly extractionUnitRows: number;
  readonly assistantRunRows: number;
  readonly compiledFactRows: number;
  readonly coverageRows: number;
  readonly temporalCandidateRows: number;
  readonly missingSourceChunkIds: readonly string[];
}

export interface TaxonomyTemporalBackfillCandidatePreview {
  readonly sourceChunkId: string;
  readonly sourceUri: string;
  readonly chunkIndex: number;
  readonly unitIndex: number;
  readonly promotionEligible: boolean;
  readonly candidateType: string | null;
  readonly objectType: string | null;
  readonly domain: string | null;
  readonly family: string | null;
  readonly subtype: string | null;
  readonly evidenceQuote: string;
  readonly confidence: number | null;
  readonly temporalRawText: string | null;
  readonly temporalGranularity: string | null;
  readonly temporalNeedsClarification: boolean | null;
  readonly promotionRecommendation: string | null;
  readonly taxonomyStatus: string | null;
  readonly issueCodes: readonly string[];
}

function localBrainRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function tokenSum(runs: readonly CompilerRunResult[], field: "inputTokens" | "outputTokens" | "totalTokens"): number {
  return runs.reduce((sum, run) => sum + (run.assistant.tokenUsage?.[field] ?? 0), 0);
}

function tokenMax(runs: readonly CompilerRunResult[], field: "inputTokens" | "outputTokens" | "totalTokens"): number {
  return Math.max(0, ...runs.map((run) => run.assistant.tokenUsage?.[field] ?? 0));
}

function readConfidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

function candidatePreview(
  row: SourceChunkRow,
  run: CompilerRunResult,
  entry: ValidatedCandidate
): TaxonomyTemporalBackfillCandidatePreview {
  return {
    sourceChunkId: row.chunk_id,
    sourceUri: row.uri,
    chunkIndex: row.chunk_index,
    unitIndex: run.unit.unitIndex,
    promotionEligible: entry.promotionEligible,
    candidateType: normalize(entry.candidate.candidate_type) || null,
    objectType: normalize(entry.candidate.object_type) || null,
    domain: normalize(entry.candidate.domain) || null,
    family: normalize(entry.candidate.family) || null,
    subtype: normalize(entry.candidate.subtype) || null,
    evidenceQuote: normalize(entry.candidate.evidence_quote),
    confidence: readConfidence(entry.candidate.confidence?.overall),
    temporalRawText: entry.normalizedTemporal?.rawText ?? null,
    temporalGranularity: entry.normalizedTemporal?.granularity ?? null,
    temporalNeedsClarification: entry.normalizedTemporal?.needsClarification ?? null,
    promotionRecommendation: normalize(entry.candidate.promotion_recommendation) || null,
    taxonomyStatus: normalize(entry.candidate.taxonomy_status) || null,
    issueCodes: entry.issues.map((issue) => issue.code)
  };
}

function chunkResult(row: SourceChunkRow, runs: readonly CompilerRunResult[]): TaxonomyTemporalBackfillChunkResult {
  const entries = runs.flatMap((run) => run.candidates);
  const previews = runs.flatMap((run) => run.candidates.map((entry) => candidatePreview(row, run, entry)));
  const promotedCount = entries.filter((entry) => entry.promotionEligible).length;
  const ambiguousCount = entries.filter((entry) => entry.issues.some((issue) => issue.code.includes("ambiguous"))).length;
  const suggestedTaxonomyCount = runs.reduce((sum, run) => sum + run.metrics.suggestedTaxonomyCount, 0);
  const needsClarificationCount = runs.reduce((sum, run) => sum + run.metrics.needsClarificationCount, 0);
  const llmSkippedReason = runs.find((run) => run.assistant.skippedReason)?.assistant.skippedReason ?? null;
  const assistantIssueCodes = [
    ...new Set(runs.flatMap((run) => run.assistant.validationIssues.map((issue) => issue.code)))
  ];
  const assistantWarnings = [
    ...new Set(runs.flatMap((run) => (run.assistant.output?.warnings ?? []).map((warning) => normalize(warning))).filter(Boolean))
  ].slice(0, 8);
  return {
    chunkId: row.chunk_id,
    sourceUri: row.uri,
    chunkIndex: row.chunk_index,
    unitCount: runs.length,
    candidateCount: entries.length,
    promotedCount,
    rejectedCount: Math.max(0, entries.length - promotedCount - ambiguousCount),
    ambiguousCount,
    suggestedTaxonomyCount,
    needsClarificationCount,
    jsonValid: runs.every((run) => run.metrics.jsonValidityPass),
    chunkBudgetPass: runs.every((run) => run.metrics.chunkBudgetPass),
    taxonomyCompliancePass: runs.every((run) => run.metrics.taxonomyCompliancePass),
    temporalNormalizationPass: runs.every((run) => run.metrics.temporalNormalizationPass),
    promotionSafetyPass: runs.every((run) => run.metrics.promotionSafetyPass),
    llmCalled: runs.some((run) => run.assistant.provider === "openrouter" && !run.assistant.skippedReason),
    llmSkippedReason,
    inputTokens: tokenSum(runs, "inputTokens"),
    outputTokens: tokenSum(runs, "outputTokens"),
    totalTokens: tokenSum(runs, "totalTokens"),
    maxInputTokens: tokenMax(runs, "inputTokens"),
    maxOutputTokens: tokenMax(runs, "outputTokens"),
    maxTotalTokens: tokenMax(runs, "totalTokens"),
    gliner2Error: runs.find((run) => run.gliner2.error)?.gliner2.error ?? null,
    compilerCacheHits: runs.filter((run) => run.cache.status === "hit").length,
    compilerCacheMisses: runs.filter((run) => run.cache.status === "miss").length,
    compilerCacheWrites: runs.filter((run) => run.cache.status === "written").length,
    assistantIssueCodes,
    assistantWarnings,
    sampleAcceptedCandidates: previews.filter((entry) => entry.promotionEligible).slice(0, 5),
    sampleRejectedCandidates: previews.filter((entry) => !entry.promotionEligible).slice(0, 5)
  };
}

async function loadSourceChunks(options: TaxonomyTemporalBackfillOptions): Promise<readonly SourceChunkRow[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 500));
  const latestFirst = options.latestFirst === true;
  return queryRows<SourceChunkRow>(
    `
      WITH processed_units AS (
        SELECT
          unit.namespace_id,
          unit.source_chunk_id
        FROM extraction_units unit
      )
      SELECT
        chunk.id::text AS chunk_id,
        chunk.artifact_id::text AS artifact_id,
        chunk.artifact_observation_id::text AS observation_id,
        artifact.namespace_id,
        artifact.artifact_type AS source_type,
        artifact.source_channel,
        artifact.uri,
        chunk.chunk_index,
        chunk.char_start,
        chunk.char_end,
        chunk.text_content,
        chunk.metadata AS chunk_metadata,
        em.captured_at::text AS captured_at,
        em.id::text AS source_memory_id,
        NULLIF(em.metadata->>'speaker_name', '') AS speaker
      FROM artifact_chunks chunk
      JOIN artifacts artifact ON artifact.id = chunk.artifact_id
      LEFT JOIN episodic_memory em
        ON em.source_chunk_id = chunk.id
       AND em.role = 'import'
      WHERE artifact.namespace_id = $1
        AND ($2::text IS NULL OR artifact.artifact_type = $2)
        AND ($3::text IS NULL OR artifact.source_channel = $3)
        AND ($6::text IS NULL OR artifact.uri ILIKE '%' || $6 || '%')
        AND (
          $8::boolean = true
          OR NOT (
            btrim(chunk.text_content) ~* '^(---[[:space:]]+)?source:[[:space:]]*omi\\b'
            OR btrim(chunk.text_content) ~* '^---[[:space:]]+source:'
            OR btrim(chunk.text_content) ~* '^(---[[:space:]]+)?conversation_id:'
            OR btrim(chunk.text_content) ~* '^##[[:space:]]+(metadata|transcript)[[:space:]]*$'
            OR btrim(chunk.text_content) ~* '^-[[:space:]]+conversation id:'
            OR btrim(chunk.text_content) ~* '^created_at:'
            OR btrim(chunk.text_content) ~* '^started_at:'
            OR btrim(chunk.text_content) ~* '^finished_at:'
          )
        )
        AND (
          $4::boolean = false
          OR NOT EXISTS (
            SELECT 1
            FROM processed_units unit
            WHERE unit.namespace_id = artifact.namespace_id
              AND unit.source_chunk_id = chunk.id
          )
        )
      ORDER BY
        CASE WHEN $7::boolean THEN artifact.created_at END DESC,
        CASE WHEN $7::boolean THEN chunk.chunk_index END ASC,
        CASE WHEN NOT $7::boolean THEN artifact.created_at END ASC,
        CASE WHEN NOT $7::boolean THEN chunk.chunk_index END ASC
      LIMIT $5
    `,
    [
      options.namespaceId,
      options.sourceType ?? null,
      options.sourceChannel ?? null,
      options.skipProcessed !== false,
      limit,
      options.sourceUriContains?.trim() || null,
      latestFirst,
      options.includeBoilerplateChunks === true
    ]
  );
}

function buildQualityGate(
  options: TaxonomyTemporalBackfillOptions,
  summary: TaxonomyTemporalBackfillReport["summary"]
): TaxonomyTemporalBackfillQualityGate {
  const maxInputTokens = 1000;
  const maxOutputTokens = 420;
  const failures: string[] = [];
  const requireLlmForNonOffMode = options.mode !== "off";
  const processed = summary.chunksProcessed;

  if (processed === 0) {
    failures.push("no_chunks_processed");
  }
  if (summary.jsonValidChunks !== processed) {
    failures.push("json_invalid_chunks");
  }
  if (summary.chunkBudgetPassChunks !== processed) {
    failures.push("chunk_budget_failures");
  }
  if (summary.taxonomyPassChunks !== processed) {
    failures.push("taxonomy_failures");
  }
  if (summary.temporalPassChunks !== processed) {
    failures.push("temporal_failures");
  }
  if (summary.promotionSafetyPassChunks !== processed) {
    failures.push("promotion_safety_failures");
  }
  if (summary.gliner2ErrorChunks > 0) {
    failures.push("gliner2_errors");
  }
  if (summary.maxInputTokens > maxInputTokens) {
    failures.push("input_token_budget_exceeded");
  }
  if (summary.maxOutputTokens > maxOutputTokens) {
    failures.push("output_token_budget_exceeded");
  }
  if (requireLlmForNonOffMode && summary.llmCalledChunks !== processed) {
    failures.push("llm_not_called_for_all_chunks");
  }

  return {
    passed: failures.length === 0,
    failures,
    thresholds: {
      maxInputTokens,
      maxOutputTokens,
      requireLlmForNonOffMode
    }
  };
}

async function persistenceCheck(
  namespaceId: string,
  chunks: readonly TaxonomyTemporalBackfillChunkResult[]
): Promise<TaxonomyTemporalBackfillPersistenceCheck> {
  const chunkIds = chunks.map((chunk) => chunk.chunkId);
  if (chunkIds.length === 0) {
    return {
      selectedSourceChunkCount: 0,
      extractionUnitRows: 0,
      assistantRunRows: 0,
      compiledFactRows: 0,
      coverageRows: 0,
      temporalCandidateRows: 0,
      missingSourceChunkIds: []
    };
  }

  const [counts] = await queryRows<{
    readonly extraction_unit_rows: number;
    readonly assistant_run_rows: number;
    readonly compiled_fact_rows: number;
    readonly coverage_rows: number;
    readonly temporal_candidate_rows: number;
  }>(
    `
      WITH unit_rows AS (
        SELECT id, source_chunk_id
        FROM extraction_units
        WHERE namespace_id = $1
          AND source_chunk_id = ANY($2::uuid[])
      )
      SELECT
        (SELECT COUNT(*)::int FROM unit_rows) AS extraction_unit_rows,
        (
          SELECT COUNT(*)::int
          FROM extraction_assistant_runs run
          JOIN unit_rows unit ON unit.id = run.extraction_unit_id
        ) AS assistant_run_rows,
        (
          SELECT COUNT(*)::int
          FROM compiled_fact_observations fact
          JOIN unit_rows unit ON unit.id = fact.source_row_id
          WHERE fact.source_table = 'extraction_units'
        ) AS compiled_fact_rows,
        (
          SELECT COUNT(*)::int
          FROM compiled_memory_coverage coverage
          JOIN unit_rows unit ON unit.id = coverage.source_row_id
          WHERE coverage.source_table = 'extraction_units'
        ) AS coverage_rows,
        (
          SELECT COUNT(*)::int
          FROM temporal_resolution_candidates temporal
          JOIN unit_rows unit ON unit.id = temporal.extraction_unit_id
        ) AS temporal_candidate_rows
    `,
    [namespaceId, chunkIds]
  );

  const presentRows = await queryRows<{ readonly source_chunk_id: string }>(
    `
      SELECT DISTINCT source_chunk_id::text
      FROM extraction_units
      WHERE namespace_id = $1
        AND source_chunk_id = ANY($2::uuid[])
    `,
    [namespaceId, chunkIds]
  );
  const present = new Set(presentRows.map((row) => row.source_chunk_id));

  return {
    selectedSourceChunkCount: chunkIds.length,
    extractionUnitRows: counts?.extraction_unit_rows ?? 0,
    assistantRunRows: counts?.assistant_run_rows ?? 0,
    compiledFactRows: counts?.compiled_fact_rows ?? 0,
    coverageRows: counts?.coverage_rows ?? 0,
    temporalCandidateRows: counts?.temporal_candidate_rows ?? 0,
    missingSourceChunkIds: chunkIds.filter((chunkId) => !present.has(chunkId))
  };
}

function summarize(
  options: TaxonomyTemporalBackfillOptions,
  selectedCount: number,
  chunks: readonly TaxonomyTemporalBackfillChunkResult[],
  persisted: TaxonomyTemporalBackfillPersistenceCheck | null
): TaxonomyTemporalBackfillReport {
  const totalInputTokens = chunks.reduce((sum, chunk) => sum + chunk.inputTokens, 0);
  const totalOutputTokens = chunks.reduce((sum, chunk) => sum + chunk.outputTokens, 0);
  const totalTokens = chunks.reduce((sum, chunk) => sum + chunk.totalTokens, 0);
  const processedCount = Math.max(1, chunks.length);
  const summary = {
    chunksSelected: selectedCount,
    chunksProcessed: chunks.length,
    chunksPersisted: options.dryRun === true ? 0 : chunks.length,
    unitCount: chunks.reduce((sum, chunk) => sum + chunk.unitCount, 0),
    candidateCount: chunks.reduce((sum, chunk) => sum + chunk.candidateCount, 0),
    promotedCount: chunks.reduce((sum, chunk) => sum + chunk.promotedCount, 0),
    rejectedCount: chunks.reduce((sum, chunk) => sum + chunk.rejectedCount, 0),
    ambiguousCount: chunks.reduce((sum, chunk) => sum + chunk.ambiguousCount, 0),
    suggestedTaxonomyCount: chunks.reduce((sum, chunk) => sum + chunk.suggestedTaxonomyCount, 0),
    needsClarificationCount: chunks.reduce((sum, chunk) => sum + chunk.needsClarificationCount, 0),
    jsonValidChunks: chunks.filter((chunk) => chunk.jsonValid).length,
    chunkBudgetPassChunks: chunks.filter((chunk) => chunk.chunkBudgetPass).length,
    taxonomyPassChunks: chunks.filter((chunk) => chunk.taxonomyCompliancePass).length,
    temporalPassChunks: chunks.filter((chunk) => chunk.temporalNormalizationPass).length,
    promotionSafetyPassChunks: chunks.filter((chunk) => chunk.promotionSafetyPass).length,
    llmCalledChunks: chunks.filter((chunk) => chunk.llmCalled).length,
    llmSkippedChunks: chunks.filter((chunk) => chunk.llmSkippedReason).length,
    maxInputTokens: Math.max(0, ...chunks.map((chunk) => chunk.maxInputTokens)),
    maxOutputTokens: Math.max(0, ...chunks.map((chunk) => chunk.maxOutputTokens)),
    maxTotalTokens: Math.max(0, ...chunks.map((chunk) => chunk.maxTotalTokens)),
    avgInputTokens: Math.round(totalInputTokens / processedCount),
    avgOutputTokens: Math.round(totalOutputTokens / processedCount),
    avgTotalTokens: Math.round(totalTokens / processedCount),
    gliner2ErrorChunks: chunks.filter((chunk) => chunk.gliner2Error).length,
    compilerCacheHitChunks: chunks.filter((chunk) => chunk.compilerCacheHits > 0).length,
    compilerCacheMissChunks: chunks.filter((chunk) => chunk.compilerCacheMisses > 0).length,
    compilerCacheWriteChunks: chunks.filter((chunk) => chunk.compilerCacheWrites > 0).length
  };
  return {
    generatedAt: new Date().toISOString(),
    namespaceId: options.namespaceId,
    dryRun: options.dryRun === true,
    mode: options.mode ?? null,
    filters: {
      limit: options.limit ?? null,
      sourceType: options.sourceType ?? null,
      sourceChannel: options.sourceChannel ?? null,
      sourceUriContains: options.sourceUriContains?.trim() || null,
      skipProcessed: options.skipProcessed !== false,
      skipGliner2: options.skipGliner2 === true,
      latestFirst: options.latestFirst === true,
      includeBoilerplateChunks: options.includeBoilerplateChunks === true
    },
    summary,
    qualityGate: buildQualityGate(options, summary),
    persistenceCheck: persisted,
    sampleAcceptedCandidates: chunks.flatMap((chunk) => chunk.sampleAcceptedCandidates).slice(0, 20),
    sampleRejectedCandidates: chunks.flatMap((chunk) => chunk.sampleRejectedCandidates).slice(0, 20),
    chunks
  };
}

export async function runTaxonomyTemporalBackfill(options: TaxonomyTemporalBackfillOptions): Promise<TaxonomyTemporalBackfillReport> {
  const rows = await loadSourceChunks(options);
  const chunkResults: TaxonomyTemporalBackfillChunkResult[] = [];

  for (const row of rows) {
    const text = normalize(row.text_content);
    if (!text) {
      continue;
    }
    const runs = await runTaxonomyTemporalCompiler(
      {
        namespaceId: row.namespace_id,
        sourceType: row.source_type,
        sourceId: row.artifact_id,
        sourceMemoryId: row.source_memory_id,
        sourceChunkId: row.chunk_id,
        capturedAt: row.captured_at,
        speaker: row.speaker,
        text,
        metadata: {
          backfill_source: "taxonomy_temporal_backfill",
          source_uri: row.uri,
          source_channel: row.source_channel,
          artifact_observation_id: row.observation_id,
          chunk_index: row.chunk_index,
          char_start: row.char_start,
          char_end: row.char_end,
          chunk_metadata: row.chunk_metadata ?? {}
        }
      },
      {
        mode: options.mode,
        skipGliner2: options.skipGliner2,
        writePersistentCache: options.dryRun !== true
      }
    );
    if (options.dryRun !== true) {
      await persistCompilerRuns(row.namespace_id, runs);
    }
    chunkResults.push(chunkResult(row, runs));
  }

  const persisted = options.dryRun === true ? null : await persistenceCheck(options.namespaceId, chunkResults);
  return summarize(options, rows.length, chunkResults, persisted);
}

export async function writeTaxonomyTemporalBackfillReport(report: TaxonomyTemporalBackfillReport): Promise<string> {
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `taxonomy-temporal-backfill-${stamp}.json`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return jsonPath;
}
