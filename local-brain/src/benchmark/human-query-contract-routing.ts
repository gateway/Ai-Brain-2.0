import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { rebuildContractProjectionsNamespace } from "../contract-projections/service.js";
import { closePool } from "../db/client.js";
import { inferQueryContract, type QueryContractName } from "../retrieval/query-contract-router.js";
import { searchMemory } from "../retrieval/service.js";

interface ClassificationCase {
  readonly id: string;
  readonly query: string;
  readonly expectedContract: QueryContractName;
}

interface ClassificationResult extends ClassificationCase {
  readonly actualContract: QueryContractName;
  readonly passed: boolean;
  readonly latencyMs: number;
  readonly routingReasons: readonly string[];
}

interface RoutedCase {
  readonly id: string;
  readonly query: string;
  readonly expectedContract: QueryContractName;
  readonly expectedFinalClaimSource: string | null;
  readonly expectedTerms: readonly string[];
  readonly shouldHaveEvidence: boolean;
}

interface RoutedResult extends RoutedCase {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly latencyMs: number;
  readonly queryContractName: string | null;
  readonly finalClaimSource: string | null;
  readonly dominantStage: string | null;
  readonly evidenceCount: number;
  readonly queryTimeModelCalls: number;
  readonly claim: string;
}

interface HumanQueryContractRoutingReport {
  readonly generatedAt: string;
  readonly benchmark: "human_query_contract_routing";
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly thresholds: {
    readonly classificationAccuracy: number;
    readonly routeSelectionAccuracy: number;
    readonly relationshipChronologyCoverage: number;
    readonly routerP95LatencyMs: number;
    readonly routerMaxLatencyMs: number;
    readonly routedP95LatencyMs: number;
    readonly routedTargetP95LatencyMs: number;
  };
  readonly metrics: {
    readonly classificationCaseCount: number;
    readonly classificationAccuracy: number;
    readonly routeSelectionAccuracy: number;
    readonly relationshipChronologyCoverage: number;
    readonly routerP50LatencyMs: number;
    readonly routerP95LatencyMs: number;
    readonly routerMaxLatencyMs: number;
    readonly routedP50LatencyMs: number;
    readonly routedP95LatencyMs: number;
    readonly routedMaxLatencyMs: number;
    readonly unsupportedNoEvidenceSuccessCount: number;
    readonly unknownOwnerCount: number;
    readonly queryTimeModelCalls: number;
    readonly evidenceZeroBackedSuccessCount: number;
  };
  readonly failures: readonly string[];
  readonly classificationResults: readonly ClassificationResult[];
  readonly routedResults: readonly RoutedResult[];
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(2));
}

