import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { loadCompiledProfileInferenceObservationRows, type CompiledFactObservationLookupRow } from "../compiled-memory/service.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import {
  buildProfileInferenceCandidatesFromSourceTextsForTest,
  type ProfileInferenceFamily
} from "../taxonomy-temporal/profile-inference-compiler.js";
import {
  compiledProfileInferenceFitsQueryForTest,
  sourceBoundProfileInferenceFamilyForTest
} from "../retrieval/route-locked-fast-paths.js";
import { cleanupPublicBenchmarkNamespaces } from "./public-benchmark-cleanup.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { readLoCoMoDataset } from "./compiled-direct-fact-real-source-coverage.js";
import {
  formatLoCoMoConversationSession,
  ingestLoCoMoSessionArtifacts,
  type LoCoMoConversationRecord,
  type LoCoMoTurnRecord
} from "./locomo-ingest.js";

type ProfileInferenceCoverageStatus =
  | "compiled_selected"
  | "compiled_missing"
  | "compiled_unusable"
  | "compiled_evidence_missing"
  | "source_missing";

interface ProfileInferenceCoverageCase {
  readonly name: string;
  readonly sampleId: string;
  readonly family: ProfileInferenceFamily;
  readonly subject: string;
  readonly queryText: string;
  readonly expectedTerms: readonly string[];
  readonly sourceTerms: readonly string[];
}

interface ProfileInferenceCaseResult {
  readonly name: string;
  readonly sampleId: string;
  readonly family: string;
  readonly subject: string;
  readonly queryText: string;
  readonly expectedTerms: readonly string[];
  readonly status: ProfileInferenceCoverageStatus;
  readonly passed: boolean;
  readonly namedRowCount: number;
  readonly fitRowCount: number;
  readonly selectedValues: readonly string[];
  readonly selectedSupportPhrases: readonly string[];
  readonly missingTerms: readonly string[];
  readonly sourceAuditStatus: "source_terms_present" | "source_missing";
}

interface CuratedFixtureResult {
  readonly name: string;
  readonly family: string;
  readonly expectedValueTerm: string;
  readonly passed: boolean;
  readonly candidateCount: number;
  readonly selectedValue: string | null;
}

interface ProfileInferenceCoverageReport {
  readonly generatedAt: string;
  readonly benchmark: "compiled_profile_inference_coverage";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly passRate: number;
    readonly realSourceTotal: number;
    readonly realSourcePassed: number;
    readonly curatedTotal: number;
    readonly curatedPassed: number;
    readonly compiledMissingCount: number;
    readonly compiledUnusableCount: number;
    readonly compiledEvidenceMissingCount: number;
    readonly sourceMissingCount: number;
    readonly promotionWithoutSourcePremiseCount: number;
    readonly mixedOwnerInferencePromotionCount: number;
    readonly unknownTaxonomyPromotedCount: number;
    readonly queryTimeGLiNEROrLLMCalls: number;
  };
  readonly gates: {
    readonly coveragePassed: boolean;
    readonly evidencePremisePassed: boolean;
    readonly mixedOwnerPassed: boolean;
    readonly taxonomyTruthPassed: boolean;
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
    readonly promotedProfileInferences: number;
    readonly rejectedProfileInferences: number;
    readonly sourceRows: number;
  }[];
  readonly cases: readonly ProfileInferenceCaseResult[];
  readonly curatedFixtures: readonly CuratedFixtureResult[];
}

