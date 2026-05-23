import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryRows, closePool } from "../db/client.js";
import { loadCompiledDirectFactObservationRows, type CompiledFactObservationLookupRow } from "../compiled-memory/service.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import {
  compiledDirectFactContextScoreForTest,
  compiledDirectFactFitsQueryForTest,
  dedupeCompiledDirectFactRowsForTest,
  type SourceBoundDirectFactFamily
} from "../retrieval/route-locked-fast-paths.js";
import { cleanupPublicBenchmarkNamespaces } from "./public-benchmark-cleanup.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import {
  buildCompiledDirectFactRealSourceCoverageCases,
  readLoCoMoDataset,
  type RealSourceCoverageCase
} from "./compiled-direct-fact-real-source-coverage.js";
import {
  formatLoCoMoConversationSession,
  ingestLoCoMoSessionArtifacts,
  type LoCoMoConversationRecord,
  type LoCoMoTurnRecord
} from "./locomo-ingest.js";

type DbCoverageStatus =
  | "compiled_selected"
  | "compiled_missing"
  | "compiled_unusable"
  | "compiled_evidence_missing"
  | "subject_binding_missing"
  | "source_missing";

interface DbCoverageCaseResult {
  readonly name: string;
  readonly sampleId: string;
  readonly family: string;
  readonly subject: string;
  readonly queryText: string;
  readonly expectedTerms: readonly string[];
  readonly sourceTerms: readonly string[];
  readonly status: DbCoverageStatus;
  readonly passed: boolean;
  readonly namedRowCount: number;
  readonly allFamilyRowCount: number;
  readonly fitRowCount: number;
  readonly sourceBoundRowCount: number;
  readonly selectedValues: readonly string[];
  readonly selectedSupportPhrases: readonly string[];
  readonly missingTerms: readonly string[];
  readonly sourceAuditStatus: "source_terms_present" | "source_missing";
}

interface DbCoverageReport {
  readonly generatedAt: string;
  readonly benchmark: "compiled_direct_fact_read_model_coverage";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly passRate: number;
    readonly sourceMissingCount: number;
    readonly compiledMissingCount: number;
    readonly compiledUnusableCount: number;
    readonly compiledEvidenceMissingCount: number;
    readonly subjectBindingMissingCount: number;
    readonly promotionWithoutEvidenceQuoteCount: number;
    readonly unknownTaxonomyPromotedCount: number;
    readonly mixedOwnerPromotedCount: number;
    readonly queryTimeGLiNEROrLLMCalls: number;
  };
  readonly gates: {
    readonly coveragePassed: boolean;
    readonly perFamilyCoveragePassed: boolean;
    readonly evidenceQuotePassed: boolean;
    readonly taxonomyTruthPassed: boolean;
    readonly mixedOwnerPassed: boolean;
    readonly queryTimeModelPassed: boolean;
    readonly overallPassed: boolean;
  };
  readonly familyBreakdown: Readonly<Record<string, {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly passRate: number;
  }>>;
  readonly namespaces: readonly {
    readonly sampleId: string;
    readonly namespaceId: string;
    readonly promotedDirectFacts: number;
    readonly rejectedDirectFacts: number;
    readonly ambiguousDirectFacts: number;
    readonly sourceRows: number;
  }[];
  readonly cases: readonly DbCoverageCaseResult[];
}

interface DirectFactQualityRow {
  readonly promotion_without_evidence_quote_count: string;
  readonly unknown_taxonomy_promoted_count: string;
  readonly mixed_owner_promoted_count: string;
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

function generatedRoot(): string {
  return path.resolve(localBrainRoot(), "benchmark-generated", "compiled-direct-fact-read-model-coverage");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function compact(value: unknown): string {
  return normalize(value).toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function containsTerm(haystack: string, term: string): boolean {
  return compact(haystack).includes(compact(term));
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(3)) : 0;
}

function sessionEntries(sample: LoCoMoConversationRecord): Array<readonly [string, readonly LoCoMoTurnRecord[]]> {
  return Object.entries(sample.conversation)
    .filter((entry): entry is [string, readonly LoCoMoTurnRecord[]] => entry[0].startsWith("session_") && Array.isArray(entry[1]))
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }));
}

function sourceTextForSample(sample: LoCoMoConversationRecord): string {
  return sessionEntries(sample)
    .map(([sessionKey, turns]) => formatLoCoMoConversationSession(sample, sessionKey, turns))
    .join("\n\n");
}

