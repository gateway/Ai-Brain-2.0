import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeMcpTool } from "../mcp/server.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import {
  ingestLoCoMoConversationFixture,
  ingestLongMemEvalEntryFixture,
  loadLoCoMoConversationFixture,
  loadLongMemEvalEntryFixture
} from "./public-memory-benchmark-fixtures.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { answerTextFromPayload, payloadEvidenceCount, queryTimeModelCallsFromPayload } from "./query-benchmark-utils.js";

interface AuditScenario {
  readonly id: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly expectedFamily: string;
  readonly compatibleFamilies?: readonly string[];
  readonly expectedAnswerShape: string;
  readonly expectedTerms: readonly string[];
  readonly shouldAbstain?: boolean;
}

export interface RetrievalQuestionAuditRow {
  readonly id: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly expectedFamily: string;
  readonly expectedAnswerShape: string;
  readonly actualFamily: string | null;
  readonly actualAnswerShape: string | null;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly queryTimeModelCalls: number;
  readonly residualOwner: string;
  readonly missingTerms: readonly string[];
  readonly wrongFamily: boolean;
  readonly notes: string;
}

export interface RetrievalQuestionAuditReport {
  readonly generatedAt: string;
  readonly benchmark: "retrieval_question_audit";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly wrongFamilyCount: number;
  readonly queryTimeModelCalls: number;
  readonly supportedZeroEvidenceCount: number;
  readonly residualOwnerBreakdown: Readonly<Record<string, number>>;
  readonly results: readonly RetrievalQuestionAuditRow[];
  readonly passed: boolean;
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

function hasTerm(value: string, term: string): boolean {
  return value.toLowerCase().includes(term.toLowerCase());
}

function sourceCountFromPayload(payload: any): number {
  const sourceTrail = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail : [];
  if (sourceTrail.length > 0) {
    return sourceTrail.length;
  }
  const evidence = Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence : [];
  return evidence.filter((item: any) => typeof item?.artifactId === "string" || typeof item?.sourceUri === "string").length;
}

async function buildFixtureNamespaces(stamp: string): Promise<{
  readonly longmemCommute: string;
  readonly longmemPlay: string;
  readonly locomoCaroline: string;
  readonly locomoJonGina: string;
  readonly locomoPastries: string;
  readonly locomoBands: string;
}> {
  const namespaces = {
    longmemCommute: `benchmark_question_audit_longmem_commute_${stamp}`,
    longmemPlay: `benchmark_question_audit_longmem_play_${stamp}`,
    locomoCaroline: `benchmark_question_audit_locomo_caroline_${stamp}`,
    locomoJonGina: `benchmark_question_audit_locomo_jon_gina_${stamp}`,
    locomoPastries: `benchmark_question_audit_locomo_pastries_${stamp}`,
    locomoBands: `benchmark_question_audit_locomo_bands_${stamp}`
  } as const;
  await ingestLongMemEvalEntryFixture(namespaces.longmemCommute, await loadLongMemEvalEntryFixture("118b2229"));
  await ingestLongMemEvalEntryFixture(namespaces.longmemPlay, await loadLongMemEvalEntryFixture("58bf7951"));
  await ingestLoCoMoConversationFixture(namespaces.locomoCaroline, await loadLoCoMoConversationFixture("conv-26"));
  await ingestLoCoMoConversationFixture(namespaces.locomoJonGina, await loadLoCoMoConversationFixture("conv-30"));
  await ingestLoCoMoConversationFixture(namespaces.locomoPastries, await loadLoCoMoConversationFixture("conv-44"));
  await ingestLoCoMoConversationFixture(namespaces.locomoBands, await loadLoCoMoConversationFixture("conv-50"));
  for (const namespaceId of Object.values(namespaces)) {
    await rebuildTypedMemoryNamespace(namespaceId);
  }
  return namespaces;
}

function benchmarkDerivedScenarios(namespaces: Awaited<ReturnType<typeof buildFixtureNamespaces>>): readonly AuditScenario[] {
  return [
    {
      id: "audit_longmem_commute",
      namespaceId: namespaces.longmemCommute,
      query: "How long is my daily commute to work?",
      expectedFamily: "exact_detail",
      compatibleFamilies: ["direct_fact"],
      expectedAnswerShape: "scalar",
      expectedTerms: ["45 minutes each way"]
    },
    {
      id: "audit_longmem_play",
      namespaceId: namespaces.longmemPlay,
      query: "What play did I attend at the local community theater?",
      expectedFamily: "exact_detail",
      compatibleFamilies: ["direct_fact"],
      expectedAnswerShape: "scalar",
      expectedTerms: ["The Glass Menagerie"]
    },
    {
      id: "audit_locomo_support_group",
      namespaceId: namespaces.locomoCaroline,
      query: "When did Caroline go to the LGBTQ support group?",
      expectedFamily: "temporal_detail",
      compatibleFamilies: ["temporal_event"],
      expectedAnswerShape: "scalar",
      expectedTerms: ["7 May 2023"]
    },
    {
      id: "audit_locomo_jon_causal",
      namespaceId: namespaces.locomoJonGina,
      query: "Why did Jon decide to start his dance studio?",
      expectedFamily: "direct_fact",
      compatibleFamilies: ["profile_report"],
      expectedAnswerShape: "report",
      expectedTerms: ["lost", "passion", "share"]
    },
    {
      id: "audit_locomo_gina_causal",
      namespaceId: namespaces.locomoJonGina,
      query: "Why did Gina decide to start her own clothing store?",
      expectedFamily: "direct_fact",
      compatibleFamilies: ["profile_report"],
      expectedAnswerShape: "report",
      expectedTerms: ["fashion", "unique pieces", "lost her job"]
    },
    {
      id: "audit_locomo_pet_care",
      namespaceId: namespaces.locomoPastries,
      query: "What kind of classes or groups has Audrey joined to take better care of her dogs?",
      expectedFamily: "list_set",
      compatibleFamilies: ["direct_fact", "profile_report"],
      expectedAnswerShape: "list",
      expectedTerms: ["positive reinforcement", "dog training course", "dog-owners group"]
    },
    {
      id: "audit_locomo_pastries",
      namespaceId: namespaces.locomoPastries,
      query: "What kind of pastries did Andrew and his girlfriend have at the cafe?",
      expectedFamily: "exact_detail",
      compatibleFamilies: ["direct_fact", "list_set"],
      expectedAnswerShape: "list",
      expectedTerms: ["croissants", "muffins", "tarts"]
    },
    {
      id: "audit_locomo_bands",
      namespaceId: namespaces.locomoBands,
      query: "Which bands has Dave enjoyed listening to?",
      expectedFamily: "list_set",
      compatibleFamilies: ["direct_fact", "exact_detail"],
      expectedAnswerShape: "list",
      expectedTerms: ["Aerosmith", "The Fireworks"]
    },
    {
      id: "audit_locomo_favorite_band",
      namespaceId: namespaces.locomoBands,
      query: "Which band was Dave's favorite at the music festival in April 2023?",
      expectedFamily: "exact_detail",
      compatibleFamilies: ["temporal_detail", "direct_fact"],
      expectedAnswerShape: "scalar",
      expectedTerms: ["Aerosmith"]
    },
    {
      id: "audit_locomo_charity_awareness",
      namespaceId: namespaces.locomoCaroline,
      query: "What did the charity race raise awareness for?",
      expectedFamily: "direct_fact",
      expectedAnswerShape: "scalar",
      expectedTerms: ["mental health"]
    }
  ];
}

function naturalControlScenarios(): readonly AuditScenario[] {
  return [
    {
      id: "audit_personal_lauren_full",
      namespaceId: "personal",
      query: "Tell me everything about Lauren.",
      expectedFamily: "profile_report",
      expectedAnswerShape: "report",
      expectedTerms: ["Lauren", "Koh Samui"]
    },
    {
      id: "audit_personal_lauren_timeline",
      namespaceId: "personal",
      query: "What happened between Lauren and me?",
      expectedFamily: "relationship_chronology",
      expectedAnswerShape: "timeline",
      expectedTerms: ["Lauren"]
    },
    {
      id: "audit_personal_career",
      namespaceId: "personal",
      query: "What have I done in my career?",
      expectedFamily: "profile_report",
      expectedAnswerShape: "report",
      expectedTerms: ["Apogee", "AI Brain"]
    },
    {
      id: "audit_personal_work_history",
      namespaceId: "personal",
      query: "Give me my full work history with roles and dates.",
      expectedFamily: "profile_report",
      expectedAnswerShape: "report",
      expectedTerms: ["Apogee", "Two-Way"]
    },
    {
      id: "audit_personal_carmack",
      namespaceId: "personal",
      query: "What things did I do with id Software and John Carmack?",
      expectedFamily: "profile_report",
      expectedAnswerShape: "report",
      expectedTerms: ["John Carmack", "Quake"]
    },
    {
      id: "audit_personal_ai_brain",
      namespaceId: "personal",
      query: "Tell me everything about AI Brain.",
      expectedFamily: "project_definition",
      expectedAnswerShape: "report",
      expectedTerms: ["AI Brain"]
    },
    {
      id: "audit_personal_well_inked",
      namespaceId: "personal",
      query: "What is Well Inked?",
      expectedFamily: "project_definition",
      expectedAnswerShape: "report",
      expectedTerms: ["Well Inked"]
    },
    {
      id: "audit_personal_active_build",
      namespaceId: "personal",
      query: "What am I actively building now versus where do I work?",
      expectedFamily: "profile_report",
      expectedAnswerShape: "report",
      expectedTerms: ["Two-Way", "AI Brain"]
    },
    {
      id: "audit_personal_samui_experience",
      namespaceId: "personal",
      query: "What do we know about The Samui Experience?",
      expectedFamily: "profile_report",
      expectedAnswerShape: "report",
      expectedTerms: ["The Samui Experience", "Lauren"]
    },
    {
      id: "audit_personal_source_audit",
      namespaceId: "personal",
      query: "Where did that answer come from?",
      expectedFamily: "source_audit",
      expectedAnswerShape: "report",
      expectedTerms: [],
      shouldAbstain: true
    }
  ];
}

function classifyResidualOwner(params: {
  readonly wrongFamily: boolean;
  readonly expectedAnswerShape: string;
  readonly actualAnswerShape: string | null;
  readonly missingTerms: readonly string[];
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly subjectMatch: string | null;
}): string {
  if (params.wrongFamily) {
    return "wrong_owner";
  }
  if ((params.subjectMatch === "mixed" || params.subjectMatch === "mismatched" || params.subjectMatch === "unknown") && params.missingTerms.length > 0) {
    return "subject_binding_missing";
  }
  if (params.evidenceCount <= 0) {
    return "right_owner_incomplete_support";
  }
  if (params.actualAnswerShape === "list" || params.expectedAnswerShape === "list") {
    return "list_set_rendering_wrong";
  }
  if (params.expectedAnswerShape === "timeline") {
    return "temporal_rendering_wrong";
  }
  if ((params.finalClaimSource ?? "").includes("report") || (params.finalClaimSource ?? "").includes("profile")) {
    return "report_semantics_wrong";
  }
  return "right_owner_wrong_shape";
}

async function runScenario(scenario: AuditScenario): Promise<RetrievalQuestionAuditRow> {
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: scenario.namespaceId,
    query: scenario.query,
    limit: 8,
    detail_mode: "full"
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const actualFamily = typeof payload?.queryContract === "string" ? payload.queryContract : null;
  const actualAnswerShape = typeof payload?.answerShape === "string" ? payload.answerShape : null;
  const answerText = answerTextFromPayload(payload);
  const evidenceCount = payloadEvidenceCount(payload);
  const sourceCount = sourceCountFromPayload(payload);
  const queryTimeModelCalls = queryTimeModelCallsFromPayload(payload);
  const compatibleFamilies = new Set([scenario.expectedFamily, ...(scenario.compatibleFamilies ?? [])]);
  const wrongFamily = actualFamily ? !compatibleFamilies.has(actualFamily) : true;
  const missingTerms = scenario.expectedTerms.filter(
    (term) => !hasTerm(answerText, term) && !hasTerm(JSON.stringify(payload ?? null), term)
  );
  const finalClaimSource = typeof payload?.finalClaimSource === "string" ? payload.finalClaimSource : null;
  const subjectMatch =
    typeof payload?.meta?.answerAssessment?.subjectMatch === "string" ? payload.meta.answerAssessment.subjectMatch : null;
  const allowsAbstentionPass = scenario.shouldAbstain === true && !wrongFamily && queryTimeModelCalls === 0;
  const residualOwner =
    (missingTerms.length === 0 && !wrongFamily && evidenceCount > 0) || allowsAbstentionPass
      ? "pass"
      : classifyResidualOwner({
          wrongFamily,
          expectedAnswerShape: scenario.expectedAnswerShape,
          actualAnswerShape,
          missingTerms,
          finalClaimSource,
          evidenceCount,
          subjectMatch
        });
  const notes = `family=${actualFamily ?? "missing"} shape=${actualAnswerShape ?? "missing"} final=${finalClaimSource ?? "missing"} render=${typeof payload?.meta?.answerShapingTrace?.renderContractSelected === "string" ? payload.meta.answerShapingTrace.renderContractSelected : "missing"}`;
  return {
    id: scenario.id,
    namespaceId: scenario.namespaceId,
    query: scenario.query,
    expectedFamily: scenario.expectedFamily,
    expectedAnswerShape: scenario.expectedAnswerShape,
    actualFamily,
    actualAnswerShape,
    finalClaimSource,
    evidenceCount,
    sourceCount,
    queryTimeModelCalls,
    residualOwner,
    missingTerms,
    wrongFamily,
    notes
  };
}

function countBy<T>(items: readonly T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function toMarkdown(report: RetrievalQuestionAuditReport): string {
  const lines = [
    "# Retrieval Question Audit",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sampleCount: ${report.sampleCount}`,
    `- wrongFamilyCount: ${report.wrongFamilyCount}`,
    `- queryTimeModelCalls: ${report.queryTimeModelCalls}`,
    `- supportedZeroEvidenceCount: ${report.supportedZeroEvidenceCount}`,
    `- residualOwnerBreakdown: ${JSON.stringify(report.residualOwnerBreakdown)}`,
    `- passed: ${report.passed}`,
    "",
    "## Results",
    ""
  ];
  for (const row of report.results) {
    lines.push(
      `- ${row.id}: owner=${row.residualOwner} wrongFamily=${row.wrongFamily} evidence=${row.evidenceCount}/${row.sourceCount} queryTimeModelCalls=${row.queryTimeModelCalls}`
    );
    if (row.missingTerms.length > 0) {
      lines.push(`  - missingTerms: ${row.missingTerms.join(", ")}`);
    }
    lines.push(`  - notes: ${row.notes}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteRetrievalQuestionAudit(): Promise<{
  readonly report: RetrievalQuestionAuditReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fixtureNamespaces = await buildFixtureNamespaces(stamp);
  const scenarios = [...benchmarkDerivedScenarios(fixtureNamespaces), ...naturalControlScenarios()];
  const results: RetrievalQuestionAuditRow[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }
  const report: RetrievalQuestionAuditReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "retrieval_question_audit",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        scenarioCount: results.length,
        benchmarkDerivedCount: 10,
        naturalControlCount: 10,
        fixtureNamespaces: Object.values(fixtureNamespaces).join(","),
        includesPersonal: true
      }
    }),
    sampleCount: results.length,
    wrongFamilyCount: results.filter((row) => row.wrongFamily).length,
    queryTimeModelCalls: results.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    supportedZeroEvidenceCount: results.filter((row) => row.residualOwner !== "pass" && row.evidenceCount <= 0).length,
    residualOwnerBreakdown: countBy(results, (row) => row.residualOwner),
    results,
    passed:
      results.every((row) => row.residualOwner === "pass") &&
      results.every((row) => row.queryTimeModelCalls === 0) &&
      results.every((row) => row.evidenceCount > 0 || row.expectedFamily === "source_audit")
  };
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `retrieval-question-audit-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `retrieval-question-audit-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runRetrievalQuestionAuditCli(): Promise<void> {
  const { output } = await runAndWriteRetrievalQuestionAudit();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
}