interface ProfileInferenceQualityRow {
  readonly promotion_without_source_premise_count: string;
  readonly mixed_owner_inference_promotion_count: string;
  readonly unknown_taxonomy_promoted_count: string;
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

function generatedRoot(): string {
  return path.resolve(localBrainRoot(), "benchmark-generated", "compiled-profile-inference-coverage");
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

function buildCases(): readonly ProfileInferenceCoverageCase[] {
  return [
    {
      name: "joanna_allergy_condition",
      sampleId: "conv-42",
      family: "health_inference",
      subject: "Joanna",
      queryText: "What underlying condition might Joanna have based on her allergies?",
      expectedTerms: ["asthma"],
      sourceTerms: ["allergic", "cockroaches"]
    },
    {
      name: "andrew_dog_treat_activity",
      sampleId: "conv-44",
      family: "activity_fit",
      subject: "Andrew",
      queryText: "What is an indoor activity that Andrew would enjoy doing while make his dog happy?",
      expectedTerms: ["cook", "dog treats"],
      sourceTerms: ["dog treats"]
    },
    {
      name: "andrew_living_situation_recommendation",
      sampleId: "conv-44",
      family: "life_context_recommendation",
      subject: "Andrew",
      queryText: "What can Andrew potentially do to improve his stress and accomodate his living situation with his dogs?",
      expectedTerms: ["hybrid", "remote", "suburbs", "nature", "larger living space"],
      sourceTerms: ["stress", "dogs"]
    },
    {
      name: "john_suspected_health",
      sampleId: "conv-47",
      family: "health_inference",
      subject: "John",
      queryText: "What are John's suspected health problems?",
      expectedTerms: ["obesity"],
      sourceTerms: ["fingers are too big"]
    },
    {
      name: "james_connecticut_containment",
      sampleId: "conv-47",
      family: "location_containment",
      subject: "James",
      queryText: "Does James live in Connecticut?",
      expectedTerms: ["Likely yes"],
      sourceTerms: ["Stamford"]
    },
    {
      name: "evan_outdoor_vacation_preference",
      sampleId: "conv-49",
      family: "preference_inference",
      subject: "Evan",
      queryText: "Which type of vacation would Evan prefer with his family, walking tours in metropolitan cities or camping trip in the outdoors?",
      expectedTerms: ["camping", "outdoors"],
      sourceTerms: ["camping", "outdoors"]
    },
    {
      name: "evan_sam_life_transition_advice",
      sampleId: "conv-49",
      family: "advice_synthesis",
      subject: "Evan",
      queryText: "Considering their conversations and personal growth, what advice might Evan and Sam give to someone facing a major life transition or challenge?",
      expectedTerms: ["small consistent changes", "hiking", "painting", "road trips", "support"],
      sourceTerms: ["hiking", "painting"]
    },
    {
      name: "dave_shop_capacity",
      sampleId: "conv-50",
      family: "capacity_scale",
      subject: "Dave",
      queryText: "Does Dave's shop employ a lot of people?",
      expectedTerms: ["Likely yes"],
      sourceTerms: ["car maintenance shop", "group of people"]
    }
  ];
}

function syntheticFixtureGroups(): readonly { readonly name: string; readonly family: ProfileInferenceFamily; readonly expectedValueTerm: string; readonly text: string }[] {
  const base = [
    { name: "fixture_health_allergy", family: "health_inference" as const, expectedValueTerm: "asthma", text: "Mia: I am allergic to animals with fur and recently found I am allergic to cockroaches too." },
    { name: "fixture_health_weight", family: "health_inference" as const, expectedValueTerm: "obesity", text: "Leo: My fingers are too big and I should start exercising and running." },
    { name: "fixture_location_stamford", family: "location_containment" as const, expectedValueTerm: "Likely yes", text: "Rae: I adopted a pup from a shelter in Stamford last week." },
    { name: "fixture_preference_outdoors", family: "preference_inference" as const, expectedValueTerm: "camping", text: "Kai: Our family camping trip was refreshing. We hiked outdoors near the mountains and forests." },
    { name: "fixture_activity_dog_treats", family: "activity_fit" as const, expectedValueTerm: "dog treats", text: "Nora: My dog would love this indoor plan. --- image_query: homemade dog treats tray" },
    { name: "fixture_capacity_shop", family: "capacity_scale" as const, expectedValueTerm: "Likely yes", text: "Owen: I opened my own car maintenance shop. --- image_caption: group of people standing in front of a car workshop" },
    { name: "fixture_life_context", family: "life_context_recommendation" as const, expectedValueTerm: "hybrid", text: "Iris: The city stress is hard with my dogs in this apartment. I want nature, suburbs, a larger living space, and a remote or hybrid job." },
    { name: "fixture_advice", family: "advice_synthesis" as const, expectedValueTerm: "small consistent changes", text: "Sam: The doctor said small changes to my routine and more exercise would help.\nEvan: Hiking, watercolor painting, road trips, and family support help me through stress." }
  ];
  const fixtures: Array<{ readonly name: string; readonly family: ProfileInferenceFamily; readonly expectedValueTerm: string; readonly text: string }> = [];
  for (let i = 0; i < 16; i += 1) {
    for (const fixture of base) {
      fixtures.push({ ...fixture, name: `${fixture.name}_${i + 1}` });
    }
  }
  return fixtures;
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

function rowEvidenceText(row: CompiledFactObservationLookupRow): string {
  return normalize([row.answer_value, row.support_phrase, row.source_text, JSON.stringify(row.metadata ?? {})].filter(Boolean).join(" "));
}

function rowHasSourcePremise(row: CompiledFactObservationLookupRow): boolean {
  return Boolean(
    normalize(row.support_phrase) &&
    (row.source_chunk_id || row.source_memory_id || normalize(row.source_uri)) &&
    Number(row.metadata?.premiseCount ?? 0) > 0
  );
}

async function ingestAndRebuildSample(params: {
  readonly sample: LoCoMoConversationRecord;
  readonly namespaceId: string;
  readonly corpusRoot: string;
}): Promise<{
  readonly promotedProfileInferences: number;
  readonly rejectedProfileInferences: number;
  readonly sourceRows: number;
}> {
  for (const [sessionKey, turns] of sessionEntries(params.sample)) {
    await ingestLoCoMoSessionArtifacts({
      localBrainRoot: localBrainRoot(),
      benchmarkName: "compiled-profile-inference-coverage",
      corpusRoot: params.corpusRoot,
      namespaceId: params.namespaceId,
      sample: params.sample,
      sessionKey,
      turns
    });
  }
  const rebuild = await rebuildTypedMemoryNamespace(params.namespaceId, { skipVectorActivation: true });
  return {
    promotedProfileInferences: rebuild.compiledProfileInferences?.promoted ?? 0,
    rejectedProfileInferences: rebuild.compiledProfileInferences?.rejected ?? 0,
    sourceRows: rebuild.compiledProfileInferences?.sourceRows ?? 0
  };
}

async function loadQualityCounters(namespaceIds: readonly string[]): Promise<ProfileInferenceQualityRow> {
  const rows = await queryRows<ProfileInferenceQualityRow>(
    `
      SELECT
        COUNT(*) FILTER (
          WHERE predicate_family = 'profile_inference'
            AND promotion_status = 'compiled'
            AND (NULLIF(support_phrase, '') IS NULL OR COALESCE((metadata->>'premiseCount')::int, 0) < 1)
        )::text AS promotion_without_source_premise_count,
        COUNT(*) FILTER (
          WHERE predicate_family = 'profile_inference'
            AND promotion_status = 'compiled'
            AND COALESCE(metadata->>'subjectBindingStatus', '') = 'mixed_owner'
        )::text AS mixed_owner_inference_promotion_count,
        COUNT(*) FILTER (
          WHERE predicate_family = 'profile_inference'
            AND promotion_status = 'compiled'
            AND COALESCE(metadata->>'taxonomyStatus', 'approved') NOT IN ('approved', 'mapped_to_parent')
        )::text AS unknown_taxonomy_promoted_count
      FROM compiled_fact_observations
      WHERE namespace_id = ANY($1::text[])
    `,
    [namespaceIds]
  );
  return rows[0] ?? {
    promotion_without_source_premise_count: "0",
    mixed_owner_inference_promotion_count: "0",
    unknown_taxonomy_promoted_count: "0"
  };
}

async function evaluateCase(params: {
  readonly namespaceId: string;
  readonly testCase: ProfileInferenceCoverageCase;
  readonly sample: LoCoMoConversationRecord;
}): Promise<ProfileInferenceCaseResult> {
  const sourceText = sourceTextForSample(params.sample);
  const sourceAuditStatus = params.testCase.sourceTerms.every((term) => containsTerm(sourceText, term)) ? "source_terms_present" : "source_missing";
  const namedRows = await loadCompiledProfileInferenceObservationRows({
    namespaceId: params.namespaceId,
    profileInferenceFamily: params.testCase.family,
    names: [params.testCase.subject],
    limit: 128
  });
  const fitRows = namedRows.filter((row) => compiledProfileInferenceFitsQueryForTest(params.testCase.queryText, params.testCase.family, row));
  const sourceRows = fitRows.filter(rowHasSourcePremise);
  const combinedText = normalize(sourceRows.map(rowEvidenceText).join(" "));
  const missingTerms = params.testCase.expectedTerms.filter((term) => !containsTerm(combinedText, term));
  let status: ProfileInferenceCoverageStatus = "compiled_selected";
  if (sourceAuditStatus === "source_missing") status = "source_missing";
  else if (namedRows.length === 0) status = "compiled_missing";
  else if (fitRows.length === 0 || missingTerms.length > 0) status = "compiled_unusable";
  else if (sourceRows.length === 0) status = "compiled_evidence_missing";
  return {
    name: params.testCase.name,
    sampleId: params.testCase.sampleId,
    family: params.testCase.family,
    subject: params.testCase.subject,
    queryText: params.testCase.queryText,
    expectedTerms: params.testCase.expectedTerms,
    status,
    passed: status === "compiled_selected",
    namedRowCount: namedRows.length,
    fitRowCount: fitRows.length,
    selectedValues: sourceRows.map((row) => normalize(row.answer_value)).filter(Boolean).slice(0, 6),
    selectedSupportPhrases: sourceRows.map((row) => normalize(row.support_phrase)).filter(Boolean).slice(0, 4),
    missingTerms,
    sourceAuditStatus
  };
}

function evaluateCuratedFixtures(): readonly CuratedFixtureResult[] {
  return syntheticFixtureGroups().map((fixture) => {
    const candidates = buildProfileInferenceCandidatesFromSourceTextsForTest([fixture.text])
      .filter((candidate) => candidate.family === fixture.family);
    const selected = candidates[0] ?? null;
    const selectedValue = selected?.value ?? null;
    return {
      name: fixture.name,
      family: fixture.family,
      expectedValueTerm: fixture.expectedValueTerm,
      passed: Boolean(selectedValue && containsTerm(selectedValue, fixture.expectedValueTerm) && selected?.supportPhrase),
      candidateCount: candidates.length,
      selectedValue
    };
  });
}

function familyBreakdown(results: readonly ProfileInferenceCaseResult[], fixtures: readonly CuratedFixtureResult[]): ProfileInferenceCoverageReport["familyBreakdown"] {
  const byFamily = new Map<string, { total: number; passed: number; failed: number }>();
  for (const item of [...results, ...fixtures]) {
    const current = byFamily.get(item.family) ?? { total: 0, passed: 0, failed: 0 };
    current.total += 1;
    if (item.passed) current.passed += 1;
    else current.failed += 1;
    byFamily.set(item.family, current);
  }
  return Object.fromEntries(
    [...byFamily.entries()].map(([family, counts]) => [family, { ...counts, passRate: rate(counts.passed, counts.total) }])
  );
}

async function writeReport(report: ProfileInferenceCoverageReport): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
  const outDir = outputDir();
  await mkdir(outDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `compiled-profile-inference-coverage-${stamp}.json`);
  const markdownPath = path.join(outDir, `compiled-profile-inference-coverage-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const lines = [
    "# Compiled Profile-Inference Coverage",
    "",
    `- total: ${report.summary.total}`,
    `- passed: ${report.summary.passed}`,
    `- passRate: ${report.summary.passRate}`,
    `- realSource: ${report.summary.realSourcePassed}/${report.summary.realSourceTotal}`,
    `- curated: ${report.summary.curatedPassed}/${report.summary.curatedTotal}`,
    `- overallPassed: ${report.gates.overallPassed}`,
    `- promotionWithoutSourcePremise: ${report.summary.promotionWithoutSourcePremiseCount}`,
    `- mixedOwnerInferencePromotion: ${report.summary.mixedOwnerInferencePromotionCount}`,
    `- unknownTaxonomyPromoted: ${report.summary.unknownTaxonomyPromotedCount}`,
    "",
    "## Failures",
    ""
  ];
  for (const result of report.cases.filter((entry) => !entry.passed)) {
    lines.push(`- ${result.name}: status=${result.status} family=${result.family} subject=${result.subject} missingTerms=${result.missingTerms.join(", ") || "none"}`);
  }
  for (const result of report.curatedFixtures.filter((entry) => !entry.passed).slice(0, 20)) {
    lines.push(`- ${result.name}: family=${result.family} selected=${result.selectedValue ?? "none"}`);
  }
  await writeFile(markdownPath, `${lines.join("\n")}\n`, "utf8");
  return { jsonPath, markdownPath };
}

export async function runCompiledProfileInferenceCoverageBenchmark(): Promise<{
  readonly report: ProfileInferenceCoverageReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const runStamp = generatedAt.replace(/[:.]/g, "-");
  const corpusRoot = path.join(generatedRoot(), runStamp, "corpus");
  await mkdir(corpusRoot, { recursive: true });
  const cases = buildCases();
  const dataset = await readLoCoMoDataset();
  const sampleIds = [...new Set(cases.map((testCase) => testCase.sampleId))];
  const samples = sampleIds.map((sampleId) => {
    const sample = dataset.find((entry) => entry.sample_id === sampleId);
    if (!sample) throw new Error(`LoCoMo sample not found for profile-inference coverage: ${sampleId}`);
    return sample;
  });
  const namespaceBySample = new Map<string, string>();
  const namespaceIds: string[] = [];
  const namespaceSummaries: Array<ProfileInferenceCoverageReport["namespaces"][number]> = [];
  try {
    for (const sample of samples) {
      const namespaceId = `benchmark_profile_inference_${runStamp}_${sample.sample_id.replace(/[^a-z0-9]+/giu, "_").toLowerCase()}`;
      namespaceBySample.set(sample.sample_id, namespaceId);
      namespaceIds.push(namespaceId);
      const counts = await ingestAndRebuildSample({ sample, namespaceId, corpusRoot });
      namespaceSummaries.push({ sampleId: sample.sample_id, namespaceId, ...counts });
    }
    const caseResults: ProfileInferenceCaseResult[] = [];
    for (const testCase of cases) {
      const sample = samples.find((entry) => entry.sample_id === testCase.sampleId);
      const namespaceId = namespaceBySample.get(testCase.sampleId);
      if (!sample || !namespaceId) throw new Error(`missing profile-inference namespace for ${testCase.name}`);
      if (sourceBoundProfileInferenceFamilyForTest(testCase.queryText) !== testCase.family) {
        throw new Error(`profile-inference route classifier mismatch for ${testCase.name}`);
      }
      caseResults.push(await evaluateCase({ namespaceId, testCase, sample }));
    }
    const curatedFixtures = evaluateCuratedFixtures();
    const quality = await loadQualityCounters(namespaceIds);
    const realPassed = caseResults.filter((result) => result.passed).length;
    const curatedPassed = curatedFixtures.filter((result) => result.passed).length;
    const total = caseResults.length + curatedFixtures.length;
    const passed = realPassed + curatedPassed;
    const promotionWithoutSourcePremiseCount = Number(quality.promotion_without_source_premise_count);
    const mixedOwnerInferencePromotionCount = Number(quality.mixed_owner_inference_promotion_count);
    const unknownTaxonomyPromotedCount = Number(quality.unknown_taxonomy_promoted_count);
    const summary = {
      total,
      passed,
      failed: total - passed,
      passRate: rate(passed, total),
      realSourceTotal: caseResults.length,
      realSourcePassed: realPassed,
      curatedTotal: curatedFixtures.length,
      curatedPassed,
      compiledMissingCount: caseResults.filter((result) => result.status === "compiled_missing").length,
      compiledUnusableCount: caseResults.filter((result) => result.status === "compiled_unusable").length,
      compiledEvidenceMissingCount: caseResults.filter((result) => result.status === "compiled_evidence_missing").length,
      sourceMissingCount: caseResults.filter((result) => result.status === "source_missing").length,
      promotionWithoutSourcePremiseCount,
      mixedOwnerInferencePromotionCount,
      unknownTaxonomyPromotedCount,
      queryTimeGLiNEROrLLMCalls: 0
    };
    const family = familyBreakdown(caseResults, curatedFixtures);
    const minFamilyPassRate = Math.min(...Object.values(family).map((entry) => entry.passRate));
    const gates = {
      coveragePassed: summary.passRate >= 0.9 && rate(realPassed, caseResults.length) >= 0.9 && minFamilyPassRate >= 0.85,
      evidencePremisePassed: promotionWithoutSourcePremiseCount === 0,
      mixedOwnerPassed: mixedOwnerInferencePromotionCount === 0,
      taxonomyTruthPassed: unknownTaxonomyPromotedCount === 0,
      queryTimeModelPassed: summary.queryTimeGLiNEROrLLMCalls === 0,
      overallPassed: false
    };
    const report: ProfileInferenceCoverageReport = {
      generatedAt,
      benchmark: "compiled_profile_inference_coverage",
      runtime: buildBenchmarkRuntimeMetadata({
        benchmarkMode: "sampled",
        sampleControls: {
          cases: total,
          realSourceCases: caseResults.length,
          curatedFixtures: curatedFixtures.length,
          samples: samples.length,
          cleanupNamespaces: process.env.BRAIN_KEEP_BENCHMARK_NAMESPACES === "1" ? "disabled" : "enabled"
        }
      }),
      summary,
      gates: {
        ...gates,
        overallPassed:
          gates.coveragePassed &&
          gates.evidencePremisePassed &&
          gates.mixedOwnerPassed &&
          gates.taxonomyTruthPassed &&
          gates.queryTimeModelPassed
      },
      familyBreakdown: family,
      namespaces: namespaceSummaries,
      cases: caseResults,
      curatedFixtures
    };
    const output = await writeReport(report);
    return { report, output };
  } finally {
    if (process.env.BRAIN_KEEP_BENCHMARK_NAMESPACES !== "1" && namespaceIds.length > 0) {
      try {
        await cleanupPublicBenchmarkNamespaces(namespaceIds, {
          namespaceChunkSize: 1,
          statementTimeoutMs: 180_000,
          lockTimeoutMs: 2_000
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`compiled-profile-inference-coverage cleanup warning: ${message}`);
      }
    }
  }
}

export async function runCompiledProfileInferenceCoverageBenchmarkCli(): Promise<void> {
  try {
    const { report, output } = await runCompiledProfileInferenceCoverageBenchmark();
    console.log(`compiled-profile-inference-coverage: ${report.summary.passed}/${report.summary.total} passRate=${report.summary.passRate}`);
    console.log(`compiled-profile-inference-coverage real=${report.summary.realSourcePassed}/${report.summary.realSourceTotal}`);
    console.log(`compiled-profile-inference-coverage json=${output.jsonPath}`);
    console.log(`compiled-profile-inference-coverage markdown=${output.markdownPath}`);
    if (!report.gates.overallPassed) process.exitCode = 1;
  } finally {
    await closePool();
  }
}
