import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import type { ProductionFailureCategory } from "./production-confidence-shared.js";
import { countFailureCategories } from "./production-confidence-shared.js";

type Confidence = "confident" | "weak" | "missing";
type ReviewStatus = "pass" | "warning" | "fail";

interface PersonalOmiScenario {
  readonly name: string;
  readonly category: "alias" | "relationship" | "temporal" | "current_state" | "provenance" | "continuity_handoff";
  readonly query: string;
  readonly expectedClaimTerms: readonly string[];
  readonly expectedEvidenceTerms?: readonly string[];
  readonly minimumConfidence?: Confidence;
  readonly allowMissingEvidence?: boolean;
}

interface PersonalOmiScenarioResult {
  readonly name: string;
  readonly category: PersonalOmiScenario["category"];
  readonly query: string;
  readonly latencyMs: number;
  readonly confidence: string | null;
  readonly sufficiency: string | null;
  readonly subjectMatch: string | null;
  readonly claimText: string | null;
  readonly evidenceCount: number;
  readonly sourceLinkCount: number;
  readonly dominantStage: string | null;
  readonly topStageMs: number | null;
  readonly leafTraversalTriggered: boolean;
  readonly descentTriggered: boolean;
  readonly descentStages: readonly string[];
  readonly reducerFamily: string | null;
  readonly finalClaimSource: string | null;
  readonly fallbackSuppressedReason: string | null;
  readonly stageTimingsMs: Readonly<Record<string, number>> | null;
  readonly status: ReviewStatus;
  readonly primaryFailureCategory: ProductionFailureCategory | null;
  readonly failureCategories: readonly ProductionFailureCategory[];
  readonly continuityWrongClaimWithGoodEvidence: boolean;
  readonly continuityMissingEvidence: boolean;
  readonly supportQualityIssue: boolean;
  readonly failures: readonly string[];
  readonly notes: readonly string[];
  readonly sourcePaths: readonly string[];
}

export interface PersonalOmiReviewReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly scenarios: readonly PersonalOmiScenarioResult[];
  readonly summary: {
    readonly pass: number;
    readonly warning: number;
    readonly fail: number;
    readonly wrongClaimWithGoodEvidence: number;
    readonly missingEvidence: number;
    readonly supportQualityIssue: number;
    readonly failureCategoryCounts: Record<ProductionFailureCategory, number>;
  };
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

function evidenceItems(payload: any): readonly any[] {
  if (Array.isArray(payload?.duality?.evidence)) {
    return payload.duality.evidence;
  }
  if (Array.isArray(payload?.evidence)) {
    return payload.evidence;
  }
  return [];
}

function hasTerm(value: unknown, term: string): boolean {
  return JSON.stringify(value ?? null).toLowerCase().includes(term.toLowerCase());
}

function llmStyleAnswer(payload: any): string | null {
  if (typeof payload?.duality?.claim?.text === "string" && payload.duality.claim.text.trim()) {
    return payload.duality.claim.text.trim();
  }
  if (typeof payload?.claimText === "string" && payload.claimText.trim()) {
    return payload.claimText.trim();
  }
  return null;
}

function sourcePathsFromEvidence(payload: any): readonly string[] {
  return [
    ...new Set(
      evidenceItems(payload)
        .map((item: any) => (typeof item?.sourceUri === "string" ? item.sourceUri : null))
        .filter((item: string | null): item is string => Boolean(item))
    )
  ];
}

function stageTimingsFromPayload(payload: any): Readonly<Record<string, number>> | null {
  if (!payload?.meta?.stageTimingsMs || typeof payload.meta.stageTimingsMs !== "object") {
    return null;
  }
  const timings: Record<string, number> = {};
  for (const [key, value] of Object.entries(payload.meta.stageTimingsMs)) {
    if (typeof key === "string" && typeof value === "number") {
      timings[key] = value;
    }
  }
  return timings;
}

