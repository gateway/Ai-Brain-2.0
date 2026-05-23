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

interface AnswerShapingScenario {
  readonly id: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly expectedRenderContracts?: readonly string[];
  readonly minimumEvidence: number;
}

interface AnswerShapingPackRow {
  readonly id: string;
  readonly query: string;
  readonly namespaceId: string;
  readonly finalClaimSource: string | null;
  readonly renderContract: string | null;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly queryTimeModelCalls: number;
  readonly answerText: string;
  readonly failures: readonly string[];
  readonly passed: boolean;
}

export interface AnswerShapingPackReport {
  readonly generatedAt: string;
  readonly benchmark: "answer_shaping_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly failureCount: number;
  readonly wrongFamilyCount: number;
  readonly queryTimeModelCalls: number;
  readonly supportedZeroEvidenceCount: number;
  readonly results: readonly AnswerShapingPackRow[];
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

function sourceCountFromPayload(payload: any): number {
  const sourceTrail = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail : [];
  if (sourceTrail.length > 0) {
    return sourceTrail.length;
  }
  const evidence = Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence : [];
  return evidence.filter((item: any) => typeof item?.artifactId === "string" || typeof item?.sourceUri === "string").length;
}

function hasTerm(value: string, term: string): boolean {
  return value.toLowerCase().includes(term.toLowerCase());
}

async function buildFixtureNamespaces(stamp: string): Promise<{
  readonly longmemCommute: string;
  readonly longmemPlay: string;
  readonly locomoCareer: string;
  readonly locomoPetCare: string;
}> {
  const namespaces = {
    longmemCommute: `benchmark_answer_shape_longmem_commute_${stamp}`,
    longmemPlay: `benchmark_answer_shape_longmem_play_${stamp}`,
    locomoCareer: `benchmark_answer_shape_locomo_career_${stamp}`,
    locomoPetCare: `benchmark_answer_shape_locomo_petcare_${stamp}`
  } as const;
  await ingestLongMemEvalEntryFixture(namespaces.longmemCommute, await loadLongMemEvalEntryFixture("118b2229"));
  await ingestLongMemEvalEntryFixture(namespaces.longmemPlay, await loadLongMemEvalEntryFixture("58bf7951"));
  await ingestLoCoMoConversationFixture(namespaces.locomoCareer, await loadLoCoMoConversationFixture("conv-30"));
  await ingestLoCoMoConversationFixture(namespaces.locomoPetCare, await loadLoCoMoConversationFixture("conv-44"));
  for (const namespaceId of Object.values(namespaces)) {
    await rebuildTypedMemoryNamespace(namespaceId);
  }
  return namespaces;
}

function scenarios(namespaces: Awaited<ReturnType<typeof buildFixtureNamespaces>>): readonly AnswerShapingScenario[] {
  return [
    {
      id: "longmem_commute_exact_value",
      namespaceId: namespaces.longmemCommute,
      query: "How long is my daily commute to work?",
      expectedTerms: ["45 minutes each way"],
      expectedRenderContracts: ["exact_support_span", "exact_canonical_value"],
      minimumEvidence: 1
    },
    {
      id: "longmem_play_exact_value",
      namespaceId: namespaces.longmemPlay,
      query: "What play did I attend at the local community theater?",
      expectedTerms: ["The Glass Menagerie"],
      expectedRenderContracts: ["exact_support_span", "exact_canonical_value"],
      minimumEvidence: 1
    },
    {
      id: "locomo_causal_reason",
      namespaceId: namespaces.locomoCareer,
      query: "Why did Jon decide to start his dance studio?",
      expectedTerms: ["lost his job", "passion", "share"],
      expectedRenderContracts: ["causal_reason_render", "direct_fact_causal_reason_render"],
      minimumEvidence: 1
    },
    {
      id: "locomo_pet_care_list",
      namespaceId: namespaces.locomoPetCare,
      query: "What kind of classes or groups has Audrey joined to take better care of her dogs?",
      expectedTerms: ["positive reinforcement", "dog training course", "agility training course", "dog-owners group"],
      expectedRenderContracts: ["pet_care_classes_render", "direct_fact_list_set_render"],
      minimumEvidence: 1
    },
    {
      id: "career_dossier_regression",
      namespaceId: "personal",
      query: "Give me my full work history with roles and dates.",
      expectedTerms: ["Apogee", "Rogue", "Two-Way", "Well Inked"],
      minimumEvidence: 1
    },
    {
      id: "employment_compact_regression",
      namespaceId: "personal",
      query: "Can you give me a list of companies that I've worked for in summarized short form?",
      expectedTerms: ["Apogee", "Rogue", "Well Inked", "Two-Way"],
      minimumEvidence: 1
    }
  ];
}

async function runScenario(scenario: AnswerShapingScenario): Promise<AnswerShapingPackRow> {
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: scenario.namespaceId,
    query: scenario.query,
    limit: 8,
    detail_mode: "full"
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const answerText = answerTextFromPayload(payload);
  const evidenceCount = payloadEvidenceCount(payload);
  const sourceCount = sourceCountFromPayload(payload);
  const renderContract =
    typeof payload?.meta?.answerShapingTrace?.renderContractSelected === "string"
      ? payload.meta.answerShapingTrace.renderContractSelected
      : null;
  const queryTimeModelCalls = queryTimeModelCallsFromPayload(payload);
  const failures: string[] = [];
  for (const term of scenario.expectedTerms) {
    if (!hasTerm(answerText, term) && !hasTerm(JSON.stringify(payload ?? null), term)) {
      failures.push(`missing_term:${term}`);
    }
  }
  if (scenario.minimumEvidence > 0 && evidenceCount < scenario.minimumEvidence) {
    failures.push(`evidence_count_below_min:${evidenceCount}`);
  }
  if (scenario.minimumEvidence > 0 && sourceCount <= 0) {
    failures.push("source_count_zero");
  }
  if (scenario.expectedRenderContracts && scenario.expectedRenderContracts.length > 0) {
    if (!renderContract || !scenario.expectedRenderContracts.includes(renderContract)) {
      failures.push(`render_contract:${renderContract ?? "missing"}`);
    }
  }
  if (queryTimeModelCalls > 0) {
    failures.push(`query_time_model_calls:${queryTimeModelCalls}`);
  }
  return {
    id: scenario.id,
    query: scenario.query,
    namespaceId: scenario.namespaceId,
    finalClaimSource: typeof payload?.finalClaimSource === "string" ? payload.finalClaimSource : null,
    renderContract,
    evidenceCount,
    sourceCount,
    queryTimeModelCalls,
    answerText,
    failures,
    passed: failures.length === 0
  };
}

function toMarkdown(report: AnswerShapingPackReport): string {
  const lines = [
    "# Answer Shaping Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sampleCount: ${report.sampleCount}`,
    `- failureCount: ${report.failureCount}`,
    `- wrongFamilyCount: ${report.wrongFamilyCount}`,
    `- queryTimeModelCalls: ${report.queryTimeModelCalls}`,
    `- supportedZeroEvidenceCount: ${report.supportedZeroEvidenceCount}`,
    `- passed: ${report.passed}`,
    "",
    "## Results",
    ""
  ];
  for (const row of report.results) {
    lines.push(
      `- ${row.id}: ${row.passed ? "pass" : "fail"} | final=${row.finalClaimSource ?? "n/a"} | render=${row.renderContract ?? "n/a"} | evidence=${row.evidenceCount}/${row.sourceCount} | queryTimeModelCalls=${row.queryTimeModelCalls}`
    );
    for (const failure of row.failures) {
      lines.push(`  - ${failure}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteAnswerShapingPack(): Promise<{
  readonly report: AnswerShapingPackReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fixtureNamespaces = await buildFixtureNamespaces(stamp);
  const results: AnswerShapingPackRow[] = [];
  for (const scenario of scenarios(fixtureNamespaces)) {
    results.push(await runScenario(scenario));
  }
  const report: AnswerShapingPackReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "answer_shaping_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        scenarioCount: results.length,
        fixtureNamespaces: Object.values(fixtureNamespaces).join(","),
        includesPersonal: true
      }
    }),
    sampleCount: results.length,
    failureCount: results.filter((row) => !row.passed).length,
    wrongFamilyCount: results.filter((row) => row.failures.some((failure) => failure.startsWith("render_contract:"))).length,
    queryTimeModelCalls: results.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    supportedZeroEvidenceCount: results.filter((row) => row.evidenceCount <= 0).length,
    results,
    passed: results.every((row) => row.passed)
  };
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `answer-shaping-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `answer-shaping-pack-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runAnswerShapingPackCli(): Promise<void> {
  const { output } = await runAndWriteAnswerShapingPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
}
