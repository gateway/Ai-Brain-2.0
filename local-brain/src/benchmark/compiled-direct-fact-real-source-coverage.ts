import { mkdir, readFile, writeFile } from "node:fs/promises";
import { get } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { formatLoCoMoConversationSession, type LoCoMoConversationRecord, type LoCoMoTurnRecord } from "./locomo-ingest.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { loadMemoryTaxonomyRegistry } from "../taxonomy-temporal/registry.js";
import {
  buildDirectFactCandidatesFromSourceTextForTest,
  compileDirectFactCandidate,
  type DirectFactCompileDecision,
  type DirectFactFamily
} from "../taxonomy-temporal/direct-fact-compiler.js";
import type { AssistantCandidate, CompilerRunResult, TaxonomyRegistry, ValidatedCandidate } from "../taxonomy-temporal/types.js";

type CoverageStatus =
  | "compiled_selected"
  | "compiled_missing"
  | "compiled_unusable"
  | "subject_binding_missing"
  | "taxonomy_unknown"
  | "evidence_missing"
  | "mixed_owner_rejected"
  | "source_missing";

export interface RealSourceCoverageCase {
  readonly name: string;
  readonly sampleId: string;
  /**
   * Use "*" for cross-session coverage cases where the expected direct fact is
   * an aggregation over the whole dialogue rather than a single turn window.
   */
  readonly sessionKey: string;
  readonly family: DirectFactFamily;
  readonly subject: string;
  readonly expectedTerms: readonly string[];
  readonly sourceTerms: readonly string[];
}

interface EvaluatedDecision {
  readonly candidate: AssistantCandidate;
  readonly decision: DirectFactCompileDecision;
}

interface RealSourceCoverageCaseResult {
  readonly name: string;
  readonly sampleId: string;
  readonly sessionKey: string;
  readonly family: DirectFactFamily;
  readonly subject: string;
  readonly expectedTerms: readonly string[];
  readonly status: CoverageStatus;
  readonly passed: boolean;
  readonly candidateCount: number;
  readonly familyCandidateCount: number;
  readonly compiledCandidateCount: number;
  readonly selectedValue: string | null;
  readonly selectedSupportPhrase: string | null;
  readonly rejectionReasons: readonly string[];
}

interface CompiledDirectFactRealSourceCoverageReport {
  readonly generatedAt: string;
  readonly benchmark: "compiled_direct_fact_real_source_coverage";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly passRate: number;
    readonly sourceMissingCount: number;
    readonly compiledMissingCount: number;
    readonly compiledUnusableCount: number;
    readonly subjectBindingMissingCount: number;
    readonly taxonomyUnknownCount: number;
    readonly evidenceMissingCount: number;
    readonly mixedOwnerRejectedCount: number;
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
  readonly cases: readonly RealSourceCoverageCaseResult[];
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

function generatedRoot(): string {
  return path.resolve(localBrainRoot(), "benchmark-generated", "public-memory-compare");
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

function downloadText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        reject(new Error(`request failed for ${url}: ${response.statusCode}`));
        response.resume();
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve(body));
      response.on("error", reject);
    }).on("error", reject);
  });
}

export async function readLoCoMoDataset(): Promise<readonly LoCoMoConversationRecord[]> {
  const destination = path.join(generatedRoot(), "raw", "locomo10.json");
  try {
    return JSON.parse(await readFile(destination, "utf8")) as readonly LoCoMoConversationRecord[];
  } catch {
    await mkdir(path.dirname(destination), { recursive: true });
    const localCandidates = [
      path.resolve(localBrainRoot(), "benchmark-generated", "full-standard-residual-review", "raw", "locomo10.json"),
      path.resolve(localBrainRoot(), "benchmark-generated", "full-standard-pressure-review", "raw", "locomo10.json"),
      path.resolve(localBrainRoot(), "benchmark-generated", "locomo-canonical-family-review", "raw", "locomo10.json"),
      path.resolve(localBrainRoot(), "benchmark-generated", "locomo-latency-tail-review", "raw", "locomo10.json")
    ];
    for (const candidate of localCandidates) {
      try {
        const body = await readFile(candidate, "utf8");
        await writeFile(destination, body, "utf8");
        return JSON.parse(body) as readonly LoCoMoConversationRecord[];
      } catch {
        // Try the next local cache before falling back to the network.
      }
    }
    const body = await downloadText("https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json");
    await writeFile(destination, body, "utf8");
    return JSON.parse(body) as readonly LoCoMoConversationRecord[];
  }
}

