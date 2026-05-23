import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { rebuildContractProjectionsNamespace } from "../contract-projections/service.js";
import { closePool } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { runNamespaceVectorActivation } from "../jobs/vector-sync-runtime.js";
import { searchMemory } from "../retrieval/service.js";
import { inferQueryContract } from "../retrieval/query-contract-router.js";
import {
  answerTextFromPayload,
  applyProjectionRuntimeFlags,
  applyVectorRuntimeFlags,
  benchmarkOutputDir,
  hasTerm,
  payloadEvidenceCount,
  percentile,
  projectionRuntimeFlags,
  queryTimeModelCallsFromPayload,
  rate,
  restoreProjectionRuntimeFlags,
  restoreVectorRuntimeFlags,
  vectorRuntimeFlags
} from "./query-benchmark-utils.js";
import { QUERY_GOLD_FIXTURE_NAMESPACE } from "./query-taxonomy-gold-fixtures.js";
import { runHumanSyntheticWatchBenchmark } from "./human-synthetic-watch.js";
import { prepareQueryTaxonomyGoldFixtureForHybrid } from "./query-taxonomy-gold-hybrid-prep.js";

type SemanticLiftNamespaceKind = "personal" | "synthetic" | "fixture";

interface SemanticLiftCase {
  readonly id: string;
  readonly namespaceKind: SemanticLiftNamespaceKind;
  readonly query: string;
  readonly expectedDomain: string;
  readonly expectedContract: string;
  readonly expectedTerms: readonly string[];
  readonly minimumEvidence: number;
  readonly termScope?: "answer" | "payload";
}

interface LiftCaseResult {
  readonly id: string;
  readonly query: string;
  readonly namespaceId: string;
  readonly mode: "lexical" | "hybrid";
  readonly contract: string | null;
  readonly domain: string | null;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly matchedTerms: number;
  readonly totalTerms: number;
  readonly latencyMs: number;
  readonly passed: boolean;
  readonly queryTimeModelCalls: number;
  readonly vectorContribution: string | null;
  readonly answerText: string;
  readonly failures: readonly string[];
}

export interface SemanticQueryLiftPackReport {
  readonly generatedAt: string;
  readonly benchmark: "semantic_query_lift_pack";
  readonly passed: boolean;
  readonly namespaces: {
    readonly personal: string;
    readonly synthetic: string;
    readonly fixture: string;
  };
  readonly lexical: {
    readonly passRate: number;
    readonly termRecall: number;
    readonly p95LatencyMs: number;
  };
  readonly hybrid: {
    readonly passRate: number;
    readonly termRecall: number;
    readonly p95LatencyMs: number;
    readonly vectorContributionRate: number;
  };
  readonly deltas: {
    readonly passRateDelta: number;
    readonly termRecallDelta: number;
  };
  readonly failures: readonly string[];
  readonly results: readonly LiftCaseResult[];
}

