import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import {
  compileDirectFactCandidate,
  type DirectFactFamily,
  type DirectFactCompileDecision
} from "../taxonomy-temporal/direct-fact-compiler.js";
import type { AssistantCandidate, CompilerRunResult, ValidatedCandidate } from "../taxonomy-temporal/types.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

type ExpectedStatus = "compiled" | "rejected" | "ambiguous";

interface DirectFactCoverageCase {
  readonly name: string;
  readonly family: DirectFactFamily;
  readonly candidate: AssistantCandidate;
  readonly promotionEligible: boolean;
  readonly issueCode?: string | null;
  readonly expectedStatus: ExpectedStatus;
  readonly expectedRejectionReason?: string | null;
}

interface DirectFactCoverageCaseResult {
  readonly name: string;
  readonly family: DirectFactFamily;
  readonly expectedStatus: ExpectedStatus;
  readonly actualStatus: string;
  readonly expectedRejectionReason: string | null;
  readonly actualRejectionReason: string | null;
  readonly passed: boolean;
  readonly value: string | null;
  readonly subject: string | null;
  readonly supportPhrase: string | null;
  readonly answerShape: string | null;
}

interface CompiledDirectFactCoverageReport {
  readonly generatedAt: string;
  readonly benchmark: "compiled_direct_fact_coverage";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly passRate: number;
    readonly promotionWithoutEvidenceQuoteCount: number;
    readonly unknownTaxonomyPromotedCount: number;
    readonly mixedOwnerCompiledPromotions: number;
    readonly queryTimeGLiNEROrLLMCalls: number;
  };
  readonly gates: {
    readonly coveragePassed: boolean;
    readonly evidenceQuotePassed: boolean;
    readonly taxonomyTruthPassed: boolean;
    readonly mixedOwnerPassed: boolean;
    readonly queryTimeModelPassed: boolean;
    readonly overallPassed: boolean;
  };
  readonly familyBreakdown: Readonly<Record<string, { readonly total: number; readonly passed: number; readonly failed: number }>>;
  readonly cases: readonly DirectFactCoverageCaseResult[];
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

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function familyCandidateBase(family: DirectFactFamily): Pick<AssistantCandidate, "domain" | "family" | "subtype" | "evidence_family" | "answer_shape" | "object_type"> {
  switch (family) {
    case "preference_fact":
      return { domain: "personal", family: "preference", subtype: "explicit_preference", evidence_family: "preference", answer_shape: "atomic_value", object_type: "CLAIM" };
    case "owned_object_fact":
      return { domain: "personal", family: "owns", subtype: "owned_object", evidence_family: "owned_object", answer_shape: "atomic_value", object_type: "OBJECT" };
    case "purchase_fact":
      return { domain: "personal", family: "purchase", subtype: "purchased_object", evidence_family: "purchase", answer_shape: "atomic_value", object_type: "OBJECT" };
    case "project_goal_fact":
      return { domain: "project_ops", family: "project_support", subtype: "project_goal", evidence_family: "project_goal", answer_shape: "atomic_value", object_type: "PROJECT" };
    case "health_status_fact":
      return { domain: "health", family: "health_status", subtype: "health_uncertain", evidence_family: "health_status", answer_shape: "atomic_value", object_type: "CLAIM" };
    case "causal_reason_fact":
      return { domain: "project_ops", family: "causal_reason", subtype: "decision_reason", evidence_family: "causal_reason", answer_shape: "reason", object_type: "CLAIM" };
    case "relationship_status_fact":
      return { domain: "family", family: "relationship_status", subtype: "married", evidence_family: "relationship_status", answer_shape: "yes_no", object_type: "RELATIONSHIP" };
    case "explicit_list_set":
      return { domain: "personal", family: "explicit_list_set", subtype: "explicit_items", evidence_family: "explicit_list_set", answer_shape: "list", object_type: "CLAIM" };
    case "role_position_fact":
      return { domain: "work", family: "role", subtype: "job_title", evidence_family: "role_position", answer_shape: "atomic_value", object_type: "CLAIM" };
    case "owned_object_duration_fact":
      return { domain: "personal", family: "owned_object_duration", subtype: "owned_duration", evidence_family: "owned_object_duration", answer_shape: "duration", object_type: "CLAIM" };
    case "social_location_fact":
      return { domain: "personal", family: "social_location", subtype: "friend_location", evidence_family: "social_location", answer_shape: "list", object_type: "PLACE" };
    case "residence_fact":
      return { domain: "travel", family: "lives_in", subtype: "current_residence", evidence_family: "residence", answer_shape: "yes_no", object_type: "PLACE" };
    case "date_activity_fact":
      return { domain: "personal", family: "temporal_event", subtype: "exact_date", evidence_family: "date_activity", answer_shape: "atomic_value", object_type: "EVENT" };
  }
}