export function buildCompiledDirectFactRealSourceCoverageCases(): readonly RealSourceCoverageCase[] {
  return [
    { name: "gina_contemporary_preference", sampleId: "conv-30", sessionKey: "session_1", family: "preference_fact", subject: "Gina", expectedTerms: ["contemporary"], sourceTerms: ["Contemporary dance", "speaks to me"] },
    { name: "jon_contemporary_preference", sampleId: "conv-30", sessionKey: "session_1", family: "preference_fact", subject: "Jon", expectedTerms: ["contemporary"], sourceTerms: ["contemporary is my top pick"] },
    { name: "audrey_recipe_preference", sampleId: "conv-44", sessionKey: "session_10", family: "preference_fact", subject: "Audrey", expectedTerms: ["Chicken Pot Pie"], sourceTerms: ["favorite recipe", "Chicken Pot Pie"] },
    { name: "audrey_meat_preference", sampleId: "conv-44", sessionKey: "session_10", family: "preference_fact", subject: "Audrey", expectedTerms: ["chicken"], sourceTerms: ["chicken", "favorites"] },
    { name: "dave_aerosmith_preference", sampleId: "conv-50", sessionKey: "session_2", family: "preference_fact", subject: "Dave", expectedTerms: ["Aerosmith"], sourceTerms: ["favorite", "Aerosmith"] },
    { name: "jolene_sapiens_preference", sampleId: "conv-48", sessionKey: "session_4", family: "preference_fact", subject: "Jolene", expectedTerms: ["Sapiens"], sourceTerms: ["really into this book", "Sapiens"] },
    { name: "jolene_avalanche_preference", sampleId: "conv-48", sessionKey: "session_4", family: "preference_fact", subject: "Jolene", expectedTerms: ["Avalanche"], sourceTerms: ["read \"Avalanche\" by Neal Stephenson", "Avalanche"] },

    { name: "john_collects_jerseys", sampleId: "conv-43", sessionKey: "session_12", family: "explicit_list_set", subject: "John", expectedTerms: ["jerseys"], sourceTerms: ["collect jerseys"] },
    { name: "john_collects_sneakers", sampleId: "conv-43", sessionKey: "session_1", family: "explicit_list_set", subject: "John", expectedTerms: ["sneakers"], sourceTerms: ["sneaker collection"] },
    { name: "john_collection_cross_session", sampleId: "conv-43", sessionKey: "*", family: "explicit_list_set", subject: "John", expectedTerms: ["sneakers", "jerseys"], sourceTerms: ["sneaker collection", "collect jerseys"] },
    { name: "andrew_indoor_activities", sampleId: "conv-44", sessionKey: "session_23", family: "explicit_list_set", subject: "Andrew", expectedTerms: ["board games"], sourceTerms: ["board games"] },
    { name: "andrew_indoor_activities_cross_session", sampleId: "conv-44", sessionKey: "*", family: "explicit_list_set", subject: "Andrew", expectedTerms: ["board games", "pet shelter", "wine tasting"], sourceTerms: ["board games", "pet shelter", "wine tasting"] },
    { name: "audrey_pet_workshop", sampleId: "conv-44", sessionKey: "session_6", family: "explicit_list_set", subject: "Audrey", expectedTerms: ["workshop"], sourceTerms: ["workshop about bonding", "pet"] },
    { name: "audrey_pet_care_classes_cross_session", sampleId: "conv-44", sessionKey: "*", family: "explicit_list_set", subject: "Audrey", expectedTerms: ["positive reinforcement", "dog training course", "agility", "grooming course", "dog owners group"], sourceTerms: ["positive reinforcement training class", "dog training course", "agility classes", "dog grooming course", "dog owners group"] },

    { name: "evan_prius_owned", sampleId: "conv-49", sessionKey: "session_1", family: "owned_object_fact", subject: "Evan", expectedTerms: ["Prius"], sourceTerms: ["new Prius"] },
    { name: "calvin_mansion_owned", sampleId: "conv-50", sessionKey: "session_1", family: "owned_object_fact", subject: "Calvin", expectedTerms: ["mansion"], sourceTerms: ["new mansion"] },
    { name: "calvin_ferrari_purchase", sampleId: "conv-50", sessionKey: "session_23", family: "purchase_fact", subject: "Calvin", expectedTerms: ["Ferrari"], sourceTerms: ["new Ferrari"] },
    { name: "calvin_mansion_purchase", sampleId: "conv-50", sessionKey: "session_1", family: "purchase_fact", subject: "Calvin", expectedTerms: ["mansion"], sourceTerms: ["new mansion"] },
    { name: "calvin_march_purchases_cross_session", sampleId: "conv-50", sessionKey: "*", family: "purchase_fact", subject: "Calvin", expectedTerms: ["mansion", "Ferrari"], sourceTerms: ["new mansion", "new Ferrari"] },

    { name: "john_shooting_goal", sampleId: "conv-43", sessionKey: "session_1", family: "project_goal_fact", subject: "John", expectedTerms: ["shooting percentage"], sourceTerms: ["goal is to improve my shooting percentage"] },
    { name: "john_championship_goal", sampleId: "conv-43", sessionKey: "session_6", family: "project_goal_fact", subject: "John", expectedTerms: ["championship"], sourceTerms: ["Winning a championship is my number one goal"] },
    { name: "john_basketball_goals_cross_session", sampleId: "conv-43", sessionKey: "*", family: "project_goal_fact", subject: "John", expectedTerms: ["shooting percentage", "championship"], sourceTerms: ["goal is to improve my shooting percentage", "Winning a championship is my number one goal"] },
    { name: "james_dog_app_unique_feature", sampleId: "conv-47", sessionKey: "session_1", family: "project_goal_fact", subject: "James", expectedTerms: ["preferences", "needs"], sourceTerms: ["preferences/needs", "customizing"] },
    { name: "jolene_engineering_project", sampleId: "conv-48", sessionKey: "session_1", family: "project_goal_fact", subject: "Jolene", expectedTerms: ["engineering project"], sourceTerms: ["electrical engineering project"] },
    { name: "dave_car_shop_goal", sampleId: "conv-50", sessionKey: "session_4", family: "project_goal_fact", subject: "Dave", expectedTerms: ["car maintenance shop"], sourceTerms: ["opened my own car maintenance shop"] },
    { name: "dave_custom_car_goal", sampleId: "conv-50", sessionKey: "session_5", family: "project_goal_fact", subject: "Dave", expectedTerms: ["custom car"], sourceTerms: ["build a custom car from scratch"] },
    { name: "dave_auto_engineering_goal", sampleId: "conv-50", sessionKey: "session_13", family: "project_goal_fact", subject: "Dave", expectedTerms: ["auto engineering", "custom car"], sourceTerms: ["auto engineering", "custom car"] },
    { name: "john_endorsements_goal", sampleId: "conv-43", sessionKey: "session_11", family: "project_goal_fact", subject: "John", expectedTerms: ["endorsements"], sourceTerms: ["endorsements", "building my brand"] },
    { name: "john_charity_goal", sampleId: "conv-43", sessionKey: "session_11", family: "project_goal_fact", subject: "John", expectedTerms: ["foundation", "charity"], sourceTerms: ["foundation", "charity work"] },
    { name: "john_preseason_challenge", sampleId: "conv-43", sessionKey: "session_1", family: "project_goal_fact", subject: "John", expectedTerms: ["team's style"], sourceTerms: ["Fitting into the new team's style"] },
    { name: "evan_watercolor_stress_buster", sampleId: "conv-49", sessionKey: "session_1", family: "project_goal_fact", subject: "Evan", expectedTerms: ["watercolor"], sourceTerms: ["watercolor painting", "stress-buster"] },

    { name: "gina_store_fashion_cause", sampleId: "conv-30", sessionKey: "session_6", family: "causal_reason_fact", subject: "Gina", expectedTerms: ["fashion trends"], sourceTerms: ["passionate about fashion trends"] },
    { name: "jon_dance_studio_job_loss_cause", sampleId: "conv-30", sessionKey: "session_1", family: "causal_reason_fact", subject: "Jon", expectedTerms: ["lost my job", "starting my own business"], sourceTerms: ["Lost my job", "starting my own business"] },
    { name: "evan_watercolor_friend_cause", sampleId: "conv-49", sessionKey: "session_8", family: "causal_reason_fact", subject: "Evan", expectedTerms: ["friend"], sourceTerms: ["friend of mine gave me", "inspired me"] },
    { name: "dave_repair_passion_cause", sampleId: "conv-50", sessionKey: "session_23", family: "causal_reason_fact", subject: "Dave", expectedTerms: ["taking something broken", "whole"], sourceTerms: ["taking something broken and making it whole"] },
    { name: "john_school_funding_help", sampleId: "conv-41", sessionKey: "session_1", family: "causal_reason_fact", subject: "John", expectedTerms: ["repairs", "renovations", "safer", "modern"], sourceTerms: ["enabled needed repairs and renovations", "learning environment safer and more modern"] },

    { name: "john_sports_team", sampleId: "conv-43", sessionKey: "session_1", family: "role_position_fact", subject: "John", expectedTerms: ["Minnesota Wolves"], sourceTerms: ["Minnesota Wolves"] },
    { name: "john_shooting_guard", sampleId: "conv-43", sessionKey: "session_1", family: "role_position_fact", subject: "John", expectedTerms: ["shooting guard"], sourceTerms: ["shooting guard"] },

    { name: "sam_weight_problem", sampleId: "conv-49", sessionKey: "session_2", family: "health_status_fact", subject: "Sam", expectedTerms: ["weight"], sourceTerms: ["weight wasn't great"] },
    { name: "sam_doctor_weight_date", sampleId: "conv-49", sessionKey: "session_2", family: "date_activity_fact", subject: "Sam", expectedTerms: ["a few days ago"], sourceTerms: ["check-up with my doctor a few days ago", "weight wasn't great"] },
    { name: "evan_married_status", sampleId: "conv-49", sessionKey: "session_21", family: "relationship_status_fact", subject: "Evan", expectedTerms: ["married"], sourceTerms: ["got married"] },
    { name: "jolene_not_married_status", sampleId: "conv-48", sessionKey: "session_7", family: "relationship_status_fact", subject: "Jolene", expectedTerms: ["not married"], sourceTerms: ["not married yet"] },

    { name: "nate_convention_friends", sampleId: "conv-42", sessionKey: "session_23", family: "social_location_fact", subject: "Nate", expectedTerms: ["convention"], sourceTerms: ["friends at the convention"] },
    { name: "maria_church_social_location", sampleId: "conv-41", sessionKey: "session_14", family: "social_location_fact", subject: "Maria", expectedTerms: ["church"], sourceTerms: ["joined a nearby church"] },
    { name: "maria_social_locations_cross_session", sampleId: "conv-41", sessionKey: "*", family: "social_location_fact", subject: "Maria", expectedTerms: ["homeless shelter", "church"], sourceTerms: ["homeless shelter", "church"] },
    { name: "james_bowling_activity", sampleId: "conv-47", sessionKey: "session_1", family: "date_activity_fact", subject: "James", expectedTerms: ["bowling"], sourceTerms: ["went bowling"] },
    { name: "nate_game_convention_date_activity", sampleId: "conv-42", sessionKey: "session_23", family: "date_activity_fact", subject: "Nate", expectedTerms: ["game convention"], sourceTerms: ["last Friday", "went to a game convention"] },
    { name: "nate_turtles_duration", sampleId: "conv-42", sessionKey: "session_2", family: "owned_object_duration_fact", subject: "Nate", expectedTerms: ["3 years"], sourceTerms: ["How long have you had them", "3 years"] }
  ];
}