const SEMANTIC_LIFT_CASES: readonly SemanticLiftCase[] = [
  {
    id: "fixture_release_readiness_steps",
    namespaceKind: "fixture",
    query: "how do I run production readiness?",
    expectedDomain: "procedural_memory",
    expectedContract: "procedure_lookup",
    expectedTerms: ["production readiness", "manifest"],
    minimumEvidence: 1,
    termScope: "answer"
  },
  {
    id: "fixture_release_readiness_manifest_steps",
    namespaceKind: "fixture",
    query: "what are the steps to run production readiness?",
    expectedDomain: "procedural_memory",
    expectedContract: "procedure_lookup",
    expectedTerms: ["production readiness", "manifest"],
    minimumEvidence: 1,
    termScope: "answer"
  },
  {
    id: "fixture_memory_search_metadata",
    namespaceKind: "fixture",
    query: "what does the plan say about memory.search response metadata?",
    expectedDomain: "document_knowledge",
    expectedContract: "document_lookup",
    expectedTerms: ["querycontract", "retrievaldomain", "answershape", "finalclaimsource", "blockedfallbacks", "reviewunknown"],
    minimumEvidence: 1,
    termScope: "answer"
  },
  {
    id: "fixture_memory_search_contract_surface",
    namespaceKind: "fixture",
    query: "what does the plan say about the memory.search contract surface?",
    expectedDomain: "document_knowledge",
    expectedContract: "document_lookup",
    expectedTerms: ["querycontract", "retrievaldomain", "answershape", "finalclaimsource", "blockedfallbacks", "reviewunknown"],
    minimumEvidence: 1,
    termScope: "answer"
  },
  {
    id: "fixture_memory_search_spec_return_shape",
    namespaceKind: "fixture",
    query: "what does the spec say memory.search has to return?",
    expectedDomain: "document_knowledge",
    expectedContract: "document_lookup",
    expectedTerms: ["querycontract", "retrievaldomain", "answershape", "finalclaimsource", "blockedfallbacks", "reviewunknown"],
    minimumEvidence: 1,
    termScope: "answer"
  },
  {
    id: "fixture_memory_search_response_fields",
    namespaceKind: "fixture",
    query: "what response fields must memory.search return?",
    expectedDomain: "document_knowledge",
    expectedContract: "document_lookup",
    expectedTerms: ["querycontract", "retrievaldomain", "answershape", "finalclaimsource", "blockedfallbacks", "reviewunknown"],
    minimumEvidence: 1,
    termScope: "answer"
  },
  {
    id: "fixture_memory_search_blocked_fallbacks",
    namespaceKind: "fixture",
    query: "what does this spec say about blocked fallbacks for memory.search?",
    expectedDomain: "document_knowledge",
    expectedContract: "document_lookup",
    expectedTerms: ["querycontract", "retrievaldomain", "answershape", "finalclaimsource", "blockedfallbacks", "reviewunknown"],
    minimumEvidence: 1,
    termScope: "answer"
  },
  {
    id: "fixture_memory_search_review_unknown",
    namespaceKind: "fixture",
    query: "what does the plan say about reviewUnknown in memory.search?",
    expectedDomain: "document_knowledge",
    expectedContract: "document_lookup",
    expectedTerms: ["querycontract", "retrievaldomain", "answershape", "finalclaimsource", "blockedfallbacks", "reviewunknown"],
    minimumEvidence: 1,
    termScope: "answer"
  },
  {
    id: "fixture_memory_retrieval_project",
    namespaceKind: "fixture",
    query: "what is AI Brain?",
    expectedDomain: "project_definition",
    expectedContract: "project_definition",
    expectedTerms: ["ai brain", "memory"],
    minimumEvidence: 1,
    termScope: "answer"
  },
  {
    id: "fixture_memory_retrieval_work_context",
    namespaceKind: "fixture",
    query: "what is Two Way?",
    expectedDomain: "project_definition",
    expectedContract: "project_definition",
    expectedTerms: ["two way", "work"],
    minimumEvidence: 1,
    termScope: "answer"
  },
  {
    id: "synthetic_brew_method_now",
    namespaceKind: "synthetic",
    query: "what sort of coffee does Steve go for now?",
    expectedDomain: "project_current_state",
    expectedContract: "current_state",
    expectedTerms: ["pour-over coffee"],
    minimumEvidence: 1,
    termScope: "answer"
  },
  {
    id: "synthetic_spice_tolerance_now",
    namespaceKind: "synthetic",
    query: "what drink style does Steve prefer now?",
    expectedDomain: "project_current_state",
    expectedContract: "current_state",
    expectedTerms: ["pour-over coffee"],
    minimumEvidence: 1,
    termScope: "answer"
  },
  {
    id: "personal_brew_method_now",
    namespaceKind: "personal",
    query: "what coffee do I prefer now?",
    expectedDomain: "project_current_state",
    expectedContract: "current_state",
    expectedTerms: ["pour-over coffee"],
    minimumEvidence: 1,
    termScope: "answer"
  }
];

function namespaceForCase(testCase: SemanticLiftCase, syntheticNamespaceId: string): string {
  switch (testCase.namespaceKind) {
    case "personal":
      return "personal";
    case "synthetic":
      return syntheticNamespaceId;
    case "fixture":
      return QUERY_GOLD_FIXTURE_NAMESPACE;
  }
}

async function activateNamespace(namespaceId: string): Promise<void> {
  const scope = namespaceId.startsWith("benchmark_") ? "benchmark" : "runtime";
  await runNamespaceVectorActivation({
    namespaceId,
    scope,
    mode: "full",
    limit: 500,
    maxPasses: 8,
    processPending: true,
    reason: "semantic_query_lift_pack"
  });
}