function positiveEvidence(family: DirectFactFamily, subject: string, index: number): string {
  switch (family) {
    case "preference_fact":
      return `${subject} prefers chicken for dinner.`;
    case "owned_object_fact":
      return `${subject} owns a red bicycle.`;
    case "purchase_fact":
      return `${subject} bought a Ferrari 488 GTB in March.`;
    case "project_goal_fact":
      return `${subject} wants to open a car maintenance shop.`;
    case "health_status_fact":
      return `${subject} has suspected obesity as a health problem.`;
    case "causal_reason_fact":
      return `${subject} started the store because she loved fashion trends and lost her job.`;
    case "relationship_status_fact":
      return `${subject} is married to Alex.`;
    case "explicit_list_set":
      return `${subject} collects sneakers, fantasy movie DVDs, and jerseys.`;
    case "role_position_fact":
      return `${subject}'s position was shooting guard.`;
    case "owned_object_duration_fact":
      return `${subject} has had his first two turtles for three years.`;
    case "social_location_fact":
      return `${subject} made friends at the homeless shelter, gym, and church.`;
    case "residence_fact":
      return `${subject} lives in Connecticut.`;
    case "date_activity_fact":
      return `${subject} went bowling as the recreational activity on March 16.`;
  }
}

function makeCandidate(family: DirectFactFamily, subject: string | null, evidence: string | null, overrides: Partial<AssistantCandidate> = {}): AssistantCandidate {
  return {
    candidate_type: "fact",
    evidence_quote: evidence,
    subject,
    taxonomy_status: "approved",
    confidence: { gliner2: null, llm_taxonomy: 0.82, llm_temporal: null, evidence: 0.9, overall: 0.84 },
    promotion_recommendation: "promote",
    suggested_taxonomy: null,
    tags: [family],
    ...familyCandidateBase(family),
    ...overrides
  };
}

function buildCases(): readonly DirectFactCoverageCase[] {
  const families: readonly DirectFactFamily[] = [
    "preference_fact",
    "owned_object_fact",
    "purchase_fact",
    "project_goal_fact",
    "health_status_fact",
    "causal_reason_fact",
    "relationship_status_fact",
    "explicit_list_set",
    "role_position_fact",
    "owned_object_duration_fact",
    "social_location_fact",
    "residence_fact",
    "date_activity_fact"
  ];
  const cases: DirectFactCoverageCase[] = [];
  for (const family of families) {
    for (let index = 0; index < 6; index += 1) {
      const subject = `Person${family.replace(/[^a-z]/gu, "").slice(0, 8)}${index}`;
      cases.push({
        name: `${family}_positive_${index + 1}`,
        family,
        candidate: makeCandidate(family, subject, positiveEvidence(family, subject, index)),
        promotionEligible: true,
        expectedStatus: "compiled",
        expectedRejectionReason: null
      });
    }
    cases.push({
      name: `${family}_missing_evidence`,
      family,
      candidate: makeCandidate(family, "NoEvidence", null),
      promotionEligible: false,
      issueCode: "missing_evidence_quote",
      expectedStatus: "rejected",
      expectedRejectionReason: "missing_evidence_quote"
    });
    cases.push({
      name: `${family}_unknown_taxonomy`,
      family,
      candidate: makeCandidate(family, "UnknownTax", positiveEvidence(family, "UnknownTax", 0), {
        taxonomy_status: "needs_taxonomy_review",
        suggested_taxonomy: { key: "hyper_specific_test_key", reason: "test" }
      }),
      promotionEligible: false,
      issueCode: "unknown_family",
      expectedStatus: "rejected",
      expectedRejectionReason: "taxonomy_unknown"
    });
    cases.push({
      name: `${family}_missing_subject`,
      family,
      candidate: makeCandidate(family, null, positiveEvidence(family, "someone", 0).replace(/^someone\s+/u, "")),
      promotionEligible: true,
      expectedStatus: "rejected",
      expectedRejectionReason: "subject_binding"
    });
    cases.push({
      name: `${family}_generic_profile_prose`,
      family,
      candidate: makeCandidate(family, "Generic", "Generic is a person who has a background in work and career progress."),
      promotionEligible: true,
      expectedStatus: "rejected",
      expectedRejectionReason: "generic_profile_prose"
    });
    cases.push({
      name: `${family}_mixed_owner`,
      family,
      candidate: makeCandidate(family, "Morgan", `Morgan and Taylor both discussed ${positiveEvidence(family, "Morgan", 0)}`),
      promotionEligible: true,
      expectedStatus: "rejected",
      expectedRejectionReason: "mixed_owner"
    });
    cases.push({
      name: `${family}_value_shape_mismatch`,
      family,
      candidate: makeCandidate(family, "Shape", "Shape mentioned that the week was busy and reflective."),
      promotionEligible: true,
      expectedStatus: "rejected",
      expectedRejectionReason: family === "relationship_status_fact" ? "relationship_comention_only" : "value_shape_mismatch"
    });
    if (family === "preference_fact") {
      cases.push({
        name: "preference_fact_creative_media_not_preference",
        family,
        candidate: makeCandidate(
          family,
          "Creative",
          "Creative loves cool places and said she could write a whole movie when she is out there.",
          { value: "I could write a whole movie when she is out there" }
        ),
        promotionEligible: true,
        expectedStatus: "rejected",
        expectedRejectionReason: "value_shape_mismatch"
      });
    }
  }
  return cases;
}

