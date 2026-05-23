import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryRows } from "../db/client.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

type CompilerFailureOwner =
  | "pass"
  | "compiler_missing"
  | "compiled_but_not_ranked"
  | "ranked_but_rejected"
  | "reader_shape_failure"
  | "subject_binding_failure"
  | "temporal_granularity_failure"
  | "benchmark_transport_failure"
  | "unknown";

type CoverageSourceTable =
  | "raw_source"
  | "narrative_scenes"
  | "compiled_fact_observations"
  | "exact_detail_fact_keys"
  | "temporal_event_facts"
  | "contract_projection_entries"
  | "canonical_facts"
  | "canonical_states";

interface LongMemEvalEntry {
  readonly question_id: string;
  readonly question: string;
  readonly answer: string;
  readonly question_type: string;
  readonly haystack_sessions: readonly (readonly { readonly role: string; readonly content: string }[])[];
}

interface LongMemEvalResult {
  readonly questionId: string;
  readonly questionType?: string;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly passed: boolean;
  readonly normalizedPassed?: boolean;
  readonly failureClass?: string;
  readonly finalClaimSource?: string | null;
  readonly dominantStage?: string | null;
  readonly supportBundleFamily?: string | null;
  readonly authoritativeSource?: string | null;
  readonly abstentionReason?: string | null;
  readonly entityResolutionStatus?: string | null;
  readonly temporalCoverageStatus?: string | null;
  readonly structuredSufficiencyStatus?: string | null;
  readonly claimAdmissibilityStatus?: string | null;
  readonly authoritativeClaimRejectedReason?: string | null;
  readonly factKeyLookupUsed?: boolean | null;
  readonly factKeyHitType?: string | null;
  readonly factRowSource?: string | null;
  readonly benchmarkStage?: string | null;
  readonly stageFailureReason?: string | null;
  readonly answerSnippet?: string | null;
}

interface LongMemEvalArtifact {
  readonly generatedAt: string;
  readonly dataset: string;
  readonly sampleCount: number;
  readonly passRate: number;
  readonly results: readonly LongMemEvalResult[];
}

interface LongMemEvalPartialArtifact {
  readonly status?: "partial";
  readonly progress?: {
    readonly runStamp?: string;
    readonly completedQuestions?: number;
    readonly totalQuestionsPlanned?: number;
  };
  readonly results?: readonly LongMemEvalResult[];
}

interface SourceCoverageMatch {
  readonly rowId: string;
  readonly score: number;
  readonly exact: boolean;
  readonly tokenCoverage: number;
  readonly snippet: string;
  readonly sourceKind?: string | null;
  readonly sourceMeta?: Record<string, unknown>;
}

interface SourceCoverage {
  readonly sourceTable: CoverageSourceTable;
  readonly checked: boolean;
  readonly hit: boolean;
  readonly totalRows: number;
  readonly hitRows: number;
  readonly error: string | null;
  readonly topMatches: readonly SourceCoverageMatch[];
}

interface CoverageRow {
  readonly questionId: string;
  readonly namespaceId: string | null;
  readonly questionType: string | null;
  readonly supportBundleFamily: string | null;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly passed: boolean;
  readonly failureOwner: CompilerFailureOwner;
  readonly rawSourceHit: boolean;
  readonly compiledHit: boolean;
  readonly strongestCompiledSource: CoverageSourceTable | null;
  readonly selectedClaimSource: string | null;
  readonly factKeyLookupUsed: boolean | null;
  readonly factRowSource: string | null;
  readonly claimAdmissibilityStatus: string | null;
  readonly authoritativeClaimRejectedReason: string | null;
  readonly abstentionReason: string | null;
  readonly entityResolutionStatus: string | null;
  readonly temporalCoverageStatus: string | null;
  readonly structuredSufficiencyStatus: string | null;
  readonly benchmarkStage: string | null;
  readonly stageFailureReason: string | null;
  readonly sources: readonly SourceCoverage[];
}

