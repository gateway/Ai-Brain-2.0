import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { QueryResultRow } from "pg";
import { closePool, queryRows } from "../db/client.js";
import {
  ASSISTANT_INPUT_SCHEMA_VERSION,
  ASSISTANT_OUTPUT_SCHEMA_VERSION,
  ASSISTANT_PROMPT_VERSION,
  buildAssistantInput
} from "../taxonomy-temporal/assistant.js";
import { loadMemoryTaxonomyRegistry } from "../taxonomy-temporal/registry.js";
import type { ExtractionUnit } from "../taxonomy-temporal/types.js";

type JsonRecord = Record<string, unknown>;

interface AssistantRunRow extends QueryResultRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly provider: string;
  readonly model_id: string | null;
  readonly taxonomy_version: string;
  readonly schema_version: string;
  readonly prompt_version: string;
  readonly input_chars: number;
  readonly output_chars: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly total_tokens: number | null;
  readonly latency_ms: number | null;
  readonly json_valid: boolean;
  readonly validation_status: string;
  readonly rejection_reason: string | null;
  readonly response_payload: JsonRecord | null;
  readonly source_type: string | null;
  readonly source_id: string | null;
  readonly source_chunk_id: string | null;
  readonly unit_text: string | null;
  readonly unit_token_estimate: number | null;
  readonly created_at: string;
}

interface ExtractionUnitRow extends QueryResultRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly source_type: string;
  readonly source_id: string | null;
  readonly source_memory_id: string | null;
  readonly source_chunk_id: string | null;
  readonly source_scene_id: string | null;
  readonly captured_at: string | null;
  readonly speaker: string | null;
  readonly unit_index: number;
  readonly char_start: number | null;
  readonly char_end: number | null;
  readonly unit_text: string;
  readonly context_before: string | null;
  readonly context_after: string | null;
  readonly token_estimate: number;
  readonly chunking_status: "ready" | "needs_split_review" | "empty" | "oversized";
  readonly split_reason: string | null;
  readonly metadata: JsonRecord | null;
}

interface ArtifactInfo {
  readonly path: string;
  readonly payload: JsonRecord;
}

interface HybridTokenEfficiencyReport {
  readonly generatedAt: string;
  readonly benchmark: "hybrid_token_efficiency_profile";
  readonly passed: boolean;
  readonly thresholds: {
    readonly assistantOutputP95Tokens: number;
    readonly assistantOutputMaxTokens: number;
    readonly assistantInputP95Tokens: number;
    readonly assistantInputMaxTokens: number;
    readonly extractionUnitTokenMax: number;
    readonly jsonValidityRate: number;
    readonly promotionWithoutEvidenceQuote: number;
    readonly unknownTaxonomyPromoted: number;
    readonly mixedOwnerPromoted: number;
    readonly queryTimeModelCalls: number;
    readonly warmModelRerunRate: number;
  };
  readonly metrics: {
    readonly assistantPromptVersion: string;
    readonly assistantInputSchemaVersion: string;
    readonly assistantOutputSchemaVersion: string;
    readonly assistantRunCount: number;
    readonly assistantCurrentPromptRunCount: number;
    readonly assistantRunsUsedScope: "current_prompt" | "latest_available" | "artifact_only";
    readonly assistantCallCount: number;
    readonly deterministicSkipCount: number;
    readonly jsonValidCount: number;
    readonly jsonValidityRate: number;
    readonly inputTokens: TokenStats;
    readonly outputTokens: TokenStats;
    readonly totalTokens: TokenStats;
    readonly packetV2EstimatedInputTokens: TokenStats;
    readonly extractionUnitTokens: TokenStats;
    readonly usefulCandidateYield: number;
    readonly promotionWithoutEvidenceQuote: number;
    readonly legacyGlobalPromotionWithoutEvidenceQuote: number;
    readonly unknownTaxonomyPromoted: number;
    readonly mixedOwnerPromoted: number;
    readonly queryTimeModelCalls: number;
    readonly compilerWarmCacheHitRate: number | null;
    readonly compilerWarmModelRerunRate: number | null;
    readonly gliner2JobsSkipped: number | null;
    readonly assistantJobsSkipped: number | null;
    readonly sourceTypeBreakdown: Record<string, SourceTypeStats>;
    readonly promptVersionBreakdown: Record<string, number>;
    readonly modelBreakdown: Record<string, number>;
  };
  readonly topExpensiveChunks: readonly ExpensiveChunk[];
  readonly latestArtifacts: Record<string, string | null>;
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
}