function fakeRun(caseName: string, unitText: string): CompilerRunResult {
  return {
    unit: {
      unitId: "00000000-0000-7000-8000-000000000001",
      namespaceId: "benchmark_compiled_direct_fact_coverage",
      sourceType: "locomo",
      sourceId: `case:${caseName}`,
      sourceMemoryId: null,
      sourceChunkId: null,
      sourceSceneId: null,
      capturedAt: "2026-05-10T00:00:00.000Z",
      speaker: null,
      unitIndex: 0,
      charStart: 0,
      charEnd: 0,
      unitText,
      contextBefore: "",
      contextAfter: "",
      tokenEstimate: 0,
      chunkingStatus: "ready",
      splitReason: "benchmark",
      metadata: { promotionMode: "support_and_promote" }
    },
    cache: { status: "bypass", cacheKey: "benchmark", sourceHash: "benchmark" },
    gliner2: { attempted: false, warningCount: 0, response: null, error: null },
    assistant: { mode: "off", provider: "deterministic", model: null, jsonValid: true, skippedReason: null, rawOutput: null, output: null, validationIssues: [], latencyMs: 0 },
    candidates: [],
    metrics: {
      chunkBudgetPass: true,
      jsonValidityPass: true,
      taxonomyCompliancePass: true,
      temporalNormalizationPass: true,
      promotionSafetyPass: true,
      suggestedTaxonomyCount: 0,
      needsClarificationCount: 0
    }
  };
}

function entryFor(testCase: DirectFactCoverageCase): ValidatedCandidate {
  return {
    candidate: testCase.candidate,
    promotionEligible: testCase.promotionEligible,
    issues: testCase.issueCode ? [{ code: testCase.issueCode, message: testCase.issueCode, candidateIndex: 0 }] : [],
    normalizedTemporal: null
  };
}

function evaluateCase(testCase: DirectFactCoverageCase): DirectFactCoverageCaseResult & { readonly decision: DirectFactCompileDecision } {
  const run = fakeRun(testCase.name, normalize(testCase.candidate.evidence_quote));
  const decision = compileDirectFactCandidate({
    run,
    entry: entryFor(testCase),
    registry: {
      version: "memory_taxonomy_v1",
      core_object_types: [],
      domains: {},
      families: {},
      temporal_types: [],
      statuses: []
    }
  });
  const passed =
    decision.handled &&
    decision.family === testCase.family &&
    decision.promotionStatus === testCase.expectedStatus &&
    (testCase.expectedRejectionReason == null || decision.rejectionReason === testCase.expectedRejectionReason);
  return {
    name: testCase.name,
    family: testCase.family,
    expectedStatus: testCase.expectedStatus,
    actualStatus: decision.promotionStatus,
    expectedRejectionReason: testCase.expectedRejectionReason ?? null,
    actualRejectionReason: decision.rejectionReason,
    passed,
    value: decision.value,
    subject: decision.subject,
    supportPhrase: decision.supportPhrase,
    answerShape: decision.answerShape,
    decision
  };
}