export interface LongMemCompilerCoverageReport {
  readonly generatedAt: string;
  readonly sourceArtifactPath: string;
  readonly sourcePartialPath: string | null;
  readonly dataset: "longmemeval_s_cleaned";
  readonly runStamp: string | null;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly passRate: number;
  readonly ownerBreakdown: Readonly<Record<CompilerFailureOwner, number>>;
  readonly sourceHitBreakdown: Readonly<Record<CoverageSourceTable, number>>;
  readonly unknownRate: number;
  readonly passed: boolean;
  readonly rows: readonly CoverageRow[];
}

interface DbCoverageRow {
  readonly row_id: string;
  readonly searchable_text: string | null;
  readonly source_kind: string | null;
  readonly source_meta: Record<string, unknown> | null;
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function rootDir(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

function rawDir(): string {
  return path.resolve(rootDir(), "benchmark-generated", "public-memory-compare", "raw");
}

function normalizeForMatch(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/gu, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function expectedTokens(expectedAnswer: string): readonly string[] {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "at",
    "for",
    "from",
    "in",
    "my",
    "of",
    "on",
    "the",
    "to",
    "with"
  ]);
  return normalizeForMatch(expectedAnswer)
    .split(" ")
    .filter((token) => token.length > 0 && !stopWords.has(token));
}

function scoreTextMatch(expectedAnswer: string, candidate: string): { readonly score: number; readonly exact: boolean; readonly tokenCoverage: number } {
  const expected = normalizeForMatch(expectedAnswer);
  const haystack = normalizeForMatch(candidate);
  if (!expected || !haystack) {
    return { score: 0, exact: false, tokenCoverage: 0 };
  }
  const exact = haystack.includes(expected);
  const tokens = expectedTokens(expectedAnswer);
  const matched = tokens.filter((token) => haystack.includes(token)).length;
  const tokenCoverage = tokens.length === 0 ? 0 : matched / tokens.length;
  return {
    score: exact ? 1 : tokenCoverage,
    exact,
    tokenCoverage
  };
}

function isHit(score: { readonly exact: boolean; readonly tokenCoverage: number }, expectedAnswer: string): boolean {
  const tokenCount = expectedTokens(expectedAnswer).length;
  return score.exact || (tokenCount <= 2 ? score.tokenCoverage >= 1 : score.tokenCoverage >= 0.75);
}

function snippet(value: string, maxLength = 220): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function countBy<T extends string>(values: readonly T[], keys: readonly T[]): Readonly<Record<T, number>> {
  const result = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const value of values) {
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function latestMatchingFile(prefix: string, suffix: string, reject?: (fileName: string) => boolean): Promise<string> {
  const dir = outputDir();
  const files = await readdir(dir);
  const candidates = await Promise.all(
    files
      .filter((fileName) => fileName.startsWith(prefix) && fileName.endsWith(suffix) && !(reject?.(fileName) ?? false))
      .map(async (fileName) => {
        const filePath = path.join(dir, fileName);
        const fileStat = await stat(filePath);
        return { filePath, mtimeMs: fileStat.mtimeMs };
      })
  );
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!candidates[0]) {
    throw new Error(`No ${prefix}*${suffix} artifact found in ${dir}`);
  }
  return candidates[0].filePath;
}

function resultIds(results: readonly LongMemEvalResult[]): string {
  return results.map((result) => result.questionId).join("|");
}

async function resolveSourcePartialPath(sourceArtifact: LongMemEvalArtifact, artifactPath: string): Promise<string | null> {
  const explicit = process.env.BRAIN_LONGMEM_COMPILER_COVERAGE_PARTIAL_PATH;
  if (explicit?.trim()) {
    return path.resolve(explicit);
  }
  const files = await readdir(outputDir());
  const artifactStat = await stat(artifactPath);
  const targetIds = resultIds(sourceArtifact.results);
  const candidates: { readonly filePath: string; readonly mtimeMs: number; readonly runStamp: string }[] = [];
  for (const fileName of files) {
    if (!fileName.startsWith("longmemeval-") || !fileName.endsWith(".partial.json")) {
      continue;
    }
    const filePath = path.join(outputDir(), fileName);
    const fileStat = await stat(filePath);
    if (fileStat.mtimeMs > artifactStat.mtimeMs + 60_000) {
      continue;
    }
    try {
      const partial = await readJsonFile<LongMemEvalPartialArtifact>(filePath);
      if (
        partial.progress?.runStamp &&
        partial.progress.completedQuestions === sourceArtifact.sampleCount &&
        partial.results &&
        resultIds(partial.results) === targetIds
      ) {
        candidates.push({ filePath, mtimeMs: fileStat.mtimeMs, runStamp: partial.progress.runStamp });
      }
    } catch {
      // Ignore unrelated or corrupt partial files.
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.filePath ?? null;
}

async function resolveLongMemArtifactPath(): Promise<string> {
  const explicit = process.env.BRAIN_LONGMEM_COMPILER_COVERAGE_ARTIFACT_PATH;
  if (explicit?.trim()) {
    return path.resolve(explicit);
  }
  return latestMatchingFile("longmemeval-", ".json", (fileName) => fileName.endsWith(".partial.json"));
}

async function loadLongMemDataset(): Promise<readonly LongMemEvalEntry[]> {
  return readJsonFile<readonly LongMemEvalEntry[]>(path.join(rawDir(), "longmemeval_s_cleaned.json"));
}

function rawSourceCoverage(entry: LongMemEvalEntry): SourceCoverage {
  const rows = entry.haystack_sessions.flatMap((session, sessionIndex) =>
    session.map((turn, turnIndex) => ({
      rowId: `session-${sessionIndex + 1}-turn-${turnIndex + 1}`,
      searchableText: `${turn.role}: ${turn.content}`,
      sourceKind: turn.role,
      sourceMeta: { sessionIndex, turnIndex }
    }))
  );
  return buildCoverageFromRows("raw_source", entry.answer, rows);
}

function buildCoverageFromRows(
  sourceTable: CoverageSourceTable,
  expectedAnswer: string,
  rows: readonly {
    readonly rowId: string;
    readonly searchableText: string | null;
    readonly sourceKind?: string | null;
    readonly sourceMeta?: Record<string, unknown> | null;
  }[],
  error: string | null = null
): SourceCoverage {
  const scored = rows
    .map((row) => {
      const searchableText = row.searchableText ?? "";
      const score = scoreTextMatch(expectedAnswer, searchableText);
      return {
        row,
        score
      };
    })
    .sort((left, right) => right.score.score - left.score.score);
  const hitRows = scored.filter((row) => isHit(row.score, expectedAnswer));
  return {
    sourceTable,
    checked: error === null,
    hit: hitRows.length > 0,
    totalRows: rows.length,
    hitRows: hitRows.length,
    error,
    topMatches: scored
      .filter((row) => row.score.score > 0)
      .slice(0, 5)
      .map((row) => ({
        rowId: row.row.rowId,
        score: Number(row.score.score.toFixed(3)),
        exact: row.score.exact,
        tokenCoverage: Number(row.score.tokenCoverage.toFixed(3)),
        snippet: snippet(row.row.searchableText ?? ""),
        sourceKind: row.row.sourceKind ?? null,
        sourceMeta: row.row.sourceMeta ?? undefined
      }))
  };
}

async function querySourceRows(namespaceId: string, sourceTable: Exclude<CoverageSourceTable, "raw_source">): Promise<readonly DbCoverageRow[]> {
  switch (sourceTable) {
    case "narrative_scenes":
      return queryRows<DbCoverageRow>(
        `
          SELECT
            id::text AS row_id,
            concat_ws(' ', scene_text, metadata::text) AS searchable_text,
            metadata#>>'{external_relation_ie,relation_ie_mode}' AS source_kind,
            jsonb_build_object(
              'scene_type', metadata#>>'{external_relation_ie,scene_type}',
              'promotionRejectedReason', metadata#>>'{external_relation_ie,promotion_review,rejection_breakdown}'
            ) AS source_meta
          FROM narrative_scenes
          WHERE namespace_id = $1
          ORDER BY occurred_at ASC, created_at ASC
          LIMIT 1000
        `,
        [namespaceId]
      );
    case "exact_detail_fact_keys":
      return queryRows<DbCoverageRow>(
        `
          SELECT
            id::text AS row_id,
            concat_ws(' ', key_text, normalized_key_text, property_key, exact_detail_family, metadata::text) AS searchable_text,
            fact_table AS source_kind,
            jsonb_build_object(
              'family', exact_detail_family,
              'propertyKey', property_key,
              'keyType', key_type,
              'truthStatus', truth_status,
              'confidence', confidence,
              'promotionRejectedReason', metadata->>'promotionRejectedReason',
              'sourceSceneId', metadata->>'source_scene_id'
            ) AS source_meta
          FROM exact_detail_fact_keys
          WHERE namespace_id = $1
          ORDER BY
            CASE truth_status WHEN 'active' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END,
            confidence DESC NULLS LAST,
            valid_from DESC NULLS LAST,
            created_at DESC
          LIMIT 1000
        `,
        [namespaceId]
      );
    case "compiled_fact_observations":
      return queryRows<DbCoverageRow>(
        `
          SELECT
            id::text AS row_id,
            concat_ws(
              ' ',
              answer_value,
              normalized_answer_value,
              property_key,
              exact_detail_family,
              predicate_family,
              support_phrase,
              source_text,
              metadata::text
            ) AS searchable_text,
            source_table AS source_kind,
            jsonb_build_object(
              'family', exact_detail_family,
              'queryFamily', query_family,
              'propertyKey', property_key,
              'truthStatus', truth_status,
              'promotionStatus', promotion_status,
              'admissibilityStatus', admissibility_status,
              'rejectionReason', rejection_reason,
              'confidence', confidence,
              'sourceTable', source_table,
              'sourceRowId', source_row_id
            ) AS source_meta
          FROM compiled_fact_observations
          WHERE namespace_id = $1
          ORDER BY
            CASE promotion_status WHEN 'compiled' THEN 0 WHEN 'ambiguous' THEN 1 ELSE 2 END,
            CASE truth_status WHEN 'active' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END,
            confidence DESC NULLS LAST,
            valid_from DESC NULLS LAST,
            created_at DESC
          LIMIT 1000
        `,
        [namespaceId]
      );
    case "temporal_event_facts":
      return queryRows<DbCoverageRow>(
        `
          SELECT
            id::text AS row_id,
            concat_ws(
              ' ',
              contract_name,
              predicate_family,
              object_value,
              event_key,
              event_label,
              event_type,
              answer_year::text,
              answer_month::text,
              answer_day::text,
              metadata::text
            ) AS searchable_text,
            predicate_family AS source_kind,
            jsonb_build_object(
              'truthStatus', truth_status,
              'granularity', time_granularity,
              'exactness', exactness,
              'conflictStatus', conflict_status
            ) AS source_meta
          FROM temporal_event_facts
          WHERE namespace_id = $1
          ORDER BY
            CASE truth_status WHEN 'active' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END,
            valid_from DESC NULLS LAST,
            created_at DESC
          LIMIT 1000
        `,
        [namespaceId]
      );
    case "contract_projection_entries":
      return queryRows<DbCoverageRow>(
        `
          SELECT
            cpe.id::text AS row_id,
            concat_ws(
              ' ',
              cph.contract_name,
              cph.query_family,
              cph.authoritative_source,
              cph.summary_text,
              cph.answer_payload::text,
              cph.render_payload::text,
              cpe.display_value,
              cpe.normalized_value,
              cpe.entry_type,
              cpe.normalized_property_key,
              cpe.metadata::text
            ) AS searchable_text,
            cph.authoritative_source AS source_kind,
            jsonb_build_object(
              'contractName', cph.contract_name,
              'queryFamily', cph.query_family,
              'sufficiency', cph.structured_sufficiency_status,
              'entryType', cpe.entry_type,
              'propertyKey', cpe.normalized_property_key,
              'truthStatus', cpe.truth_status
            ) AS source_meta
          FROM contract_projection_entries cpe
          JOIN contract_projection_heads cph ON cph.id = cpe.projection_head_id
          WHERE cpe.namespace_id = $1
          ORDER BY
            CASE cpe.truth_status WHEN 'active' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END,
            cph.completeness_score DESC,
            cpe.source_confidence DESC NULLS LAST,
            cpe.created_at DESC
          LIMIT 1000
        `,
        [namespaceId]
      );
    case "canonical_facts":
      return queryRows<DbCoverageRow>(
        `
          SELECT
            id::text AS row_id,
            concat_ws(' ', predicate_family, object_value, metadata::text) AS searchable_text,
            predicate_family AS source_kind,
            jsonb_build_object(
              'supportStrength', support_strength,
              'timeScopeKind', time_scope_kind,
              'validFrom', valid_from,
              'validUntil', valid_until,
              'supersedesFactId', supersedes_fact_id
            ) AS source_meta
          FROM canonical_facts
          WHERE namespace_id = $1
          ORDER BY support_strength DESC, valid_from DESC NULLS LAST, created_at DESC
          LIMIT 1000
        `,
        [namespaceId]
      );
    case "canonical_states":
      return queryRows<DbCoverageRow>(
        `
          SELECT
            id::text AS row_id,
            concat_ws(' ', predicate_family, state_value, metadata::text) AS searchable_text,
            predicate_family AS source_kind,
            jsonb_build_object(
              'supportStrength', support_strength,
              'confidence', confidence,
              'timeScopeKind', time_scope_kind,
              'validFrom', valid_from,
              'validUntil', valid_until,
              'supersedesStateId', supersedes_state_id
            ) AS source_meta
          FROM canonical_states
          WHERE namespace_id = $1
          ORDER BY confidence DESC, valid_from DESC NULLS LAST, created_at DESC
          LIMIT 1000
        `,
        [namespaceId]
      );
  }
}

async function dbSourceCoverage(
  namespaceId: string | null,
  expectedAnswer: string,
  sourceTable: Exclude<CoverageSourceTable, "raw_source">
): Promise<SourceCoverage> {
  if (!namespaceId) {
    return buildCoverageFromRows(sourceTable, expectedAnswer, [], "run_stamp_unresolved");
  }
  try {
    const rows = await querySourceRows(namespaceId, sourceTable);
    return buildCoverageFromRows(
      sourceTable,
      expectedAnswer,
      rows.map((row) => ({
        rowId: row.row_id,
        searchableText: row.searchable_text,
        sourceKind: row.source_kind,
        sourceMeta: row.source_meta
      }))
    );
  } catch (error) {
    return buildCoverageFromRows(sourceTable, expectedAnswer, [], error instanceof Error ? error.message : String(error));
  }
}

function strongestCompiledSource(sources: readonly SourceCoverage[]): CoverageSourceTable | null {
  const order: readonly CoverageSourceTable[] = [
    "compiled_fact_observations",
    "exact_detail_fact_keys",
    "temporal_event_facts",
    "contract_projection_entries",
    "canonical_facts",
    "canonical_states",
    "narrative_scenes"
  ];
  return order.find((sourceTable) => sources.some((source) => source.sourceTable === sourceTable && source.hit)) ?? null;
}

function classifyFailureOwner(result: LongMemEvalResult, sources: readonly SourceCoverage[]): CompilerFailureOwner {
  if (result.passed) {
    return "pass";
  }
  if (result.benchmarkStage && result.benchmarkStage !== "complete") {
    return "benchmark_transport_failure";
  }
  if (result.stageFailureReason) {
    return "benchmark_transport_failure";
  }

  const rawHit = sources.some((source) => source.sourceTable === "raw_source" && source.hit);
  const compiledHit = sources.some((source) => source.sourceTable !== "raw_source" && source.hit);
  const temporalHit = sources.some((source) => source.sourceTable === "temporal_event_facts" && source.hit);
  const exactFactHit = sources.some((source) => source.sourceTable === "exact_detail_fact_keys" && source.hit);
  const compiledFactHit = sources.some((source) => source.sourceTable === "compiled_fact_observations" && source.hit);
  const abstentionReason = result.abstentionReason ?? "";
  const supportFamily = result.supportBundleFamily ?? "";
  const finalClaimSource = result.finalClaimSource ?? "";

  if (
    abstentionReason === "no_subject_binding" ||
    result.entityResolutionStatus === "unresolved" ||
    result.entityResolutionStatus === "ambiguous"
  ) {
    return "subject_binding_failure";
  }
  if (result.claimAdmissibilityStatus === "rejected" || result.authoritativeClaimRejectedReason) {
    return "ranked_but_rejected";
  }
  if (
    (supportFamily === "temporal_detail" || /temporal|date|time/u.test(`${result.questionType ?? ""} ${result.question}`.toLowerCase())) &&
    (temporalHit || finalClaimSource.includes("temporal"))
  ) {
    return "temporal_granularity_failure";
  }
  if (compiledHit && (exactFactHit || compiledFactHit) && result.factKeyLookupUsed !== true) {
    return "compiled_but_not_ranked";
  }
  if (compiledHit && (abstentionReason || result.structuredSufficiencyStatus === "insufficient")) {
    return "compiled_but_not_ranked";
  }
  if (compiledHit && result.structuredSufficiencyStatus === "sufficient") {
    return "reader_shape_failure";
  }
  if (compiledHit) {
    return "compiled_but_not_ranked";
  }
  if (rawHit) {
    return "compiler_missing";
  }
  return "unknown";
}

async function buildCoverageRow(params: {
  readonly index: number;
  readonly runStamp: string | null;
  readonly result: LongMemEvalResult;
  readonly entry: LongMemEvalEntry | null;
}): Promise<CoverageRow> {
  const namespaceId = params.runStamp ? `benchmark_longmemeval_${params.runStamp}_${params.index}` : null;
  const rawCoverage = params.entry
    ? rawSourceCoverage(params.entry)
    : buildCoverageFromRows("raw_source", params.result.expectedAnswer, [], "dataset_entry_not_found");
  const sourceTables: readonly Exclude<CoverageSourceTable, "raw_source">[] = [
    "narrative_scenes",
    "compiled_fact_observations",
    "exact_detail_fact_keys",
    "temporal_event_facts",
    "contract_projection_entries",
    "canonical_facts",
    "canonical_states"
  ];
  const dbCoverages = await Promise.all(
    sourceTables.map((sourceTable) => dbSourceCoverage(namespaceId, params.result.expectedAnswer, sourceTable))
  );
  const sources = [rawCoverage, ...dbCoverages];
  const strongestSource = strongestCompiledSource(sources);
  const failureOwner = classifyFailureOwner(params.result, sources);
  return {
    questionId: params.result.questionId,
    namespaceId,
    questionType: params.result.questionType ?? params.entry?.question_type ?? null,
    supportBundleFamily: params.result.supportBundleFamily ?? null,
    question: params.result.question,
    expectedAnswer: params.result.expectedAnswer,
    passed: params.result.passed,
    failureOwner,
    rawSourceHit: rawCoverage.hit,
    compiledHit: strongestSource !== null,
    strongestCompiledSource: strongestSource,
    selectedClaimSource: params.result.finalClaimSource ?? params.result.authoritativeSource ?? null,
    factKeyLookupUsed: typeof params.result.factKeyLookupUsed === "boolean" ? params.result.factKeyLookupUsed : null,
    factRowSource: params.result.factRowSource ?? null,
    claimAdmissibilityStatus: params.result.claimAdmissibilityStatus ?? null,
    authoritativeClaimRejectedReason: params.result.authoritativeClaimRejectedReason ?? null,
    abstentionReason: params.result.abstentionReason ?? null,
    entityResolutionStatus: params.result.entityResolutionStatus ?? null,
    temporalCoverageStatus: params.result.temporalCoverageStatus ?? null,
    structuredSufficiencyStatus: params.result.structuredSufficiencyStatus ?? null,
    benchmarkStage: params.result.benchmarkStage ?? null,
    stageFailureReason: params.result.stageFailureReason ?? null,
    sources
  };
}

function toMarkdown(report: LongMemCompilerCoverageReport): string {
  const lines = [
    "# LongMem Compiler Coverage Report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sourceArtifactPath: ${report.sourceArtifactPath}`,
    `- sourcePartialPath: ${report.sourcePartialPath ?? "none"}`,
    `- runStamp: ${report.runStamp ?? "unresolved"}`,
    `- sampleCount: ${report.sampleCount}`,
    `- sourcePassRate: ${report.passRate}`,
    `- unknownRate: ${report.unknownRate}`,
    `- passed: ${report.passed}`,
    "",
    "## Failure Owners",
    "",
    ...Object.entries(report.ownerBreakdown).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Source Hits",
    "",
    ...Object.entries(report.sourceHitBreakdown).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Failing Rows",
    ""
  ];
  for (const row of report.rows.filter((entry) => !entry.passed)) {
    const topSources = row.sources
      .filter((source) => source.hit || source.error)
      .map((source) => `${source.sourceTable}${source.hit ? ":hit" : ""}${source.error ? `:error=${source.error}` : ""}`)
      .join(", ");
    lines.push(
      `- ${row.questionId} owner=${row.failureOwner} family=${row.supportBundleFamily ?? "null"} expected=${JSON.stringify(
        row.expectedAnswer
      )} strongest=${row.strongestCompiledSource ?? "none"} factKey=${String(row.factKeyLookupUsed)} sources=${topSources || "none"}`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteLongMemCompilerCoverage(): Promise<{
  readonly report: LongMemCompilerCoverageReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const artifactPath = await resolveLongMemArtifactPath();
  const sourceArtifact = await readJsonFile<LongMemEvalArtifact>(artifactPath);
  const partialPath = await resolveSourcePartialPath(sourceArtifact, artifactPath);
  const runStamp =
    process.env.BRAIN_LONGMEM_COMPILER_COVERAGE_RUN_STAMP?.trim() ||
    (partialPath ? (await readJsonFile<LongMemEvalPartialArtifact>(partialPath)).progress?.runStamp : null) ||
    null;
  const dataset = await loadLongMemDataset();
  const entriesById = new Map(dataset.map((entry) => [entry.question_id, entry]));
  const rows: CoverageRow[] = [];
  for (const [index, result] of sourceArtifact.results.entries()) {
    rows.push(
      await buildCoverageRow({
        index,
        runStamp,
        result,
        entry: entriesById.get(result.questionId) ?? null
      })
    );
  }

  const ownerKeys: readonly CompilerFailureOwner[] = [
    "pass",
    "compiler_missing",
    "compiled_but_not_ranked",
    "ranked_but_rejected",
    "reader_shape_failure",
    "subject_binding_failure",
    "temporal_granularity_failure",
    "benchmark_transport_failure",
    "unknown"
  ];
  const sourceKeys: readonly CoverageSourceTable[] = [
    "raw_source",
    "narrative_scenes",
    "compiled_fact_observations",
    "exact_detail_fact_keys",
    "temporal_event_facts",
    "contract_projection_entries",
    "canonical_facts",
    "canonical_states"
  ];
  const ownerBreakdown = countBy(
    rows.map((row) => row.failureOwner),
    ownerKeys
  );
  const sourceHitBreakdown = Object.fromEntries(
    sourceKeys.map((sourceTable) => [sourceTable, rows.filter((row) => row.sources.some((source) => source.sourceTable === sourceTable && source.hit)).length])
  ) as Record<CoverageSourceTable, number>;
  const unknownRate = Number(((ownerBreakdown.unknown ?? 0) / Math.max(1, rows.length)).toFixed(3));
  const report: LongMemCompilerCoverageReport = {
    generatedAt: new Date().toISOString(),
    sourceArtifactPath: artifactPath,
    sourcePartialPath: partialPath,
    dataset: "longmemeval_s_cleaned",
    runStamp,
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: sourceArtifact.sampleCount >= 500 ? "full" : "sampled",
      sampleControls: {
        diagnosticType: "longmem_compiler_coverage",
        sourceArtifactPath: artifactPath,
        sourcePartialPath: partialPath,
        runStamp,
        sourceSampleCount: sourceArtifact.sampleCount
      }
    }),
    sampleCount: rows.length,
    passRate: sourceArtifact.passRate,
    ownerBreakdown,
    sourceHitBreakdown,
    unknownRate,
    passed: unknownRate <= 0.05 && rows.every((row) => row.failureOwner !== "unknown"),
    rows
  };

  await mkdir(outputDir(), { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir(), `longmem-compiler-coverage-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `longmem-compiler-coverage-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runLongMemCompilerCoverageCli(): Promise<void> {
  const { output } = await runAndWriteLongMemCompilerCoverage();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
}
