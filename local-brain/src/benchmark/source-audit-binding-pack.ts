import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { payloadEvidenceCount, queryTimeModelCallsFromPayload } from "./query-benchmark-utils.js";

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function hasTerm(payload: any, term: string): boolean {
  return JSON.stringify(payload).toLowerCase().includes(term.toLowerCase());
}

function effectiveEvidenceCount(payload: any): number {
  const topLevel = typeof payload?.evidenceCount === "number" && Number.isFinite(payload.evidenceCount) ? payload.evidenceCount : 0;
  return Math.max(topLevel, payloadEvidenceCount(payload));
}

export async function runAndWriteSourceAuditBindingPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const startedAt = performance.now();
  const explicitWrapped = (await executeMcpTool("memory.search", {
    namespace_id: "personal",
    query: "Show the sources for my Chiang Mai friends answer: Dan, Gummi, Tim, and Ben.",
    limit: 8,
    detailMode: "compact"
  })) as { readonly structuredContent?: any };
  const payload = explicitWrapped.structuredContent ?? {};
  const expectedTerms = ["Dan", "Gummi", "Tim", "Ben", "Chiang Mai"];
  const missingTerms = expectedTerms.filter((term) => !hasTerm(payload, term));
  const wrongFamily = payload.queryContract !== "source_audit" || payload.finalClaimSource !== "source_audit";
  const wrongSourceTopic = hasTerm(payload, "Groove") || hasTerm(payload, "red carpet") || hasTerm(payload, "movie");
  const claimAuditCoverageRate = Array.isArray(payload.claimAudit) && payload.claimAudit.length > 0 ? 1 : 0;
  const row = {
    query: "Show the sources for my Chiang Mai friends answer: Dan, Gummi, Tim, and Ben.",
    finalClaimSource: payload.finalClaimSource ?? null,
    evidenceCount: effectiveEvidenceCount(payload),
    sourceTrailCount: Array.isArray(payload.sourceTrail) ? payload.sourceTrail.length : 0,
    claimAuditCount: Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0,
    missingTerms,
    wrongFamily,
    wrongSourceTopic,
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    passed: missingTerms.length === 0 && !wrongFamily && !wrongSourceTopic && effectiveEvidenceCount(payload) > 0 && queryTimeModelCallsFromPayload(payload) === 0
  };
  const sessionId = `source-audit-binding-${Date.now()}`;
  const priorWrapped = (await executeMcpTool("memory.search", {
    namespace_id: "personal",
    session_id: sessionId,
    query: "Who are my friends in Chiang Mai?",
    limit: 8,
    detail_mode: "compact"
  })) as { readonly structuredContent?: any };
  const priorPayload = priorWrapped.structuredContent ?? {};
  const followupWrapped = (await executeMcpTool("memory.search", {
    namespace_id: "personal",
    session_id: sessionId,
    query: "Where did that answer come from?",
    limit: 8,
    detail_mode: "compact"
  })) as { readonly structuredContent?: any };
  const followupPayload = followupWrapped.structuredContent ?? {};
  const sessionFollowupRow = {
    query: "Who are my friends in Chiang Mai? -> Where did that answer come from?",
    finalClaimSource: followupPayload.finalClaimSource ?? null,
    evidenceCount: effectiveEvidenceCount(followupPayload),
    sourceTrailCount: Array.isArray(followupPayload.sourceTrail) ? followupPayload.sourceTrail.length : 0,
    claimAuditCount: Array.isArray(followupPayload.claimAudit) ? followupPayload.claimAudit.length : 0,
    missingTerms: ["Chiang Mai"].filter((term) => !hasTerm(followupPayload, term)),
    wrongFamily: followupPayload.queryContract !== "source_audit" || followupPayload.finalClaimSource !== "source_audit",
    wrongSourceTopic: false,
    queryTimeModelCalls: queryTimeModelCallsFromPayload(priorPayload) + queryTimeModelCallsFromPayload(followupPayload),
    latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    sessionBound: followupPayload.sessionClaimRegistry?.priorClaimCount > 0,
    passed:
      followupPayload.queryContract === "source_audit" &&
      followupPayload.finalClaimSource === "source_audit" &&
      effectiveEvidenceCount(followupPayload) > 0 &&
      Array.isArray(followupPayload.claimAudit) &&
      followupPayload.claimAudit.length > 0 &&
      followupPayload.sessionClaimRegistry?.priorClaimCount > 0 &&
      queryTimeModelCallsFromPayload(priorPayload) + queryTimeModelCallsFromPayload(followupPayload) === 0
  };
  const standaloneWrapped = (await executeMcpTool("memory.search", {
    namespace_id: "personal",
    query: "Where did that answer come from?",
    limit: 8,
    detail_mode: "compact"
  })) as { readonly structuredContent?: any };
  const standalonePayload = standaloneWrapped.structuredContent ?? {};
  const standaloneRow = {
    query: "Where did that answer come from?",
    finalClaimSource: standalonePayload.finalClaimSource ?? null,
    evidenceCount: effectiveEvidenceCount(standalonePayload),
    sourceTrailCount: Array.isArray(standalonePayload.sourceTrail) ? standalonePayload.sourceTrail.length : 0,
    claimAuditCount: Array.isArray(standalonePayload.claimAudit) ? standalonePayload.claimAudit.length : 0,
    missingTerms: [],
    wrongFamily: standalonePayload.queryContract !== "source_audit",
    wrongSourceTopic: hasTerm(standalonePayload, "Groove") || hasTerm(standalonePayload, "red carpet") || hasTerm(standalonePayload, "movie"),
    queryTimeModelCalls: queryTimeModelCallsFromPayload(standalonePayload),
    latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    sessionBound: false,
    passed:
      standalonePayload.queryContract === "source_audit" &&
      Boolean(standalonePayload.abstentionReason) &&
      effectiveEvidenceCount(standalonePayload) === 0 &&
      queryTimeModelCallsFromPayload(standalonePayload) === 0
  };
  const generatedAt = new Date().toISOString();
  const rows = [row, sessionFollowupRow, standaloneRow];
  const report = {
    generatedAt,
    benchmark: "source_audit_binding_pack",
    passed: rows.every((result) => result.passed),
    metrics: {
      wrongFamilyCount: rows.filter((result) => result.wrongFamily).length,
      wrongSourceTopicCount: rows.filter((result) => result.wrongSourceTopic).length,
      sourceAuditFollowupMissCount: sessionFollowupRow.passed ? 0 : 1,
      standaloneSourceMissingCorrectCount: standaloneRow.passed ? 1 : 0,
      claimAuditCoverageRate: rows.filter((result) => result.claimAuditCount > 0 || result.query === "Where did that answer come from?").length / rows.length,
      queryTimeModelCalls: rows.reduce((sum, result) => sum + result.queryTimeModelCalls, 0)
    },
    results: rows
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `source-audit-binding-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `source-audit-binding-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `# Source Audit Binding Pack\n\n- passed: ${report.passed}\n- wrongFamilyCount: ${report.metrics.wrongFamilyCount}\n- wrongSourceTopicCount: ${report.metrics.wrongSourceTopicCount}\n- sourceAuditFollowupMissCount: ${report.metrics.sourceAuditFollowupMissCount}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runSourceAuditBindingPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteSourceAuditBindingPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