interface TokenStats {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

interface SourceTypeStats {
  readonly runCount: number;
  readonly assistantCallCount: number;
  readonly deterministicSkipCount: number;
  readonly inputP95: number;
  readonly outputP95: number;
  readonly packetEstimatedInputP95: number;
}

interface ExpensiveChunk {
  readonly namespaceId: string;
  readonly sourceType: string;
  readonly sourceId: string | null;
  readonly sourceChunkId: string | null;
  readonly promptVersion: string | null;
  readonly modelId: string | null;
  readonly provider: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly usefulCandidateCount: number;
  readonly jsonValid: boolean | null;
  readonly skippedReason: string | null;
  readonly textPreview: string;
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

function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

function tokenStats(values: readonly number[]): TokenStats {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { count: 0, p50: 0, p95: 0, max: 0 };
  }
  const percentile = (p: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index] ?? 0;
  };
  return {
    count: sorted.length,
    p50: percentile(50),
    p95: percentile(95),
    max: sorted[sorted.length - 1] ?? 0
  };
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 1;
  }
  return Number((numerator / denominator).toFixed(4));
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function arrayCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function usefulCandidateCount(payload: JsonRecord | null): number {
  return arrayCount(payload?.candidates);
}

function skippedReason(row: AssistantRunRow): string | null {
  const payload = asRecord(row.response_payload);
  const warnings = Array.isArray(payload?.warnings) ? payload.warnings.map(String) : [];
  if (row.provider === "deterministic" && warnings.includes("deterministic_structured_surface_sufficient")) {
    return "deterministic_structured_surface_sufficient";
  }
  return row.rejection_reason;
}

async function safeQueryRows<T extends QueryResultRow>(sql: string, values: readonly unknown[] = []): Promise<readonly T[]> {
  try {
    return await queryRows<T>(sql, values);
  } catch {
    return [];
  }
}

async function loadAssistantRows(): Promise<readonly AssistantRunRow[]> {
  return safeQueryRows<AssistantRunRow>(
    `
      SELECT
        run.id::text,
        run.namespace_id,
        run.provider,
        run.model_id,
        run.taxonomy_version,
        run.schema_version,
        run.prompt_version,
        run.input_chars,
        run.output_chars,
        run.input_tokens,
        run.output_tokens,
        run.total_tokens,
        run.latency_ms,
        run.json_valid,
        run.validation_status,
        run.rejection_reason,
        run.response_payload,
        unit.source_type,
        unit.source_id,
        unit.source_chunk_id::text,
        unit.unit_text,
        unit.token_estimate AS unit_token_estimate,
        run.created_at::text
      FROM extraction_assistant_runs run
      LEFT JOIN extraction_units unit
        ON unit.id = run.extraction_unit_id
      ORDER BY run.created_at DESC
      LIMIT 5000
    `
  );
}

async function loadExtractionUnits(): Promise<readonly ExtractionUnitRow[]> {
  return safeQueryRows<ExtractionUnitRow>(
    `
      SELECT
        id::text,
        namespace_id,
        source_type,
        source_id,
        source_memory_id::text,
        source_chunk_id::text,
        source_scene_id::text,
        captured_at::text,
        speaker,
        unit_index,
        char_start,
        char_end,
        unit_text,
        context_before,
        context_after,
        token_estimate,
        chunking_status,
        split_reason,
        metadata
      FROM extraction_units
      ORDER BY created_at DESC
      LIMIT 5000
    `
  );
}