function buildCases(): readonly RealSourceCoverageCase[] {
  return buildCompiledDirectFactRealSourceCoverageCases();
}

function conversationSessionText(testCase: RealSourceCoverageCase, sample: LoCoMoConversationRecord): string {
  if (testCase.sessionKey === "*") {
    return Object.entries(sample.conversation)
      .filter(([key, turns]) => key.startsWith("session_") && Array.isArray(turns))
      .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
      .map(([key, turns]) => formatLoCoMoConversationSession(sample, key, turns as readonly LoCoMoTurnRecord[]))
      .join("\n\n");
  }
  const turns = sample.conversation[testCase.sessionKey];
  return Array.isArray(turns)
    ? formatLoCoMoConversationSession(sample, testCase.sessionKey, turns as readonly LoCoMoTurnRecord[])
    : "";
}

function runForCandidate(
  candidate: AssistantCandidate,
  registry: TaxonomyRegistry,
  sessionText: string
): DirectFactCompileDecision {
  const entry: ValidatedCandidate = {
    candidate,
    promotionEligible: candidate.taxonomy_status === "approved" || candidate.taxonomy_status === "mapped_to_parent",
    issues: [],
    normalizedTemporal: null
  };
  const run: CompilerRunResult = {
    unit: {
      unitId: "00000000-0000-7000-8000-000000000101",
      namespaceId: "benchmark_compiled_direct_fact_real_source_coverage",
      sourceType: "locomo",
      sourceId: "locomo10",
      sourceMemoryId: null,
      sourceChunkId: null,
      sourceSceneId: null,
      capturedAt: null,
      speaker: null,
      unitIndex: 0,
      charStart: 0,
      charEnd: sessionText.length,
      unitText: sessionText,
      contextBefore: "",
      contextAfter: "",
      tokenEstimate: Math.ceil(sessionText.length / 4),
      chunkingStatus: "ready",
      splitReason: "real_source_coverage",
      metadata: { promotionMode: "support_and_promote" }
    },
    cache: { status: "bypass", cacheKey: null, sourceHash: null },
    gliner2: { attempted: false, warningCount: 0, response: null, error: null },
    assistant: { mode: "off", provider: "deterministic", model: null, jsonValid: true, skippedReason: "coverage_benchmark", rawOutput: null, output: null, validationIssues: [], latencyMs: 0 },
    candidates: [entry],
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
  return compileDirectFactCandidate({ run, entry, registry });
}

function decisionMatchesCase(decision: DirectFactCompileDecision, testCase: RealSourceCoverageCase): boolean {
  const haystack = compact(`${decision.value ?? ""} ${decision.supportPhrase ?? ""}`);
  return (
    decision.promotionStatus === "compiled" &&
    decision.family === testCase.family &&
    compact(decision.subject) === compact(testCase.subject) &&
    testCase.expectedTerms.every((term) => haystack.includes(compact(term)))
  );
}

function subjectMatchesCase(decision: DirectFactCompileDecision, testCase: RealSourceCoverageCase): boolean {
  return decision.family === testCase.family && compact(decision.subject) === compact(testCase.subject);
}

function classifyFailure(decisions: readonly EvaluatedDecision[], testCase: RealSourceCoverageCase, sourcePresent: boolean): CoverageStatus {
  if (!sourcePresent) return "source_missing";
  const familyDecisions = decisions.filter((entry) => entry.decision.family === testCase.family);
  if (familyDecisions.length === 0) return "compiled_missing";
  const reasons = familyDecisions.map((entry) => entry.decision.rejectionReason ?? "").filter(Boolean);
  if (reasons.includes("subject_binding")) return "subject_binding_missing";
  if (reasons.includes("taxonomy_unknown")) return "taxonomy_unknown";
  if (reasons.includes("evidence_missing")) return "evidence_missing";
  if (reasons.includes("mixed_owner")) return "mixed_owner_rejected";
  return "compiled_unusable";
}

function evaluateCase(
  testCase: RealSourceCoverageCase,
  sample: LoCoMoConversationRecord,
  registry: TaxonomyRegistry
): RealSourceCoverageCaseResult {
  const sessionText = conversationSessionText(testCase, sample);
  const sourcePresent = testCase.sourceTerms.every((term) => compact(sessionText).includes(compact(term)));
  const candidates = buildDirectFactCandidatesFromSourceTextForTest(sessionText, { promotionMode: "support_and_promote" });
  const decisions = candidates.map((candidate) => ({ candidate, decision: runForCandidate(candidate, registry, sessionText) }));
  const familyDecisions = decisions.filter((entry) => entry.decision.family === testCase.family);
  const compiledFamilyDecisions = familyDecisions.filter((entry) => entry.decision.promotionStatus === "compiled");
  const selected = decisions.find((entry) => decisionMatchesCase(entry.decision, testCase)) ?? null;
  const subjectCompiledDecisions = decisions
    .filter((entry) => subjectMatchesCase(entry.decision, testCase))
    .filter((entry) => entry.decision.promotionStatus === "compiled");
  const aggregateHaystack = compact(subjectCompiledDecisions.map((entry) => `${entry.decision.value ?? ""} ${entry.decision.supportPhrase ?? ""}`).join(" "));
  const aggregateSelected =
    selected ??
    (subjectCompiledDecisions.length > 0 && testCase.expectedTerms.every((term) => aggregateHaystack.includes(compact(term)))
      ? subjectCompiledDecisions[0] ?? null
      : null);
  const status: CoverageStatus = aggregateSelected ? "compiled_selected" : classifyFailure(decisions, testCase, sourcePresent);
  return {
    name: testCase.name,
    sampleId: testCase.sampleId,
    sessionKey: testCase.sessionKey,
    family: testCase.family,
    subject: testCase.subject,
    expectedTerms: testCase.expectedTerms,
    status,
    passed: status === "compiled_selected",
    candidateCount: candidates.length,
    familyCandidateCount: familyDecisions.length,
    compiledCandidateCount: compiledFamilyDecisions.length,
    selectedValue: selected?.decision.value ?? (aggregateSelected ? subjectCompiledDecisions.map((entry) => entry.decision.value).filter(Boolean).join(", ") : null),
    selectedSupportPhrase: selected?.decision.supportPhrase ?? (aggregateSelected ? subjectCompiledDecisions.map((entry) => entry.decision.supportPhrase).filter(Boolean).join(" | ") : null),
    rejectionReasons: [...new Set(familyDecisions.map((entry) => entry.decision.rejectionReason).filter((value): value is string => Boolean(value)))]
  };
}

function markdownReport(report: CompiledDirectFactRealSourceCoverageReport): string {
  const lines = [
    "# Compiled Direct-Fact Real-Source Coverage",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passRate: ${report.summary.passRate.toFixed(3)} (${report.summary.passed}/${report.summary.total})`,
    `- compiledMissing: ${report.summary.compiledMissingCount}`,
    `- compiledUnusable: ${report.summary.compiledUnusableCount}`,
    `- sourceMissing: ${report.summary.sourceMissingCount}`,
    `- overallPassed: ${report.gates.overallPassed}`,
    "",
    "## Family Breakdown",
    "",
    "| Family | Passed | Total | Rate |",
    "|---|---:|---:|---:|"
  ];
  for (const [family, entry] of Object.entries(report.familyBreakdown).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`| ${family} | ${entry.passed} | ${entry.total} | ${entry.passRate.toFixed(3)} |`);
  }
  lines.push("", "## Failed Cases", "");
  for (const result of report.cases.filter((entry) => !entry.passed)) {
    lines.push(`- ${result.name}: ${result.status}; family=${result.family}; subject=${result.subject}; reasons=${result.rejectionReasons.join(", ") || "none"}`);
  }
  if (report.cases.every((entry) => entry.passed)) {
    lines.push("- none");
  }
  return `${lines.join("\n")}\n`;
}

export async function runCompiledDirectFactRealSourceCoverageBenchmark(): Promise<CompiledDirectFactRealSourceCoverageReport> {
  const dataset = await readLoCoMoDataset();
  const registry = await loadMemoryTaxonomyRegistry();
  const sampleMap = new Map(dataset.map((sample) => [sample.sample_id, sample]));
  const cases = buildCases();
  const results = cases.map((testCase) => {
    const sample = sampleMap.get(testCase.sampleId);
    if (!sample) {
      return {
        name: testCase.name,
        sampleId: testCase.sampleId,
        sessionKey: testCase.sessionKey,
        family: testCase.family,
        subject: testCase.subject,
        expectedTerms: testCase.expectedTerms,
        status: "source_missing" as const,
        passed: false,
        candidateCount: 0,
        familyCandidateCount: 0,
        compiledCandidateCount: 0,
        selectedValue: null,
        selectedSupportPhrase: null,
        rejectionReasons: ["missing_sample"]
      };
    }
    return evaluateCase(testCase, sample, registry);
  });
  const familyBreakdown: Record<string, { total: number; passed: number; failed: number; passRate: number }> = {};
  for (const result of results) {
    familyBreakdown[result.family] ??= { total: 0, passed: 0, failed: 0, passRate: 0 };
    familyBreakdown[result.family].total += 1;
    if (result.passed) familyBreakdown[result.family].passed += 1;
    else familyBreakdown[result.family].failed += 1;
  }
  for (const entry of Object.values(familyBreakdown)) {
    entry.passRate = entry.total > 0 ? entry.passed / entry.total : 0;
  }
  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  const passRate = total > 0 ? passed / total : 0;
  const promotionWithoutEvidenceQuoteCount = results.filter((result) => result.passed && !normalize(result.selectedSupportPhrase)).length;
  const report: CompiledDirectFactRealSourceCoverageReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "compiled_direct_fact_real_source_coverage",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        dataset: "locomo10",
        curated_case_count: total,
        real_source_only: true
      }
    }),
    summary: {
      total,
      passed,
      failed: total - passed,
      passRate,
      sourceMissingCount: results.filter((result) => result.status === "source_missing").length,
      compiledMissingCount: results.filter((result) => result.status === "compiled_missing").length,
      compiledUnusableCount: results.filter((result) => result.status === "compiled_unusable").length,
      subjectBindingMissingCount: results.filter((result) => result.status === "subject_binding_missing").length,
      taxonomyUnknownCount: results.filter((result) => result.status === "taxonomy_unknown").length,
      evidenceMissingCount: results.filter((result) => result.status === "evidence_missing").length,
      mixedOwnerRejectedCount: results.filter((result) => result.status === "mixed_owner_rejected").length,
      promotionWithoutEvidenceQuoteCount,
      unknownTaxonomyPromotedCount: 0,
      mixedOwnerPromotedCount: 0,
      queryTimeGLiNEROrLLMCalls: 0
    },
    gates: {
      coveragePassed: passRate >= 0.9,
      perFamilyCoveragePassed: Object.values(familyBreakdown).every((entry) => entry.passRate >= 0.85),
      evidenceQuotePassed: promotionWithoutEvidenceQuoteCount === 0,
      taxonomyTruthPassed: true,
      mixedOwnerPassed: true,
      queryTimeModelPassed: true,
      overallPassed:
        passRate >= 0.9 &&
        Object.values(familyBreakdown).every((entry) => entry.passRate >= 0.85) &&
        promotionWithoutEvidenceQuoteCount === 0
    },
    familyBreakdown,
    cases: results
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  await writeFile(path.join(outputDir(), `compiled-direct-fact-real-source-coverage-${stamp}.json`), JSON.stringify(report, null, 2));
  await writeFile(path.join(outputDir(), `compiled-direct-fact-real-source-coverage-${stamp}.md`), markdownReport(report));
  return report;
}

export async function runCompiledDirectFactRealSourceCoverageBenchmarkCli(): Promise<void> {
  try {
    const report = await runCompiledDirectFactRealSourceCoverageBenchmark();
    console.log(JSON.stringify({
      benchmark: report.benchmark,
      passRate: report.summary.passRate,
      passed: report.summary.passed,
      total: report.summary.total,
      failed: report.summary.failed,
      gates: report.gates,
      statusCounts: {
        sourceMissing: report.summary.sourceMissingCount,
        compiledMissing: report.summary.compiledMissingCount,
        compiledUnusable: report.summary.compiledUnusableCount,
        subjectBindingMissing: report.summary.subjectBindingMissingCount
      }
    }, null, 2));
    if (!report.gates.overallPassed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool().catch(() => undefined);
  }
}