async function runCase(testCase: SemanticLiftCase, syntheticNamespaceId: string, mode: "lexical" | "hybrid"): Promise<LiftCaseResult> {
  const namespaceId = namespaceForCase(testCase, syntheticNamespaceId);
  const startedAt = performance.now();
  const payload = await searchMemory({
    namespaceId,
    query: testCase.query,
    limit: 8
  });
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const inferred = inferQueryContract(testCase.query);
  const contract = typeof payload?.meta?.queryContractName === "string" ? payload.meta.queryContractName : inferred.contractName;
  const domain =
    typeof payload?.meta?.queryContractRetrievalDomain === "string" ? payload.meta.queryContractRetrievalDomain : inferred.retrievalDomain;
  const finalClaimSource =
    typeof payload?.meta?.finalClaimSource === "string"
      ? payload.meta.finalClaimSource
      : typeof payload?.meta?.finalRouteFamily === "string"
        ? payload.meta.finalRouteFamily
        : null;
  const evidenceCount = payloadEvidenceCount(payload);
  const answerText = answerTextFromPayload(payload);
  const matchedTerms = testCase.expectedTerms.filter((term) =>
    testCase.termScope === "payload" ? hasTerm(payload, term) : hasTerm(answerText, term)
  ).length;
  const queryTimeModelCalls = queryTimeModelCallsFromPayload(payload);
  const failures: string[] = [];
  if (contract !== testCase.expectedContract) failures.push("wrong_query_contract");
  if (domain !== testCase.expectedDomain) failures.push("wrong_retrieval_domain");
  if (evidenceCount < testCase.minimumEvidence) failures.push("insufficient_evidence");
  if (matchedTerms < testCase.expectedTerms.length) failures.push("missing_expected_terms");
  if (queryTimeModelCalls > 0) failures.push("query_time_model_calls_nonzero");

  return {
    id: testCase.id,
    query: testCase.query,
    namespaceId,
    mode,
    contract,
    domain,
    finalClaimSource,
    evidenceCount,
    matchedTerms,
    totalTerms: testCase.expectedTerms.length,
    latencyMs,
    passed: failures.length === 0,
    queryTimeModelCalls,
    vectorContribution: typeof payload?.meta?.vectorContribution === "string" ? payload.meta.vectorContribution : null,
    answerText,
    failures
  };
}

function summarize(results: readonly LiftCaseResult[]): {
  readonly passRate: number;
  readonly termRecall: number;
  readonly p95LatencyMs: number;
  readonly vectorContributionRate: number;
} {
  const totalTerms = results.reduce((sum, result) => sum + result.totalTerms, 0);
  const matchedTerms = results.reduce((sum, result) => sum + result.matchedTerms, 0);
  return {
    passRate: rate(results.filter((result) => result.passed).length, results.length),
    termRecall: totalTerms <= 0 ? 0 : Number((matchedTerms / totalTerms).toFixed(4)),
    p95LatencyMs: percentile(results.map((result) => result.latencyMs), 95),
    vectorContributionRate: rate(results.filter((result) => result.vectorContribution !== null && result.vectorContribution !== "none").length, results.length)
  };
}