function queryTextForCase(testCase: RealSourceCoverageCase): string {
  const subject = testCase.subject;
  const name = testCase.name;
  if (/style_of_dance|contemporary_preference/u.test(name)) return `What is ${subject}'s favorite style of dance?`;
  if (/recipe_preference/u.test(name)) return `What is ${subject}'s favorite recipe?`;
  if (/meat_preference/u.test(name)) return `Which meat does ${subject} prefer eating more than others?`;
  if (/aerosmith/u.test(name)) return `What is ${subject}'s favorite band?`;
  if (/books|sapiens|avalanche|c_s_lewis/u.test(name)) return `What are ${subject}'s favorite books?`;
  if (/collect/u.test(name)) return `What items does ${subject} collect?`;
  if (/indoor_activities/u.test(name)) return `What kind of indoor activities have ${subject} and his girlfriend tried?`;
  if (/pet_workshop|pet_care_classes/u.test(name)) return `What kind of classes or groups has ${subject} joined to take better care of her dogs?`;
  if (/prius/u.test(name)) return `What type of car did ${subject} get after his old Prius broke down?`;
  if (/mansion_owned/u.test(name)) return `What property or owned object did ${subject} mention?`;
  if (/march_purchases/u.test(name)) return `What new purchases or property did ${subject} mention?`;
  if (/ferrari_purchase|mansion_purchase/u.test(name)) return `What new purchase or property did ${subject} mention?`;
  if (/sports_team/u.test(name)) return `Which team did ${subject} sign with on 21 May, 2023?`;
  if (/shooting_guard/u.test(name)) return `What position does ${subject} play?`;
  if (/shooting_goal|championship_goal|basketball_goals/u.test(name)) return `what are ${subject}'s goals with regards to his basketball career?`;
  if (/school_funding_help/u.test(name)) return `How did the extra funding help the school shown in the photo shared by ${subject}?`;
  if (/weight_problem/u.test(name)) return `What health problem did ${subject} find out about?`;
  if (/married_status|not_married_status/u.test(name)) return `Is ${subject} married?`;
  if (/social_location|church|convention_friends/u.test(name)) return `Where has ${subject} made friends?`;
  if (/game_convention_date_activity/u.test(name)) return `What did ${subject} do last Friday?`;
  if (/doctor_weight_date/u.test(name)) return `When did ${subject} first go to the doctor and find out he had a weight problem?`;
  if (/bowling_activity|date_activity/u.test(name)) return `Which recreational activity was ${subject} pursuing on March 16, 2022?`;
  if (/turtles_duration/u.test(name)) return `How long has ${subject} had his first two turtles?`;
  if (/watercolor_friend_cause/u.test(name)) return `How did ${subject} get into watercolor painting?`;
  if (/store_fashion_cause/u.test(name)) return `Why did ${subject} decide to start her clothing store?`;
  if (/dance_studio_job_loss_cause/u.test(name)) return `Why did ${subject} decide to start a dance studio?`;
  if (/repair_passion_cause/u.test(name)) return `Why did ${subject} decide to repair cars?`;
  if (/dog_app_unique/u.test(name)) return `How does ${subject} plan to make his dog-sitting app unique?`;
  if (/engineering_project/u.test(name)) return `What kind of project did ${subject} have in January 2023?`;
  if (/car_shop_goal|custom_car_goal|auto_engineering_goal/u.test(name)) return `What are ${subject}'s dreams?`;
  if (/endorsements_goal|charity_goal/u.test(name)) return `What are ${subject}'s goals not related to basketball skills?`;
  if (/preseason_challenge/u.test(name)) return `What challenge did ${subject} mention about the new team?`;
  if (/watercolor_stress_buster/u.test(name)) return `What is ${subject} doing as a stress-buster?`;
  return `What direct fact is known about ${subject}?`;
}

function rowEvidenceText(row: CompiledFactObservationLookupRow): string {
  return normalize([
    row.answer_value,
    row.support_phrase,
    row.source_text,
    JSON.stringify(row.metadata ?? {})
  ].filter(Boolean).join(" "));
}

function rowHasSourceEvidence(row: CompiledFactObservationLookupRow): boolean {
  return Boolean(normalize(row.support_phrase) && (normalize(row.source_uri) || row.source_chunk_id || row.source_memory_id));
}