async function loadPromotionCounters(): Promise<{
  readonly promotionWithoutEvidenceQuote: number;
  readonly legacyGlobalPromotionWithoutEvidenceQuote: number;
  readonly unknownTaxonomyPromoted: number;
  readonly mixedOwnerPromoted: number;
}> {
  const rows = await safeQueryRows<{
    readonly promotion_without_evidence_quote: string;
    readonly legacy_global_promotion_without_evidence_quote: string;
    readonly unknown_taxonomy_promoted: string;
    readonly mixed_owner_promoted: string;
  }>(
    `
      SELECT
        COUNT(*) FILTER (
          WHERE promotion_status = 'compiled'
            AND (
              model_id = 'typed_memory_direct_fact_compiler'
              OR predicate_family IN ('direct_fact', 'profile_trait', 'profile_inference')
              OR property_key LIKE 'direct_fact:%'
              OR property_key LIKE 'trait:%'
              OR property_key LIKE 'inference:%'
            )
            AND NULLIF(BTRIM(COALESCE(support_phrase, '')), '') IS NULL
        )::text AS promotion_without_evidence_quote,
        COUNT(*) FILTER (
          WHERE promotion_status = 'compiled'
            AND NULLIF(BTRIM(COALESCE(support_phrase, '')), '') IS NULL
        )::text AS legacy_global_promotion_without_evidence_quote,
        COUNT(*) FILTER (
          WHERE promotion_status = 'compiled'
            AND (
              metadata->>'taxonomyStatus' IN ('needs_taxonomy_review', 'diagnostic_only', 'unsupported')
              OR metadata->>'taxonomy_status' IN ('needs_taxonomy_review', 'diagnostic_only', 'unsupported')
              OR metadata->>'taxonomy_status' = 'unknown'
            )
        )::text AS unknown_taxonomy_promoted,
        COUNT(*) FILTER (
          WHERE promotion_status = 'compiled'
            AND lower(metadata::text) LIKE '%mixed_owner%'
        )::text AS mixed_owner_promoted
      FROM compiled_fact_observations
    `
  );
  return {
    promotionWithoutEvidenceQuote: Number(rows[0]?.promotion_without_evidence_quote ?? "0"),
    legacyGlobalPromotionWithoutEvidenceQuote: Number(rows[0]?.legacy_global_promotion_without_evidence_quote ?? "0"),
    unknownTaxonomyPromoted: Number(rows[0]?.unknown_taxonomy_promoted ?? "0"),
    mixedOwnerPromoted: Number(rows[0]?.mixed_owner_promoted ?? "0")
  };
}

async function latestArtifact(prefix: string | RegExp): Promise<ArtifactInfo | null> {
  const dir = outputDir();
  try {
    const entries = await readdir(dir);
    const candidates = entries
      .filter((entry) =>
        typeof prefix === "string" ? entry.startsWith(prefix) && entry.endsWith(".json") : prefix.test(entry)
      )
      .sort()
      .reverse();
    for (const entry of candidates) {
      const artifactPath = path.join(dir, entry);
      try {
        const payload = JSON.parse(await readFile(artifactPath, "utf8")) as JsonRecord;
        return { path: artifactPath, payload };
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function countQueryTimeModelCalls(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + countQueryTimeModelCalls(entry), 0);
  }
  const record = asRecord(value);
  if (!record) {
    return 0;
  }
  let count = 0;
  if (record.queryTimeGLiNEROrLLMUsed === true || record.queryTimeGlinerOrLlmUsed === true) {
    count += 1;
  }
  if (typeof record.queryTimeModelCalls === "number" && Number.isFinite(record.queryTimeModelCalls)) {
    count += record.queryTimeModelCalls;
  }
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") {
      count += countQueryTimeModelCalls(child);
    }
  }
  return count;
}

function toExtractionUnit(row: ExtractionUnitRow): ExtractionUnit {
  return {
    unitId: row.id,
    namespaceId: row.namespace_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceMemoryId: row.source_memory_id,
    sourceChunkId: row.source_chunk_id,
    sourceSceneId: row.source_scene_id,
    capturedAt: row.captured_at,
    speaker: row.speaker,
    unitIndex: row.unit_index,
    charStart: row.char_start ?? 0,
    charEnd: row.char_end ?? row.unit_text.length,
    unitText: row.unit_text,
    contextBefore: row.context_before ?? "",
    contextAfter: row.context_after ?? "",
    tokenEstimate: row.token_estimate,
    chunkingStatus: row.chunking_status,
    splitReason: row.split_reason ?? "",
    metadata: row.metadata ?? {}
  };
}

async function packetEstimatesByUnit(units: readonly ExtractionUnitRow[]): Promise<Map<string, number>> {
  const registry = await loadMemoryTaxonomyRegistry();
  const estimates = new Map<string, number>();
  for (const row of units) {
    const packet = buildAssistantInput({
      registry,
      unit: toExtractionUnit(row),
      gliner2Candidates: {}
    });
    estimates.set(row.id, estimateTokensFromChars(JSON.stringify(packet).length));
  }
  return estimates;
}