function rate(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function variants(prefixes: readonly string[], names: readonly string[], suffixes: readonly string[], expectedContract: QueryContractName, idPrefix: string): readonly ClassificationCase[] {
  const cases: ClassificationCase[] = [];
  let index = 0;
  for (const prefix of prefixes) {
    for (const name of names) {
      for (const suffix of suffixes) {
        cases.push({
          id: `${idPrefix}_${index++}`,
          query: `${prefix}${name}${suffix}`.replace(/\s+/gu, " ").trim(),
          expectedContract
        });
      }
    }
  }
  return cases;
}

function classificationCases(): readonly ClassificationCase[] {
  const relationshipChronology = [
    ...variants(
      ["what happened between ", "what went on with ", "tell me our history with ", "what is my history with "],
      ["Lauren", "Dan", "Ben", "John", "James"],
      [" and me?", "?", " recently?", " overall?"],
      "relationship_chronology",
      "relationship_chronology"
    )
  ].slice(0, 48);
  const relationshipMap = variants(
    ["who is ", "how do I know ", "what is ", "who is "],
    ["Lauren", "Dan", "Ben", "John", "James"],
    [" to me?", " in my life?", " associated with?", " in my life right now?"],
    "relationship_map",
    "relationship_map"
  ).slice(0, 32);
  const currentState = [
    "what am I working on right now?",
    "what projects am I focused on now?",
    "what did I buy today?",
    "what food do I like now?",
    "what coffee do I prefer now?",
    "what is my current routine?",
    "what constraints matter right now?",
    "what am I currently focused on?",
    "what did I buy on March 28 2026?",
    "what do I like right now?"
  ].map((query, index) => ({ id: `current_state_${index}`, query, expectedContract: "current_state" as const }));
  const temporal = [
    "when did Lauren leave Thailand?",
    "when did Dan mention Sinners?",
    "when did I buy the groceries?",
    "when did the project start?",
    "when did Lauren leave for the US?",
    "when did I go to Lake Tahoe?",
    "when did Ben and I discuss the project?",
    "when did John start Samui Experience?",
    "when did the dinner happen?",
    "when did I move to Thailand?"
  ].map((query, index) => ({ id: `temporal_${index}`, query, expectedContract: "temporal_event" as const }));
  const listSet = [
    "what movies have I talked about?",
    "what books have I read?",
    "what people support me?",
    "what activities do I do?",
    "what places have I lived?",
    "what items did I buy?",
    "what friends do I have?",
    "what things are in storage?",
    "what films did I mention?",
    "what activities do I like?"
  ].map((query, index) => ({ id: `list_set_${index}`, query, expectedContract: "list_set" as const }));
  const profile = [
    "summarize what I know about Lauren",
    "tell me about Dan",
    "tell me everything about Lauren",
    "tell me everything about Chiang Mai",
    "what have I done in my career?",
    "tell me about my work history",
    "what things did I do with id Software and John Carmack?",
    "give me an overview of John",
    "what do we know about Ben?",
    "summarize James",
    "recap what I know about Omi",
    "give me an overview of my relationship network",
    "tell me about my current life context",
    "summarize what I know about the project",
    "recap what happened lately"
  ].map((query, index) => ({ id: `profile_report_${index}`, query, expectedContract: "profile_report" as const }));
  const projectDefinition = [
    "what is Two Way?",
    "what is AI Brain?",
    "what is Well Inked?",
    "tell me about Preset Kitchen",
    "explain Bumblebee"
  ].map((query, index) => ({ id: `project_definition_${index}`, query, expectedContract: "project_definition" as const }));
  const abstention = [
    "what happened between me and them?",
    "what happened between me and someone?",
    "what went on between us?",
    "our relationship history?",
    "what changed in the relationship?"
  ].map((query, index) => ({ id: `abstention_${index}`, query, expectedContract: "abstention" as const }));

  return [...relationshipChronology.slice(0, 43), ...relationshipMap, ...currentState, ...temporal, ...listSet, ...profile, ...projectDefinition, ...abstention].slice(0, 125);
}

const ROUTED_CASES: readonly RoutedCase[] = [
  {
    id: "natural_lauren_between_me",
    query: "what happened between Lauren and me?",
    expectedContract: "relationship_chronology",
    expectedFinalClaimSource: "relationship_chronology_projection",
    expectedTerms: ["Lauren"],
    shouldHaveEvidence: true
  },
  {
    id: "canonical_lauren_history",
    query: "What is Steve's history with Lauren?",
    expectedContract: "relationship_chronology",
    expectedFinalClaimSource: "relationship_chronology_projection",
    expectedTerms: ["Lauren"],
    shouldHaveEvidence: true
  },
  {
    id: "lauren_relationship_map",
    query: "Who is Lauren to me?",
    expectedContract: "relationship_map",
    expectedFinalClaimSource: "relationship_map_projection",
    expectedTerms: ["Lauren"],
    shouldHaveEvidence: true
  },
  {
    id: "lauren_broad_dossier",
    query: "Tell me everything about Lauren.",
    expectedContract: "profile_report",
    expectedFinalClaimSource: "entity_dossier",
    expectedTerms: ["Lauren", "Koh Samui"],
    shouldHaveEvidence: true
  },
  {
    id: "bend_place_dossier",
    query: "What does the system know about Bend for me?",
    expectedContract: "profile_report",
    expectedFinalClaimSource: "entity_dossier",
    expectedTerms: ["Bend"],
    shouldHaveEvidence: true
  },
  {
    id: "career_work_history",
    query: "What have I done in my career?",
    expectedContract: "profile_report",
    expectedFinalClaimSource: "work_history_report_direct_read_model",
    expectedTerms: ["AI Brain", "Apogee"],
    shouldHaveEvidence: true
  },
  {
    id: "carmack_game_era_history",
    query: "What things did I do with id Software and John Carmack?",
    expectedContract: "profile_report",
    expectedFinalClaimSource: "work_history_report_direct_read_model",
    expectedTerms: ["John Carmack", "Quake", "id Software"],
    shouldHaveEvidence: true
  },
  {
    id: "broad_project_definition",
    query: "Tell me everything about AI Brain.",
    expectedContract: "project_definition",
    expectedFinalClaimSource: "project_definition_projection",
    expectedTerms: ["AI Brain"],
    shouldHaveEvidence: true
  },
  {
    id: "ambiguous_relationship_abstention",
    query: "what happened between me and them?",
    expectedContract: "abstention",
    expectedFinalClaimSource: null,
    expectedTerms: [],
    shouldHaveEvidence: false
  }
];

function classify(testCase: ClassificationCase): ClassificationResult {
  const startedAt = performance.now();
  const contract = inferQueryContract(testCase.query);
  const latencyMs = Number((performance.now() - startedAt).toFixed(3));
  return {
    ...testCase,
    actualContract: contract.contractName,
    passed: contract.contractName === testCase.expectedContract,
    latencyMs,
    routingReasons: contract.routingReasons
  };
}

async function runRoutedCase(namespaceId: string, testCase: RoutedCase): Promise<RoutedResult> {
  const startedAt = performance.now();
  const response = await searchMemory({ namespaceId, query: testCase.query, limit: 10 });
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const finalClaimSource = response.meta.finalClaimSource ?? null;
  const evidenceCount = response.evidence.length;
  const queryContractName = response.meta.queryContractName ?? null;
  const claim = response.duality.claim.text ?? "";
  const haystack = `${claim} ${response.evidence.map((entry) => entry.snippet).join(" ")}`.toLowerCase();
  const failures: string[] = [];
  if (queryContractName !== testCase.expectedContract) failures.push("wrong_query_contract");
  if (testCase.expectedFinalClaimSource !== finalClaimSource) failures.push("wrong_final_claim_source");
  if (testCase.shouldHaveEvidence && evidenceCount <= 0) failures.push("evidence_missing");
  if (!testCase.shouldHaveEvidence && evidenceCount > 0) failures.push("unsupported_no_evidence_success");
  for (const term of testCase.expectedTerms) {
    if (!haystack.includes(term.toLowerCase())) failures.push(`missing_term:${term}`);
  }
  const queryTimeModelCalls = response.meta.queryTimeGLiNEROrLLMUsed === true ? 1 : 0;
  if (queryTimeModelCalls > 0) failures.push("query_time_model_calls");
  if (testCase.shouldHaveEvidence && evidenceCount === 0 && finalClaimSource !== null) failures.push("evidence_zero_backed_success");
  return {
    ...testCase,
    passed: failures.length === 0,
    failures,
    latencyMs,
    queryContractName,
    finalClaimSource,
    dominantStage: response.meta.dominantStage ?? null,
    evidenceCount,
    queryTimeModelCalls,
    claim
  };
}

export async function runHumanQueryContractRoutingBenchmark(
  namespaceId = process.env.BRAIN_HUMAN_QUERY_CONTRACT_ROUTING_NAMESPACE ?? "personal"
): Promise<HumanQueryContractRoutingReport> {
  const previousRelationshipProjectionFlag = process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION;
  const previousProjectDefinitionFlag = process.env.BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION;
  process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION = "1";
  process.env.BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION = "1";
  try {
    await rebuildContractProjectionsNamespace(namespaceId);
    const classificationResults = classificationCases().map(classify);
    const routedResults: RoutedResult[] = [];
    for (const testCase of ROUTED_CASES) {
      routedResults.push(await runRoutedCase(namespaceId, testCase));
    }
    const routerLatencies = classificationResults.map((entry) => entry.latencyMs);
    const routedLatencies = routedResults.map((entry) => entry.latencyMs);
    const relationshipChronologyResults = classificationResults.filter((entry) => entry.expectedContract === "relationship_chronology");
    const thresholds = {
      classificationAccuracy: 0.95,
      routeSelectionAccuracy: 0.95,
      relationshipChronologyCoverage: 0.95,
      routerP95LatencyMs: 25,
      routerMaxLatencyMs: 100,
      routedP95LatencyMs: 1000,
      routedTargetP95LatencyMs: 500
    };
    const metrics = {
      classificationCaseCount: classificationResults.length,
      classificationAccuracy: rate(classificationResults.filter((entry) => entry.passed).length, classificationResults.length),
      routeSelectionAccuracy: rate(routedResults.filter((entry) => entry.passed).length, routedResults.length),
      relationshipChronologyCoverage: rate(relationshipChronologyResults.filter((entry) => entry.passed).length, relationshipChronologyResults.length),
      routerP50LatencyMs: percentile(routerLatencies, 50),
      routerP95LatencyMs: percentile(routerLatencies, 95),
      routerMaxLatencyMs: Number(Math.max(0, ...routerLatencies).toFixed(2)),
      routedP50LatencyMs: percentile(routedLatencies, 50),
      routedP95LatencyMs: percentile(routedLatencies, 95),
      routedMaxLatencyMs: Number(Math.max(0, ...routedLatencies).toFixed(2)),
      unsupportedNoEvidenceSuccessCount: routedResults.filter((entry) => !entry.shouldHaveEvidence && entry.evidenceCount > 0).length,
      unknownOwnerCount: routedResults.filter((entry) => !entry.queryContractName).length,
      queryTimeModelCalls: routedResults.reduce((sum, entry) => sum + entry.queryTimeModelCalls, 0),
      evidenceZeroBackedSuccessCount: routedResults.filter((entry) => entry.shouldHaveEvidence && entry.finalClaimSource && entry.evidenceCount === 0).length
    };
    const failures: string[] = [];
    if (metrics.classificationAccuracy < thresholds.classificationAccuracy) failures.push("classification_accuracy_below_threshold");
    if (metrics.routeSelectionAccuracy < thresholds.routeSelectionAccuracy) failures.push("route_selection_accuracy_below_threshold");
    if (metrics.relationshipChronologyCoverage < thresholds.relationshipChronologyCoverage) failures.push("relationship_chronology_coverage_below_threshold");
    if (metrics.routerP95LatencyMs > thresholds.routerP95LatencyMs) failures.push("router_p95_latency_exceeded");
    if (metrics.routerMaxLatencyMs > thresholds.routerMaxLatencyMs) failures.push("router_max_latency_exceeded");
    if (metrics.routedP95LatencyMs > thresholds.routedP95LatencyMs) failures.push("routed_p95_latency_exceeded");
    if (metrics.unsupportedNoEvidenceSuccessCount > 0) failures.push("unsupported_no_evidence_success");
    if (metrics.unknownOwnerCount > 0) failures.push("unknown_query_contract_owner");
    if (metrics.queryTimeModelCalls > 0) failures.push("query_time_model_calls");
    if (metrics.evidenceZeroBackedSuccessCount > 0) failures.push("evidence_zero_backed_success");
    return {
      generatedAt: new Date().toISOString(),
      benchmark: "human_query_contract_routing",
      namespaceId,
      passed: failures.length === 0,
      thresholds,
      metrics,
      failures,
      classificationResults,
      routedResults
    };
  } finally {
    if (previousRelationshipProjectionFlag === undefined) delete process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION;
    else process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION = previousRelationshipProjectionFlag;
    if (previousProjectDefinitionFlag === undefined) delete process.env.BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION;
    else process.env.BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION = previousProjectDefinitionFlag;
  }
}

function markdownReport(report: HumanQueryContractRoutingReport): string {
  const routedRows = report.routedResults
    .map((entry) => `| ${entry.passed ? "PASS" : "FAIL"} | ${entry.id} | ${entry.queryContractName ?? "-"} | ${entry.finalClaimSource ?? "-"} | ${entry.evidenceCount} | ${entry.latencyMs} | ${entry.failures.join(", ") || "-"} |`)
    .join("\n");
  const failedClassification = report.classificationResults
    .filter((entry) => !entry.passed)
    .slice(0, 25)
    .map((entry) => `- ${entry.id}: expected=${entry.expectedContract} actual=${entry.actualContract} q=${entry.query}`)
    .join("\n") || "- none";
  return `# Human Query Contract Routing

- generatedAt: ${report.generatedAt}
- namespaceId: ${report.namespaceId}
- passed: ${report.passed}
- classificationAccuracy: ${report.metrics.classificationAccuracy}
- routeSelectionAccuracy: ${report.metrics.routeSelectionAccuracy}
- relationshipChronologyCoverage: ${report.metrics.relationshipChronologyCoverage}
- routerP95LatencyMs: ${report.metrics.routerP95LatencyMs}
- routedP95LatencyMs: ${report.metrics.routedP95LatencyMs}
- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}
- unsupportedNoEvidenceSuccessCount: ${report.metrics.unsupportedNoEvidenceSuccessCount}

## Routed Cases

| status | case | contract | final source | evidence | latencyMs | failures |
| --- | --- | --- | --- | ---: | ---: | --- |
${routedRows}

## Failed Classification Cases

${failedClassification}
`;
}

export async function runHumanQueryContractRoutingCli(): Promise<void> {
  try {
    const namespaceArgIndex = process.argv.indexOf("--namespace");
    const namespaceId = namespaceArgIndex >= 0 ? process.argv[namespaceArgIndex + 1] : undefined;
    const report = await runHumanQueryContractRoutingBenchmark(namespaceId);
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const jsonPath = path.join(dir, `human-query-contract-routing-${stamp}.json`);
    const markdownPath = path.join(dir, `human-query-contract-routing-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(markdownPath, markdownReport(report));
    console.log(JSON.stringify({ passed: report.passed, jsonPath, markdownPath, metrics: report.metrics, failures: report.failures }, null, 2));
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