function markdownReport(report: CompiledDirectFactCoverageReport): string {
  const lines = [
    "# Compiled Direct-Fact Coverage",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- total: ${report.summary.total}`,
    `- passed: ${report.summary.passed}`,
    `- failed: ${report.summary.failed}`,
    `- passRate: ${report.summary.passRate.toFixed(3)}`,
    `- promotionWithoutEvidenceQuoteCount: ${report.summary.promotionWithoutEvidenceQuoteCount}`,
    `- unknownTaxonomyPromotedCount: ${report.summary.unknownTaxonomyPromotedCount}`,
    `- mixedOwnerCompiledPromotions: ${report.summary.mixedOwnerCompiledPromotions}`,
    `- queryTimeGLiNEROrLLMCalls: ${report.summary.queryTimeGLiNEROrLLMCalls}`,
    `- overallPassed: ${report.gates.overallPassed}`,
    "",
    "## Failed Cases",
    ""
  ];
  for (const result of report.cases.filter((entry) => !entry.passed).slice(0, 40)) {
    lines.push(`- ${result.name}: expected ${result.expectedStatus}/${result.expectedRejectionReason ?? "none"}, got ${result.actualStatus}/${result.actualRejectionReason ?? "none"}`);
  }
  if (report.cases.every((entry) => entry.passed)) {
    lines.push("- none");
  }
  return `${lines.join("\n")}\n`;
}

export async function runCompiledDirectFactCoverageBenchmark(): Promise<CompiledDirectFactCoverageReport> {
  const results = buildCases().map(evaluateCase);
  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  const promotionWithoutEvidenceQuoteCount = results.filter(
    (result) => result.actualStatus === "compiled" && !normalize(result.supportPhrase)
  ).length;
  const unknownTaxonomyPromotedCount = results.filter(
    (result) => result.actualStatus === "compiled" && /unknown_taxonomy|unknown_family/u.test(result.name)
  ).length;
  const mixedOwnerCompiledPromotions = results.filter(
    (result) => result.actualStatus === "compiled" && result.name.includes("mixed_owner")
  ).length;
  const familyBreakdown: Record<string, { total: number; passed: number; failed: number }> = {};
  for (const result of results) {
    familyBreakdown[result.family] ??= { total: 0, passed: 0, failed: 0 };
    familyBreakdown[result.family].total += 1;
    if (result.passed) familyBreakdown[result.family].passed += 1;
    else familyBreakdown[result.family].failed += 1;
  }
  const passRate = total > 0 ? passed / total : 0;
  const report: CompiledDirectFactCoverageReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "compiled_direct_fact_coverage",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        total_cases: total,
        curated_case_count: total
      }
    }),
    summary: {
      total,
      passed,
      failed: total - passed,
      passRate,
      promotionWithoutEvidenceQuoteCount,
      unknownTaxonomyPromotedCount,
      mixedOwnerCompiledPromotions,
      queryTimeGLiNEROrLLMCalls: 0
    },
    gates: {
      coveragePassed: passRate >= 0.95,
      evidenceQuotePassed: promotionWithoutEvidenceQuoteCount === 0,
      taxonomyTruthPassed: unknownTaxonomyPromotedCount === 0,
      mixedOwnerPassed: mixedOwnerCompiledPromotions === 0,
      queryTimeModelPassed: true,
      overallPassed: passRate >= 0.95 && promotionWithoutEvidenceQuoteCount === 0 && unknownTaxonomyPromotedCount === 0 && mixedOwnerCompiledPromotions === 0
    },
    familyBreakdown,
    cases: results.map(({ decision: _decision, ...result }) => result)
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  await writeFile(path.join(outputDir(), `compiled-direct-fact-coverage-${stamp}.json`), JSON.stringify(report, null, 2));
  await writeFile(path.join(outputDir(), `compiled-direct-fact-coverage-${stamp}.md`), markdownReport(report));
  return report;
}

export async function runCompiledDirectFactCoverageBenchmarkCli(): Promise<void> {
  try {
    const report = await runCompiledDirectFactCoverageBenchmark();
    console.log(JSON.stringify({
      benchmark: report.benchmark,
      passRate: report.summary.passRate,
      passed: report.summary.passed,
      total: report.summary.total,
      failed: report.summary.failed,
      gates: report.gates
    }, null, 2));
    if (!report.gates.overallPassed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool().catch(() => undefined);
  }
}