function confidenceRank(value: string | null): number {
  switch (value) {
    case "confident":
      return 2;
    case "weak":
      return 1;
    default:
      return 0;
  }
}

function requiredConfidenceRank(value: Confidence | undefined): number {
  switch (value) {
    case "confident":
      return 2;
    case "weak":
      return 1;
    default:
      return 0;
  }
}

function scenarios(): readonly PersonalOmiScenario[] {
  return [
    {
      name: "dan_relationship_exact",
      category: "alias",
      query: "Who is Dan in my life right now, exactly?",
      expectedClaimTerms: ["friend", "chiang mai"],
      expectedEvidenceTerms: ["dan", "friend", "chiang mai"],
      minimumConfidence: "weak"
    },
    {
      name: "four_people_relationships",
      category: "relationship",
      query: "If I mention Dan, John, Lauren, and James, what is each person's relationship to me?",
      expectedClaimTerms: ["dan", "john", "lauren", "james"],
      expectedEvidenceTerms: ["friend", "owner", "best friends", "burning man"],
      minimumConfidence: "weak"
    },
    {
      name: "john_relationship_exact",
      category: "relationship",
      query: "Who is John in my life, and what is he associated with?",
      expectedClaimTerms: ["john", "owner", "samui"],
      expectedEvidenceTerms: ["john", "samui", "owner"],
      minimumConfidence: "weak"
    },
    {
      name: "uncle_resolution_exact",
      category: "alias",
      query: "Who is Uncle?",
      expectedClaimTerms: ["billy smith", "joe bob"],
      expectedEvidenceTerms: ["uncle", "billy smith", "joe bob"],
      minimumConfidence: "confident"
    },
    {
      name: "james_relationship_exact",
      category: "relationship",
      query: "Who is James in my life, and what is he associated with?",
      expectedClaimTerms: ["friend", "burning man", "lake tahoe"],
      expectedEvidenceTerms: ["james", "burning man", "lake tahoe"],
      minimumConfidence: "weak"
    },
    {
      name: "lauren_history_exact",
      category: "relationship",
      query: "What is Steve's history with Lauren?",
      expectedClaimTerms: ["lake tahoe", "bend", "thailand"],
      expectedEvidenceTerms: ["lauren", "lake tahoe", "bend", "thailand"],
      minimumConfidence: "weak"
    },
    {
      name: "lauren_departure_date",
      category: "temporal",
      query: "When did Lauren leave for the US?",
      expectedClaimTerms: ["october 18", "2025"],
      expectedEvidenceTerms: ["october 18", "2025"],
      minimumConfidence: "confident"
    },
    {
      name: "lauren_current_relationship_exact",
      category: "relationship",
      query: "Who is Lauren in my life right now, exactly?",
      expectedClaimTerms: ["former partner", "lauren"],
      expectedEvidenceTerms: ["lauren", "former romantic"],
      minimumConfidence: "confident"
    },
    {
      name: "relationship_change_when",
      category: "relationship",
      query: "What changed recently in one important relationship, and when did it change?",
      expectedClaimTerms: ["lauren", "october 18", "2025"],
      expectedEvidenceTerms: ["lauren", "haven't really talked"],
      minimumConfidence: "weak"
    },
    {
      name: "current_projects",
      category: "current_state",
      query: "What project am I actively focused on right now?",
      expectedClaimTerms: ["well inked", "two way", "preset kitchen", "ai brain"],
      expectedEvidenceTerms: ["well inked", "two way", "preset kitchen", "ai brain"],
      minimumConfidence: "weak"
    },
    {
      name: "yesterday_work_recap",
      category: "continuity_handoff",
      query: "What did I do yesterday?",
      expectedClaimTerms: ["ai brain", "preset kitchen", "bumblebee"],
      expectedEvidenceTerms: ["yesterday", "two way", "well inked"],
      minimumConfidence: "confident"
    },
    {
      name: "yesterday_talk_recap",
      category: "continuity_handoff",
      query: "What did I talk about yesterday?",
      expectedClaimTerms: ["ai brain", "preset kitchen", "bumblebee", "two way"],
      expectedEvidenceTerms: ["yesterday", "well inked"],
      minimumConfidence: "confident"
    },
    {
      name: "warm_start_today",
      category: "current_state",
      query: "What should you know about me to start today?",
      expectedClaimTerms: ["warm start for steve", "current focus", "well inked", "two way", "preset kitchen", "ai brain"],
      expectedEvidenceTerms: ["preset kitchen", "ai brain"],
      minimumConfidence: "confident"
    },
    {
      name: "habits_constraints_current_exact",
      category: "current_state",
      query: "What habits or constraints matter right now?",
      expectedClaimTerms: ["coffee", "reddit", "personal time"],
      expectedEvidenceTerms: ["daily routine", "coffee", "reddit"],
      minimumConfidence: "weak"
    },
    {
      name: "koh_samui_alias_exact",
      category: "alias",
      query: "What is Kozimui?",
      expectedClaimTerms: ["koh samui"],
      expectedEvidenceTerms: ["koh samui"],
      minimumConfidence: "weak"
    },
    {
      name: "continuity_pick_back_up",
      category: "continuity_handoff",
      query: "What should I pick back up right now based on my recent notes?",
      expectedClaimTerms: ["preset kitchen", "ai brain"],
      expectedEvidenceTerms: ["preset kitchen", "ai brain"],
      minimumConfidence: "weak"
    },
    {
      name: "dan_movie_two_weeks",
      category: "temporal",
      query: "What movie did Dan mention two weeks ago, and where did he mention it?",
      expectedClaimTerms: ["sinners", "13 march 2026", "korean barbecue place"],
      expectedEvidenceTerms: ["dan", "sinners", "two weeks ago"],
      minimumConfidence: "confident"
    },
    {
      name: "ben_project_idea_exact",
      category: "current_state",
      query: "What project idea did Ben and I discuss, and what was the idea exactly?",
      expectedClaimTerms: ["context suite", "memoir engine", "chapters of a person's memoir"],
      expectedEvidenceTerms: ["ben", "context suite", "memoir engine"],
      minimumConfidence: "confident"
    },
    {
      name: "ben_relationship_exact",
      category: "relationship",
      query: "Who is Ben in my life, and what is he associated with?",
      expectedClaimTerms: ["ben", "friend", "well inked"],
      expectedEvidenceTerms: ["ben", "well inked"],
      minimumConfidence: "weak"
    },
    {
      name: "omi_relationship_exact",
      category: "relationship",
      query: "Who is Omi in my life, and what is Omi associated with?",
      expectedClaimTerms: ["omi", "two way"],
      expectedEvidenceTerms: ["omi", "two way"],
      minimumConfidence: "weak"
    },
    {
      name: "purchase_today_exact",
      category: "current_state",
      query: "What did I buy on March 28, 2026 and what were the prices?",
      expectedClaimTerms: ["snickers bar", "toilet paper", "780 baht", "24 usd"],
      expectedEvidenceTerms: ["snickers bar", "780 baht", "gas for your scooter"],
      minimumConfidence: "confident"
    },
    {
      name: "media_titles_exact",
      category: "current_state",
      query: "What movies have I talked about?",
      expectedClaimTerms: ["sinners", "slow horses", "from dusk till dawn"],
      expectedEvidenceTerms: ["sinners", "slow horses", "from dusk till dawn"],
      minimumConfidence: "confident"
    },
    {
      name: "food_preference_exact",
      category: "current_state",
      query: "What food did I like?",
      expectedClaimTerms: ["spicy food", "nachos"],
      expectedEvidenceTerms: ["spicy food", "nachos"],
      minimumConfidence: "confident"
    },
    {
      name: "beer_preference_exact",
      category: "current_state",
      query: "What are my favorite beers in Thailand?",
      expectedClaimTerms: ["leo", "singha", "chang", "in that order"],
      expectedEvidenceTerms: ["leo", "singha", "cheng"],
      minimumConfidence: "confident"
    },
    {
      name: "preference_profile_exact",
      category: "current_state",
      query: "What do I like and dislike?",
      expectedClaimTerms: ["macbook pros", "snowboarding", "mountain biking", "windows machines", "android phones", "mushy vegetables"],
      expectedEvidenceTerms: ["macbook pros", "mountain biking", "android phones", "mushy vegetables"],
      minimumConfidence: "confident"
    },
    {
      name: "routine_current_exact",
      category: "current_state",
      query: "What is my current daily routine?",
      expectedClaimTerms: ["wake around 7 to 8 am", "make coffee", "reddit", "email and current tasks", "start work around 10 am", "midday exercise break"],
      expectedEvidenceTerms: ["daily routine", "coffee", "reddit", "two way", "wellinked"],
      minimumConfidence: "confident"
    },
    {
      name: "lauren_change_direct",
      category: "temporal",
      query: "What changed with Lauren, and when?",
      expectedClaimTerms: ["lauren", "october 18, 2025", "stopped talking"],
      expectedEvidenceTerms: ["lauren", "october 18, 2025"],
      minimumConfidence: "confident"
    },
    {
      name: "relationship_transition_startup_exact",
      category: "temporal",
      query: "What important relationship transition should I know about right now?",
      expectedClaimTerms: ["lauren", "october 18, 2025", "stopped talking"],
      expectedEvidenceTerms: ["lauren", "october 18, 2025"],
      minimumConfidence: "confident"
    },
    {
      name: "lauren_stop_talking_when",
      category: "temporal",
      query: "When did Steve and Lauren stop talking?",
      expectedClaimTerms: ["lauren", "october 18, 2025"],
      expectedEvidenceTerms: ["lauren", "october 18, 2025", "stopped talking"],
      minimumConfidence: "confident"
    }
  ];
}