export async function runSemanticQueryLiftPackBenchmark(): Promise<SemanticQueryLiftPackReport> {
  await runMigrations();
  const projectionFlags = projectionRuntimeFlags();
  const vectorFlags = vectorRuntimeFlags();
  applyProjectionRuntimeFlags();
  try {
    const synthetic = await runHumanSyntheticWatchBenchmark();
    await prepareQueryTaxonomyGoldFixtureForHybrid();
    await rebuildContractProjectionsNamespace(QUERY_GOLD_FIXTURE_NAMESPACE);
    await Promise.all([
      activateNamespace("personal"),
      activateNamespace(QUERY_GOLD_FIXTURE_NAMESPACE),
      activateNamespace(synthetic.namespaceId)
    ]);

    applyVectorRuntimeFlags({ runtimeMode: "off", benchmarkMode: "off" });
    const lexicalResults: LiftCaseResult[] = [];
    for (const testCase of SEMANTIC_LIFT_CASES) {
      lexicalResults.push(await runCase(testCase, synthetic.namespaceId, "lexical"));
    }

    applyVectorRuntimeFlags({ runtimeMode: "bounded", benchmarkMode: "bounded" });
    const hybridResults: LiftCaseResult[] = [];
    for (const testCase of SEMANTIC_LIFT_CASES) {
      hybridResults.push(await runCase(testCase, synthetic.namespaceId, "hybrid"));
    }

    const lexical = summarize(lexicalResults);
    const hybrid = summarize(hybridResults);
    const failures: string[] = [];
    const hybridEvidenceZero = hybridResults.filter((result) => result.evidenceCount === 0).length;
    const hybridQueryTimeCalls = hybridResults.reduce((sum, result) => sum + result.queryTimeModelCalls, 0);
    const hybridHardFailures = hybridResults.flatMap((result) => result.failures.map((failure) => `${result.id}:${failure}`));
    if (hybridEvidenceZero > 0) failures.push("hybrid_supported_evidence_zero_present");
    if (hybridQueryTimeCalls > 0) failures.push("hybrid_query_time_model_calls_nonzero");
    if (hybridHardFailures.length > 0) failures.push(...hybridHardFailures);
    const passRateDelta = Number((hybrid.passRate - lexical.passRate).toFixed(4));
    const termRecallDelta = Number((hybrid.termRecall - lexical.termRecall).toFixed(4));
    if (passRateDelta < 0 && hybrid.passRate < lexical.passRate) failures.push("hybrid_pass_rate_regressed");
    if (termRecallDelta < 0 && hybrid.termRecall < lexical.termRecall) failures.push("hybrid_term_recall_regressed");
    if (passRateDelta < 0.1 && termRecallDelta < 0.15) failures.push("semantic_lift_below_gate");

    return {
      generatedAt: new Date().toISOString(),
      benchmark: "semantic_query_lift_pack",
      passed: failures.length === 0,
      namespaces: {
        personal: "personal",
        synthetic: synthetic.namespaceId,
        fixture: QUERY_GOLD_FIXTURE_NAMESPACE
      },
      lexical: {
        passRate: lexical.passRate,
        termRecall: lexical.termRecall,
        p95LatencyMs: lexical.p95LatencyMs
      },
      hybrid: {
        passRate: hybrid.passRate,
        termRecall: hybrid.termRecall,
        p95LatencyMs: hybrid.p95LatencyMs,
        vectorContributionRate: hybrid.vectorContributionRate
      },
      deltas: {
        passRateDelta,
        termRecallDelta
      },
      failures,
      results: [...lexicalResults, ...hybridResults]
    };
  } finally {
    restoreVectorRuntimeFlags(vectorFlags);
    restoreProjectionRuntimeFlags(projectionFlags);
  }
}

export async function runAndWriteSemanticQueryLiftPackBenchmark(): Promise<SemanticQueryLiftPackReport> {
  const report = await runSemanticQueryLiftPackBenchmark();
  const dir = benchmarkOutputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  await writeFile(path.join(dir, `semantic-query-lift-pack-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    path.join(dir, `semantic-query-lift-pack-${stamp}.md`),
    [
      "# Semantic Query Lift Pack",
      "",
      `- passed: ${report.passed}`,
      `- lexical passRate: ${report.lexical.passRate}`,
      `- hybrid passRate: ${report.hybrid.passRate}`,
      `- lexical termRecall: ${report.lexical.termRecall}`,
      `- hybrid termRecall: ${report.hybrid.termRecall}`,
      `- passRateDelta: ${report.deltas.passRateDelta}`,
      `- termRecallDelta: ${report.deltas.termRecallDelta}`,
      `- hybrid vectorContributionRate: ${report.hybrid.vectorContributionRate}`,
      `- failures: ${report.failures.length === 0 ? "none" : report.failures.join(", ")}`
    ].join("\n") + "\n"
  );
  await closePool();
  if (!report.passed) {
    throw new Error(`semantic-query-lift-pack failed: ${report.failures.join(", ")}`);
  }
  return report;
}

export async function runSemanticQueryLiftPackCli(): Promise<void> {
  const report = await runAndWriteSemanticQueryLiftPackBenchmark();
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        lexical: report.lexical,
        hybrid: report.hybrid,
        deltas: report.deltas
      },
      null,
      2
    )
  );
}