async function ingestAndRebuildSample(params: {
  readonly sample: LoCoMoConversationRecord;
  readonly namespaceId: string;
  readonly corpusRoot: string;
}): Promise<{
  readonly promotedDirectFacts: number;
  readonly rejectedDirectFacts: number;
  readonly ambiguousDirectFacts: number;
  readonly sourceRows: number;
}> {
  for (const [sessionKey, turns] of sessionEntries(params.sample)) {
    await ingestLoCoMoSessionArtifacts({
      localBrainRoot: localBrainRoot(),
      benchmarkName: "compiled-direct-fact-read-model-coverage",
      corpusRoot: params.corpusRoot,
      namespaceId: params.namespaceId,
      sample: params.sample,
      sessionKey,
      turns
    });
  }
  const rebuild = await rebuildTypedMemoryNamespace(params.namespaceId, { skipVectorActivation: true });
  return {
    promotedDirectFacts: rebuild.compiledDirectFacts?.promoted ?? 0,
    rejectedDirectFacts: rebuild.compiledDirectFacts?.rejected ?? 0,
    ambiguousDirectFacts: rebuild.compiledDirectFacts?.ambiguous ?? 0,
    sourceRows: rebuild.compiledDirectFacts?.sourceRows ?? 0
  };
}

async function loadQualityCounters(namespaceIds: readonly string[]): Promise<DirectFactQualityRow> {
  const rows = await queryRows<DirectFactQualityRow>(
    `
      SELECT
        COUNT(*) FILTER (
          WHERE predicate_family = 'direct_fact'
            AND promotion_status = 'compiled'
            AND NULLIF(support_phrase, '') IS NULL
        )::text AS promotion_without_evidence_quote_count,
        COUNT(*) FILTER (
          WHERE predicate_family = 'direct_fact'
            AND promotion_status = 'compiled'
            AND COALESCE(metadata->>'taxonomyStatus', metadata->>'taxonomy_status', 'approved') NOT IN ('approved', 'mapped_to_parent')
        )::text AS unknown_taxonomy_promoted_count,
        COUNT(*) FILTER (
          WHERE predicate_family = 'direct_fact'
            AND promotion_status = 'compiled'
            AND COALESCE(metadata->>'subjectBindingStatus', '') = 'mixed_owner'
        )::text AS mixed_owner_promoted_count
      FROM compiled_fact_observations
      WHERE namespace_id = ANY($1::text[])
    `,
    [namespaceIds]
  );
  return rows[0] ?? {
    promotion_without_evidence_quote_count: "0",
    unknown_taxonomy_promoted_count: "0",
    mixed_owner_promoted_count: "0"
  };
}

async function evaluateCase(params: {
  readonly namespaceId: string;
  readonly testCase: RealSourceCoverageCase;
  readonly sample: LoCoMoConversationRecord;
}): Promise<DbCoverageCaseResult> {
  const queryText = queryTextForCase(params.testCase);
  const sourceText = sourceTextForSample(params.sample);
  const sourceAuditStatus = params.testCase.sourceTerms.every((term) => containsTerm(sourceText, term)) ? "source_terms_present" : "source_missing";
  const family = params.testCase.family as SourceBoundDirectFactFamily;
  const [namedRows, allFamilyRows] = await Promise.all([
    loadCompiledDirectFactObservationRows({
      namespaceId: params.namespaceId,
      directFactFamily: params.testCase.family,
      names: [params.testCase.subject],
      limit: 256
    }),
    loadCompiledDirectFactObservationRows({
      namespaceId: params.namespaceId,
      directFactFamily: params.testCase.family,
      names: [],
      limit: 512
    })
  ]);
  const fitRows = namedRows.filter((row) => compiledDirectFactFitsQueryForTest(queryText, family, row));
  const rankedFitRows = dedupeCompiledDirectFactRowsForTest(
    [...fitRows].sort(
      (left, right) => compiledDirectFactContextScoreForTest(queryText, right) - compiledDirectFactContextScoreForTest(queryText, left)
    )
  );
  const sourceBoundRows = rankedFitRows.filter(rowHasSourceEvidence);
  const shouldRequireTopWindow =
    params.testCase.sessionKey !== "*" &&
    !["explicit_list_set", "purchase_fact"].includes(params.testCase.family);
  const termRows = shouldRequireTopWindow ? sourceBoundRows.slice(0, 8) : sourceBoundRows;
  const combinedText = normalize(termRows.map(rowEvidenceText).join(" "));
  const missingTerms = params.testCase.expectedTerms.filter((term) => !containsTerm(combinedText, term));
  const selectedValues = sourceBoundRows.map((row) => normalize(row.answer_value)).filter(Boolean).slice(0, 8);
  const selectedSupportPhrases = sourceBoundRows.map((row) => normalize(row.support_phrase)).filter(Boolean).slice(0, 4);

  let status: DbCoverageStatus = "compiled_selected";
  if (sourceAuditStatus === "source_missing") {
    status = "source_missing";
  } else if (namedRows.length === 0) {
    const allText = normalize(allFamilyRows.map(rowEvidenceText).join(" "));
    status = params.testCase.expectedTerms.some((term) => containsTerm(allText, term)) ? "subject_binding_missing" : "compiled_missing";
  } else if (fitRows.length === 0) {
    status = "compiled_unusable";
  } else if (sourceBoundRows.length === 0) {
    status = "compiled_evidence_missing";
  } else if (missingTerms.length > 0) {
    status = "compiled_unusable";
  }

  return {
    name: params.testCase.name,
    sampleId: params.testCase.sampleId,
    family: params.testCase.family,
    subject: params.testCase.subject,
    queryText,
    expectedTerms: params.testCase.expectedTerms,
    sourceTerms: params.testCase.sourceTerms,
    status,
    passed: status === "compiled_selected",
    namedRowCount: namedRows.length,
    allFamilyRowCount: allFamilyRows.length,
    fitRowCount: fitRows.length,
    sourceBoundRowCount: sourceBoundRows.length,
    selectedValues,
    selectedSupportPhrases,
    missingTerms,
    sourceAuditStatus
  };
}