async function runScenario(namespaceId: string, scenario: PersonalOmiScenario): Promise<PersonalOmiScenarioResult> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: namespaceId,
    query: scenario.query,
    limit: 8
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const claimText = llmStyleAnswer(payload);
  const evidence = evidenceItems(payload);
  const confidence = typeof payload?.duality?.confidence === "string" ? payload.duality.confidence : null;
  const sufficiency = typeof payload?.meta?.answerAssessment?.sufficiency === "string" ? payload.meta.answerAssessment.sufficiency : null;
  const subjectMatch = typeof payload?.meta?.answerAssessment?.subjectMatch === "string" ? payload.meta.answerAssessment.subjectMatch : null;
  const failures: string[] = [];
  const notes: string[] = [];
  const sourceLinkCountValue = sourcePathsFromEvidence(payload).length;

  for (const term of scenario.expectedClaimTerms) {
    if (!hasTerm(claimText, term)) {
      failures.push(`claim missing term ${term}`);
    }
  }

  for (const term of scenario.expectedEvidenceTerms ?? []) {
    if (!hasTerm(payload, term)) {
      failures.push(`evidence missing term ${term}`);
    }
  }

  if (confidenceRank(confidence) < requiredConfidenceRank(scenario.minimumConfidence)) {
    failures.push(`confidence ${confidence ?? "missing"} below ${scenario.minimumConfidence}`);
  }

  if ((claimText ?? "").trim().toLowerCase() === "no authoritative evidence found.") {
    failures.push("claim fell back to no authoritative evidence found");
  }

  if (evidence.length === 0 && !scenario.allowMissingEvidence) {
    failures.push("no evidence returned");
  }

  if (failures.length === 0) {
    notes.push("claim and evidence both hit the expected terms");
  } else if (hasTerm(payload, scenario.expectedClaimTerms[0] ?? "")) {
    notes.push("supporting evidence exists, but final claim selection is still weak");
  } else {
    notes.push("retrieval missed the expected supporting evidence");
  }

  const status: ReviewStatus =
    failures.length === 0 ? "pass" : hasTerm(payload, scenario.expectedClaimTerms[0] ?? "") ? "warning" : "fail";
  const continuityMissingEvidence = evidence.length === 0;
  const continuityWrongClaimWithGoodEvidence = status !== "pass" && evidence.length > 0;
  const supportQualityIssue = status === "pass" && sourceLinkCountValue === 0;
  const failureCategories: ProductionFailureCategory[] = [];

  if (continuityMissingEvidence) {
    failureCategories.push("missing_evidence");
  }
  if (continuityWrongClaimWithGoodEvidence) {
    failureCategories.push("wrong_claim_with_good_evidence");
  }
  if (sourceLinkCountValue === 0) {
    failureCategories.push("weak_provenance");
  }
  if ((scenario.category === "alias" || scenario.category === "relationship") && status !== "pass") {
    failureCategories.push("entity_resolution_error");
  }
  if (scenario.category === "temporal" && status !== "pass") {
    failureCategories.push("temporal_resolution_error");
  }
  if (scenario.category === "continuity_handoff" && status !== "pass") {
    failureCategories.push("continuity_pack_error");
  }

  return {
    name: scenario.name,
    category: scenario.category,
    query: scenario.query,
    latencyMs,
    confidence,
    sufficiency,
    subjectMatch,
    claimText,
    evidenceCount: evidence.length,
    sourceLinkCount: sourceLinkCountValue,
    dominantStage: typeof payload?.meta?.dominantStage === "string" ? payload.meta.dominantStage : null,
    topStageMs: typeof payload?.meta?.topStageMs === "number" ? payload.meta.topStageMs : null,
    leafTraversalTriggered: payload?.meta?.leafTraversalTriggered === true,
    descentTriggered: payload?.meta?.descentTriggered === true,
    descentStages: Array.isArray(payload?.meta?.descentStages) ? payload.meta.descentStages.filter((value: unknown): value is string => typeof value === "string") : [],
    reducerFamily: typeof payload?.meta?.reducerFamily === "string" ? payload.meta.reducerFamily : null,
    finalClaimSource: typeof payload?.meta?.finalClaimSource === "string" ? payload.meta.finalClaimSource : null,
    fallbackSuppressedReason: typeof payload?.meta?.fallbackSuppressedReason === "string" ? payload.meta.fallbackSuppressedReason : null,
    stageTimingsMs: stageTimingsFromPayload(payload),
    status,
    primaryFailureCategory: failureCategories[0] ?? null,
    failureCategories,
    continuityWrongClaimWithGoodEvidence,
    continuityMissingEvidence,
    supportQualityIssue,
    failures,
    notes,
    sourcePaths: sourcePathsFromEvidence(payload)
  };
}

