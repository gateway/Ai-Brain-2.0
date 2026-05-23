import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { executeMcpTool } from "../mcp/server.js";
import { queryTimeModelCallsFromPayload } from "./query-benchmark-utils.js";

type ToolName = "memory.search" | "memory.extract_tasks" | "memory.extract_calendar";

interface Scenario {
  readonly id: string;
  readonly toolName: ToolName;
  readonly query: string;
  readonly forbiddenTerms: readonly string[];
  readonly expectedUnsupported: boolean;
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function visibleAnswerSurface(payload: any): string {
  return JSON.stringify({
    answer: payload?.answer ?? null,
    claim: payload?.duality?.claim?.text ?? null,
    tasks: payload?.tasks ?? null,
    commitments: payload?.commitments ?? null,
    answerSections: payload?.answerSections ?? null,
    humanReadable: payload?.humanReadable ?? null
  });
}

function hasTerm(payload: unknown, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "iu").test(String(payload ?? ""));
}

function evidenceCount(payload: any): number {
  return typeof payload?.evidenceCount === "number" && Number.isFinite(payload.evidenceCount) ? payload.evidenceCount : 0;
}

function sourceTrailCount(payload: any): number {
  return Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0;
}

function itemCount(payload: any, toolName: ToolName): number {
  if (toolName === "memory.extract_tasks") return Array.isArray(payload?.tasks) ? payload.tasks.length : 0;
  if (toolName === "memory.extract_calendar") return Array.isArray(payload?.commitments) ? payload.commitments.length : 0;
  return 0;
}

function isUnsupported(payload: any, toolName: ToolName): boolean {
  if (toolName === "memory.extract_tasks" || toolName === "memory.extract_calendar") {
    return itemCount(payload, toolName) === 0;
  }
  return payload?.finalClaimSource === "abstention" || payload?.finalClaimSource === "review_unknown" || evidenceCount(payload) === 0;
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: "false_place_friend_set_berlin",
    toolName: "memory.search",
    query: "Who are my friends in Berlin from Dan?",
    forbiddenTerms: ["Gummi", "Tim", "Ben", "Chiang Mai"],
    expectedUnsupported: true
  },
  {
    id: "false_place_introduction_berlin",
    toolName: "memory.search",
    query: "Who did Dan introduce me to in Berlin?",
    forbiddenTerms: ["Gummi", "Tim", "Ben", "Chiang Mai"],
    expectedUnsupported: true
  },
  {
    id: "false_future_travel_window",
    toolName: "memory.extract_calendar",
    query: "What trips did I mention for February 2035?",
    forbiddenTerms: ["Burning Man", "Iceland", "mid-to-late July", "September"],
    expectedUnsupported: true
  },
  {
    id: "false_source_audit_place_target",
    toolName: "memory.search",
    query: "Show sources for the answer about my friends on Mars.",
    forbiddenTerms: ["Chiang Mai", "Gummi", "Tim", "Ben"],
    expectedUnsupported: true
  },
  {
    id: "wrong_company_career",
    toolName: "memory.search",
    query: "When did I work at a company I never mentioned?",
    forbiddenTerms: ["Two Way", "Well Inked", "id Software"],
    expectedUnsupported: true
  },
  {
    id: "false_completed_task_scope",
    toolName: "memory.extract_tasks",
    query: "What tasks did I finish yesterday from the Istanbul trip?",
    forbiddenTerms: ["Store Jeep", "driver's license", "RV"],
    expectedUnsupported: true
  }
];

export async function runAndWriteAdversarialNegativeAnswerPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const results = [];
  for (const scenario of SCENARIOS) {
    const startedAt = performance.now();
    const wrapped = (await executeMcpTool(scenario.toolName, {
      namespace_id: "personal",
      query: scenario.query,
      limit: 8,
      detail_mode: "compact"
    })) as { readonly structuredContent?: any };
    const payload = wrapped.structuredContent ?? {};
    const answerSurface = visibleAnswerSurface(payload);
    const forbiddenTermsPresent = scenario.forbiddenTerms.filter((term) => hasTerm(answerSurface, term));
    const unsupported = isUnsupported(payload, scenario.toolName);
    const queryTimeModelCalls = queryTimeModelCallsFromPayload(payload);
    results.push({
      id: scenario.id,
      toolName: scenario.toolName,
      query: scenario.query,
      finalClaimSource: payload.finalClaimSource ?? null,
      evidenceCount: evidenceCount(payload),
      sourceTrailCount: sourceTrailCount(payload),
      itemCount: itemCount(payload, scenario.toolName),
      abstentionReason: payload.abstentionReason ?? null,
      forbiddenTermsPresent,
      unsupported,
      unsupportedProse: !unsupported && scenario.expectedUnsupported,
      queryTimeModelCalls,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      passed: unsupported === scenario.expectedUnsupported && forbiddenTermsPresent.length === 0 && queryTimeModelCalls === 0
    });
  }

  const generatedAt = new Date().toISOString();
  const metrics = {
    totalRows: results.length,
    passedRows: results.filter((row) => row.passed).length,
    unsupportedProseCount: results.filter((row) => row.unsupportedProse).length,
    forbiddenTermLeakCount: results.reduce((sum, row) => sum + row.forbiddenTermsPresent.length, 0),
    sourceMissingRowsCorrectlyAbstained: results.filter((row) => row.unsupported).length / results.length,
    negativePackPassRate: results.filter((row) => row.passed).length / results.length,
    queryTimeModelCalls: results.reduce((sum, row) => sum + row.queryTimeModelCalls, 0)
  };
  const report = {
    generatedAt,
    benchmark: "adversarial_negative_answer_pack",
    passed:
      metrics.negativePackPassRate === 1 &&
      metrics.unsupportedProseCount === 0 &&
      metrics.forbiddenTermLeakCount === 0 &&
      metrics.queryTimeModelCalls === 0,
    metrics,
    results
  };

  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `adversarial-negative-answer-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `adversarial-negative-answer-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    `# Adversarial Negative Answer Pack\n\n- passed: ${report.passed}\n- negativePackPassRate: ${metrics.negativePackPassRate}\n- unsupportedProseCount: ${metrics.unsupportedProseCount}\n- forbiddenTermLeakCount: ${metrics.forbiddenTermLeakCount}\n- queryTimeModelCalls: ${metrics.queryTimeModelCalls}\n`,
    "utf8"
  );
  return { report, output: { jsonPath, markdownPath } };
}

export async function runAdversarialNegativeAnswerPackCli(): Promise<void> {
  const { report, output } = await runAndWriteAdversarialNegativeAnswerPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
}