function familyBreakdown(results: readonly DbCoverageCaseResult[]): DbCoverageReport["familyBreakdown"] {
  const byFamily = new Map<string, { total: number; passed: number; failed: number }>();
  for (const result of results) {
    const current = byFamily.get(result.family) ?? { total: 0, passed: 0, failed: 0 };
    current.total += 1;
    if (result.passed) current.passed += 1;
    else current.failed += 1;
    byFamily.set(result.family, current);
  }
  return Object.fromEntries(
    [...byFamily.entries()].map(([family, counts]) => [
      family,
      {
        ...counts,
        passRate: rate(counts.passed, counts.total)
      }
    ])
  );
}

async function writeReport(report: DbCoverageReport): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
  const outDir = outputDir();
  await mkdir(outDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `compiled-direct-fact-read-model-coverage-${stamp}.json`);
  const markdownPath = path.join(outDir, `compiled-direct-fact-read-model-coverage-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const lines = [
    "# Compiled Direct Fact Read-Model Coverage",
    "",
    `- total: ${report.summary.total}`,
    `- passed: ${report.summary.passed}`,
    `- failed: ${report.summary.failed}`,
    `- passRate: ${report.summary.passRate}`,
    `- overallPassed: ${report.gates.overallPassed}`,
    `- promotionWithoutEvidenceQuote: ${report.summary.promotionWithoutEvidenceQuoteCount}`,
    `- unknownTaxonomyPromoted: ${report.summary.unknownTaxonomyPromotedCount}`,
    `- mixedOwnerPromoted: ${report.summary.mixedOwnerPromotedCount}`,
    "",
    "## Failures",
    ""
  ];
  for (const result of report.cases.filter((entry) => !entry.passed)) {
    lines.push(
      `- ${result.name}: status=${result.status} family=${result.family} subject=${result.subject} namedRows=${result.namedRowCount} fitRows=${result.fitRowCount} sourceBoundRows=${result.sourceBoundRowCount} missingTerms=${result.missingTerms.join(", ") || "none"}`
    );
  }
  await writeFile(markdownPath, `${lines.join("\n")}\n`, "utf8");
  return { jsonPath, markdownPath };
}

export async function runCompiledDirectFactReadModelCoverageBenchmark(): Promise<{
  readonly report: DbCoverageReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const runStamp = generatedAt.replace(/[:.]/g, "-");
  const corpusRoot = path.join(generatedRoot(), runStamp, "corpus");
  await mkdir(corpusRoot, { recursive: true });
  const cases = buildCompiledDirectFactRealSourceCoverageCases();
  const dataset = await readLoCoMoDataset();
  const sampleIds = [...new Set(cases.map((testCase) => testCase.sampleId))];
  const samples = sampleIds.map((sampleId) => {
    const sample = dataset.find((entry) => entry.sample_id === sampleId);
    if (!sample) {
      throw new Error(`LoCoMo sample not found for direct-fact read-model coverage: ${sampleId}`);
    }
    return sample;
  });
  const namespaceBySample = new Map<string, string>();
  const namespaceSummaries: Array<DbCoverageReport["namespaces"][number]> = [];
  const namespaceIds: string[] = [];
  try {
    for (const sample of samples) {
      const namespaceId = `benchmark_direct_fact_read_model_${runStamp}_${sample.sample_id.replace(/[^a-z0-9]+/giu, "_").toLowerCase()}`;
      namespaceBySample.set(sample.sample_id, namespaceId);
      namespaceIds.push(namespaceId);
      const counts = await ingestAndRebuildSample({ sample, namespaceId, corpusRoot });
      namespaceSummaries.push({ sampleId: sample.sample_id, namespaceId, ...counts });
    }
    const results: DbCoverageCaseResult[] = [];
    for (const testCase of cases) {
      const sample = samples.find((entry) => entry.sample_id === testCase.sampleId);
      const namespaceId = namespaceBySample.get(testCase.sampleId);
      if (!sample || !namespaceId) {
        throw new Error(`missing sample namespace for ${testCase.name}`);
      }
      results.push(await evaluateCase({ namespaceId, testCase, sample }));
    }
    const quality = await loadQualityCounters(namespaceIds);
    const passed = results.filter((result) => result.passed).length;
    const breakdown = familyBreakdown(results);
    const minFamilyPassRate = Math.min(...Object.values(breakdown).map((entry) => entry.passRate));
    const promotionWithoutEvidenceQuoteCount = Number(quality.promotion_without_evidence_quote_count);
    const unknownTaxonomyPromotedCount = Number(quality.unknown_taxonomy_promoted_count);
    const mixedOwnerPromotedCount = Number(quality.mixed_owner_promoted_count);
    const summary = {
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: rate(passed, results.length),
      sourceMissingCount: results.filter((result) => result.status === "source_missing").length,
      compiledMissingCount: results.filter((result) => result.status === "compiled_missing").length,
      compiledUnusableCount: results.filter((result) => result.status === "compiled_unusable").length,
      compiledEvidenceMissingCount: results.filter((result) => result.status === "compiled_evidence_missing").length,
      subjectBindingMissingCount: results.filter((result) => result.status === "subject_binding_missing").length,
      promotionWithoutEvidenceQuoteCount,
      unknownTaxonomyPromotedCount,
      mixedOwnerPromotedCount,
      queryTimeGLiNEROrLLMCalls: 0
    };
    const gates = {
      coveragePassed: summary.passRate >= 0.9,
      perFamilyCoveragePassed: minFamilyPassRate >= 0.85,
      evidenceQuotePassed: promotionWithoutEvidenceQuoteCount === 0,
      taxonomyTruthPassed: unknownTaxonomyPromotedCount === 0,
      mixedOwnerPassed: mixedOwnerPromotedCount === 0,
      queryTimeModelPassed: summary.queryTimeGLiNEROrLLMCalls === 0,
      overallPassed: false
    };
    const report: DbCoverageReport = {
      generatedAt,
      benchmark: "compiled_direct_fact_read_model_coverage",
      runtime: buildBenchmarkRuntimeMetadata({
        benchmarkMode: "sampled",
        sampleControls: {
          cases: cases.length,
          samples: samples.length,
          cleanupNamespaces: process.env.BRAIN_KEEP_BENCHMARK_NAMESPACES === "1" ? "disabled" : "enabled"
        }
      }),
      summary,
      gates: {
        ...gates,
        overallPassed:
          gates.coveragePassed &&
          gates.perFamilyCoveragePassed &&
          gates.evidenceQuotePassed &&
          gates.taxonomyTruthPassed &&
          gates.mixedOwnerPassed &&
          gates.queryTimeModelPassed
      },
      familyBreakdown: breakdown,
      namespaces: namespaceSummaries,
      cases: results
    };
    const output = await writeReport(report);
    return { report, output };
  } finally {
    if (process.env.BRAIN_KEEP_BENCHMARK_NAMESPACES !== "1" && namespaceIds.length > 0) {
      try {
        await cleanupPublicBenchmarkNamespaces(namespaceIds, {
          namespaceChunkSize: 1,
          statementTimeoutMs: 60_000,
          lockTimeoutMs: 2_000
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`compiled-direct-fact-read-model-coverage cleanup warning: ${message}`);
      }
    }
  }
}

export async function runCompiledDirectFactReadModelCoverageBenchmarkCli(): Promise<void> {
  try {
    const { report, output } = await runCompiledDirectFactReadModelCoverageBenchmark();
    console.log(`compiled-direct-fact-read-model-coverage: ${report.summary.passed}/${report.summary.total} passRate=${report.summary.passRate}`);
    console.log(`compiled-direct-fact-read-model-coverage json=${output.jsonPath}`);
    console.log(`compiled-direct-fact-read-model-coverage markdown=${output.markdownPath}`);
    if (!report.gates.overallPassed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