function toMarkdown(report: PersonalOmiReviewReport): string {
  const lines: string[] = [
    "# Personal OMI Review",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- pass/warning/fail: ${report.summary.pass}/${report.summary.warning}/${report.summary.fail}`,
    `- wrongClaimWithGoodEvidence: ${report.summary.wrongClaimWithGoodEvidence}`,
    `- missingEvidence: ${report.summary.missingEvidence}`,
    `- supportQualityIssue: ${report.summary.supportQualityIssue}`,
    "",
    "## Scenarios",
    ""
  ];

  for (const item of report.scenarios) {
    lines.push(`### ${item.name}`);
    lines.push(`- category: ${item.category}`);
    lines.push(`- status: ${item.status}`);
    lines.push(`- confidence: ${item.confidence ?? "missing"}`);
    lines.push(`- sufficiency/subjectMatch: ${item.sufficiency ?? "missing"} / ${item.subjectMatch ?? "missing"}`);
    lines.push(`- latencyMs: ${item.latencyMs}`);
    lines.push(`- query: ${item.query}`);
    lines.push(`- claim: ${item.claimText ?? "none"}`);
    lines.push(`- evidenceCount: ${item.evidenceCount}`);
    lines.push(`- sourceLinkCount: ${item.sourceLinkCount}`);
    lines.push(`- dominantStage/topStageMs: ${item.dominantStage ?? "n/a"} / ${item.topStageMs ?? "n/a"}`);
    lines.push(`- leafTraversalTriggered: ${item.leafTraversalTriggered}`);
    lines.push(`- descentTriggered: ${item.descentTriggered}`);
    lines.push(`- descentStages: ${item.descentStages.join(" -> ") || "none"}`);
    lines.push(`- reducerFamily: ${item.reducerFamily ?? "none"}`);
    lines.push(`- finalClaimSource: ${item.finalClaimSource ?? "none"}`);
    lines.push(`- fallbackSuppressedReason: ${item.fallbackSuppressedReason ?? "none"}`);
    if (item.stageTimingsMs) {
      lines.push(`- stageTimingsMs: ${JSON.stringify(item.stageTimingsMs)}`);
    }
    lines.push(`- primaryFailureCategory: ${item.primaryFailureCategory ?? "none"}`);
    lines.push(`- failureCategories: ${item.failureCategories.join(", ") || "none"}`);
    lines.push(`- continuityWrongClaimWithGoodEvidence: ${item.continuityWrongClaimWithGoodEvidence}`);
    lines.push(`- continuityMissingEvidence: ${item.continuityMissingEvidence}`);
    lines.push(`- supportQualityIssue: ${item.supportQualityIssue}`);
    if (item.failures.length > 0) {
      lines.push(`- failures: ${item.failures.join("; ")}`);
    }
    if (item.notes.length > 0) {
      lines.push(`- notes: ${item.notes.join("; ")}`);
    }
    if (item.sourcePaths.length > 0) {
      lines.push(`- sourcePaths: ${item.sourcePaths.join(" | ")}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export async function runPersonalOmiReview(namespaceId = "personal"): Promise<PersonalOmiReviewReport> {
  const scenarioResults: PersonalOmiScenarioResult[] = [];
  for (const scenario of scenarios()) {
    scenarioResults.push(await runScenario(namespaceId, scenario));
  }

  return {
    generatedAt: new Date().toISOString(),
    namespaceId,
    scenarios: scenarioResults,
    summary: {
      pass: scenarioResults.filter((item) => item.status === "pass").length,
      warning: scenarioResults.filter((item) => item.status === "warning").length,
      fail: scenarioResults.filter((item) => item.status === "fail").length,
      wrongClaimWithGoodEvidence: scenarioResults.filter((item) => item.continuityWrongClaimWithGoodEvidence).length,
      missingEvidence: scenarioResults.filter((item) => item.continuityMissingEvidence).length,
      supportQualityIssue: scenarioResults.filter((item) => item.supportQualityIssue).length,
      failureCategoryCounts: countFailureCategories(scenarioResults)
    }
  };
}

export async function runAndWritePersonalOmiReview(namespaceId = "personal"): Promise<{
  readonly report: PersonalOmiReviewReport;
  readonly jsonPath: string;
  readonly markdownPath: string;
}> {
  const report = await runPersonalOmiReview(namespaceId);
  const timestamp = report.generatedAt.replace(/[:.]/g, "-");
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, `personal-omi-review-${timestamp}.json`);
  const markdownPath = path.join(dir, `personal-omi-review-${timestamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, jsonPath, markdownPath };
}

export async function runPersonalOmiReviewCli(): Promise<void> {
  try {
    const namespaceId = process.argv[2] || "personal";
    const result = await runAndWritePersonalOmiReview(namespaceId);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closePool();
  }
}