function artifactNumber(payload: JsonRecord | null, pathKeys: readonly string[]): number | null {
  let current: unknown = payload;
  for (const key of pathKeys) {
    const record = asRecord(current);
    if (!record) {
      return null;
    }
    current = record[key];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function sourceStats(rows: readonly AssistantRunRow[], packetEstimates: readonly number[]): Record<string, SourceTypeStats> {
  const bySourceType = new Map<string, { rows: AssistantRunRow[]; packets: number[] }>();
  for (const [index, row] of rows.entries()) {
    const key = row.source_type ?? "unknown";
    const entry = bySourceType.get(key) ?? { rows: [], packets: [] };
    entry.rows.push(row);
    entry.packets.push(packetEstimates[index] ?? 0);
    bySourceType.set(key, entry);
  }
  return Object.fromEntries(
    [...bySourceType.entries()].map(([sourceType, entry]) => [
      sourceType,
      {
        runCount: entry.rows.length,
        assistantCallCount: entry.rows.filter((row) => row.provider === "openrouter").length,
        deterministicSkipCount: entry.rows.filter((row) => row.provider === "deterministic").length,
        inputP95: tokenStats(entry.rows.map((row) => row.input_tokens ?? estimateTokensFromChars(row.input_chars))).p95,
        outputP95: tokenStats(entry.rows.map((row) => row.output_tokens ?? estimateTokensFromChars(row.output_chars))).p95,
        packetEstimatedInputP95: tokenStats(entry.packets).p95
      }
    ])
  );
}

function countBy<T>(values: readonly T[], key: (value: T) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const name = key(value);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export async function runHybridTokenEfficiencyProfile(): Promise<HybridTokenEfficiencyReport> {
  const [assistantRows, extractionUnits, promotionCounters, compilerCache, taxonomyMini, productionReadiness, locomoRc] = await Promise.all([
    loadAssistantRows(),
    loadExtractionUnits(),
    loadPromotionCounters(),
    latestArtifact("compiler-cache-profile-"),
    latestArtifact("taxonomy-temporal-assistant-mini-"),
    latestArtifact("production-readiness-"),
    latestArtifact(/^locomo-\d{4}-\d{2}-\d{2}T(?!.*\.partial).*\.json$/u)
  ]);
  const currentPromptRows = assistantRows.filter((row) => row.prompt_version === ASSISTANT_PROMPT_VERSION);
  const rowsUsed = currentPromptRows.length > 0 ? currentPromptRows : assistantRows;
  const runsUsedScope =
    currentPromptRows.length > 0 ? "current_prompt" : rowsUsed.length > 0 ? "latest_available" : "artifact_only";
  const extractionUnitStats = tokenStats(extractionUnits.map((row) => row.token_estimate));
  const packetEstimateMap = await packetEstimatesByUnit(extractionUnits);
  const packetEstimateValues = [...packetEstimateMap.values()];
  const packetStats = tokenStats(packetEstimateValues);
  const inputValues = rowsUsed.map((row) => row.input_tokens ?? estimateTokensFromChars(row.input_chars));
  const outputValues = rowsUsed.map((row) => row.output_tokens ?? estimateTokensFromChars(row.output_chars));
  const totalValues = rowsUsed.map((row) => row.total_tokens ?? inputValues[rowsUsed.indexOf(row)] + outputValues[rowsUsed.indexOf(row)]);
  const inputStats = tokenStats(inputValues);
  const outputStats = tokenStats(outputValues);
  const totalStats = tokenStats(totalValues);
  const jsonValidCount = rowsUsed.filter((row) => row.json_valid).length;
  const latestPayloads = [productionReadiness?.payload, locomoRc?.payload].filter(Boolean);
  const queryTimeModelCalls = latestPayloads.reduce((sum, payload) => sum + countQueryTimeModelCalls(payload), 0);
  const compilerWarmCacheHitRate = artifactNumber(compilerCache?.payload ?? null, ["metrics", "warmCacheHitRate"]);
  const compilerWarmModelRerunRate = artifactNumber(compilerCache?.payload ?? null, ["metrics", "warmModelRerunRate"]);
  const gliner2JobsSkipped = artifactNumber(compilerCache?.payload ?? null, ["metrics", "gliner2JobsSkipped"]);
  const assistantJobsSkipped = artifactNumber(compilerCache?.payload ?? null, ["metrics", "assistantJobsSkipped"]);
  const miniSummary = asRecord(taxonomyMini?.payload.summary);
  const artifactInputMax = typeof miniSummary?.maxInputTokens === "number" ? miniSummary.maxInputTokens : null;
  const artifactOutputMax = typeof miniSummary?.maxOutputTokens === "number" ? miniSummary.maxOutputTokens : null;
  const artifactTotalMax = typeof miniSummary?.maxTotalTokens === "number" ? miniSummary.maxTotalTokens : null;
  const currentPromptRowsAvailable = currentPromptRows.length > 0;
  const effectiveInputStats =
    currentPromptRowsAvailable && inputStats.count > 0 ? inputStats : tokenStats(artifactInputMax !== null ? [artifactInputMax] : []);
  const effectiveOutputStats =
    currentPromptRowsAvailable && outputStats.count > 0 ? outputStats : tokenStats(artifactOutputMax !== null ? [artifactOutputMax] : []);
  const effectiveTotalStats =
    currentPromptRowsAvailable && totalStats.count > 0 ? totalStats : tokenStats(artifactTotalMax !== null ? [artifactTotalMax] : []);
  const rowsPacketEstimates = rowsUsed.map((row) => {
    const matched = extractionUnits.find((unit) => unit.source_id === row.source_id && unit.source_type === row.source_type);
    return matched ? packetEstimateMap.get(matched.id) ?? 0 : 0;
  });
  const topExpensiveChunks = rowsUsed
    .map((row, index): ExpensiveChunk => {
      const inputTokens = inputValues[index] ?? 0;
      const outputTokens = outputValues[index] ?? 0;
      const totalTokens = totalValues[index] ?? inputTokens + outputTokens;
      return {
        namespaceId: row.namespace_id,
        sourceType: row.source_type ?? "unknown",
        sourceId: row.source_id,
        sourceChunkId: row.source_chunk_id,
        promptVersion: row.prompt_version,
        modelId: row.model_id,
        provider: row.provider,
        inputTokens,
        outputTokens,
        totalTokens,
        usefulCandidateCount: usefulCandidateCount(row.response_payload),
        jsonValid: row.json_valid,
        skippedReason: skippedReason(row),
        textPreview: normalize(row.unit_text).slice(0, 180)
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 20);
  const thresholds = {
    assistantOutputP95Tokens: 350,
    assistantOutputMaxTokens: 450,
    assistantInputP95Tokens: 950,
    assistantInputMaxTokens: 1500,
    extractionUnitTokenMax: 1800,
    jsonValidityRate: 1,
    promotionWithoutEvidenceQuote: 0,
    unknownTaxonomyPromoted: 0,
    mixedOwnerPromoted: 0,
    queryTimeModelCalls: 0,
    warmModelRerunRate: 0
  };
  const failures: string[] = [];
  const warnings: string[] = [];
  if (runsUsedScope !== "current_prompt") {
    warnings.push("current_prompt_assistant_rows_missing");
  }
  if (effectiveOutputStats.p95 > thresholds.assistantOutputP95Tokens) failures.push("assistant_output_p95_tokens_above_threshold");
  if (effectiveOutputStats.max > thresholds.assistantOutputMaxTokens) failures.push("assistant_output_max_tokens_above_threshold");
  if (effectiveInputStats.p95 > thresholds.assistantInputP95Tokens) failures.push("assistant_input_p95_tokens_above_threshold");
  if (effectiveInputStats.max > thresholds.assistantInputMaxTokens) failures.push("assistant_input_max_tokens_above_threshold");
  if (extractionUnitStats.max > thresholds.extractionUnitTokenMax) failures.push("extraction_unit_token_max_above_threshold");
  const jsonValidityRate = rate(jsonValidCount, rowsUsed.length);
  if (jsonValidityRate < thresholds.jsonValidityRate) failures.push("json_validity_below_threshold");
  if (promotionCounters.promotionWithoutEvidenceQuote !== 0) failures.push("promotion_without_evidence_quote");
  if (promotionCounters.unknownTaxonomyPromoted !== 0) failures.push("unknown_taxonomy_promoted");
  if (promotionCounters.mixedOwnerPromoted !== 0) failures.push("mixed_owner_promoted");
  if (queryTimeModelCalls !== 0) failures.push("query_time_model_calls_detected");
  if (compilerWarmModelRerunRate !== null && compilerWarmModelRerunRate > thresholds.warmModelRerunRate) {
    failures.push("warm_model_rerun_rate_above_threshold");
  }
  if (rowsUsed.length === 0 && artifactOutputMax === null) {
    failures.push("assistant_token_samples_missing");
  }

  return {
    generatedAt: new Date().toISOString(),
    benchmark: "hybrid_token_efficiency_profile",
    passed: failures.length === 0,
    thresholds,
    metrics: {
      assistantPromptVersion: ASSISTANT_PROMPT_VERSION,
      assistantInputSchemaVersion: ASSISTANT_INPUT_SCHEMA_VERSION,
      assistantOutputSchemaVersion: ASSISTANT_OUTPUT_SCHEMA_VERSION,
      assistantRunCount: assistantRows.length,
      assistantCurrentPromptRunCount: currentPromptRows.length,
      assistantRunsUsedScope: runsUsedScope,
      assistantCallCount: rowsUsed.filter((row) => row.provider === "openrouter").length,
      deterministicSkipCount: rowsUsed.filter((row) => row.provider === "deterministic").length,
      jsonValidCount,
      jsonValidityRate,
      inputTokens: effectiveInputStats,
      outputTokens: effectiveOutputStats,
      totalTokens: effectiveTotalStats,
      packetV2EstimatedInputTokens: packetStats,
      extractionUnitTokens: extractionUnitStats,
      usefulCandidateYield: rate(rowsUsed.reduce((sum, row) => sum + usefulCandidateCount(row.response_payload), 0), rowsUsed.length),
      promotionWithoutEvidenceQuote: promotionCounters.promotionWithoutEvidenceQuote,
      legacyGlobalPromotionWithoutEvidenceQuote: promotionCounters.legacyGlobalPromotionWithoutEvidenceQuote,
      unknownTaxonomyPromoted: promotionCounters.unknownTaxonomyPromoted,
      mixedOwnerPromoted: promotionCounters.mixedOwnerPromoted,
      queryTimeModelCalls,
      compilerWarmCacheHitRate,
      compilerWarmModelRerunRate,
      gliner2JobsSkipped,
      assistantJobsSkipped,
      sourceTypeBreakdown: sourceStats(rowsUsed, rowsPacketEstimates),
      promptVersionBreakdown: countBy(rowsUsed, (row) => row.prompt_version),
      modelBreakdown: countBy(rowsUsed, (row) => row.model_id ?? row.provider)
    },
    topExpensiveChunks,
    latestArtifacts: {
      compilerCacheProfile: compilerCache?.path ?? null,
      taxonomyTemporalAssistantMini: taxonomyMini?.path ?? null,
      productionReadiness: productionReadiness?.path ?? null,
      locomo: locomoRc?.path ?? null
    },
    failures,
    warnings
  };
}

export async function runAndWriteHybridTokenEfficiencyProfile(): Promise<{
  readonly report: HybridTokenEfficiencyReport;
  readonly jsonPath: string;
  readonly markdownPath: string;
}> {
  const report = await runHybridTokenEfficiencyProfile();
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `hybrid-token-efficiency-profile-${stamp}.json`);
  const markdownPath = path.join(dir, `hybrid-token-efficiency-profile-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const lines = [
    "# Hybrid Token Efficiency Profile",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- failures: ${report.failures.join(", ") || "none"}`,
    `- warnings: ${report.warnings.join(", ") || "none"}`,
    `- assistant prompt: ${report.metrics.assistantPromptVersion}`,
    `- assistant runs used: ${report.metrics.assistantRunsUsedScope} (${report.metrics.assistantCurrentPromptRunCount}/${report.metrics.assistantRunCount})`,
    `- input tokens p95/max: ${report.metrics.inputTokens.p95}/${report.metrics.inputTokens.max}`,
    `- output tokens p95/max: ${report.metrics.outputTokens.p95}/${report.metrics.outputTokens.max}`,
    `- packet v2 estimated input p95/max: ${report.metrics.packetV2EstimatedInputTokens.p95}/${report.metrics.packetV2EstimatedInputTokens.max}`,
    `- extraction unit tokens p95/max: ${report.metrics.extractionUnitTokens.p95}/${report.metrics.extractionUnitTokens.max}`,
    `- query-time GLiNER/LLM calls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Top Expensive Chunks",
    "",
    ...report.topExpensiveChunks.map(
      (entry) =>
        `- ${entry.totalTokens} tokens ${entry.sourceType}/${entry.sourceId ?? "unknown"}: ${entry.textPreview}`
    )
  ];
  await writeFile(markdownPath, `${lines.join("\n")}\n`, "utf8");
  return { report, jsonPath, markdownPath };
}

export async function runHybridTokenEfficiencyProfileCli(): Promise<void> {
  try {
    const result = await runAndWriteHybridTokenEfficiencyProfile();
    console.log(JSON.stringify(result, null, 2));
    if (!result.report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
