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

function includesPayloadTerm(payload: any, term: string): boolean {
  return JSON.stringify(payload).toLowerCase().includes(term.toLowerCase());
}

export async function runAndWriteMultiEntitySynthesisPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const startedAt = performance.now();
  const query = "What do I know about Gummi, Two Way, and the Istanbul trip?";
  const wrapped = (await executeMcpTool("memory.search", { namespace_id: "personal", query, limit: 8, detailMode: "compact" })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const sections = Array.isArray(payload.answerSections) ? payload.answerSections : [];
  const expectedTerms = ["Gummi", "Two Way", "Istanbul"];
  const missingTerms = expectedTerms.filter((term) => !includesPayloadTerm(payload, term));
  const sectionIds = sections.map((section: any) => String(section?.id ?? ""));
  const missingSections = ["person", "project_org", "travel_event"].filter((id) => !sectionIds.includes(id));
  const row = {
    query,
    finalClaimSource: payload.finalClaimSource ?? null,
    evidenceCount: payloadEvidenceCount(payload),
    sourceTrailCount: Array.isArray(payload.sourceTrail) ? payload.sourceTrail.length : 0,
    claimAuditCount: Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0,
    sectionCount: sections.length,
    missingTerms,
    missingSections,
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    passed:
      payload.finalClaimSource === "source_topic_report" &&
      payloadEvidenceCount(payload) > 0 &&
      missingTerms.length === 0 &&
      missingSections.length === 0 &&
      queryTimeModelCallsFromPayload(payload) === 0
  };
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    benchmark: "multi_entity_synthesis_pack",
    passed: row.passed,
    metrics: {
      missingTermCount: missingTerms.length,
      missingSectionCount: missingSections.length,
      supportedEmptySourceTrailCount: row.evidenceCount > 0 && row.sourceTrailCount === 0 ? 1 : 0,
      queryTimeModelCalls: row.queryTimeModelCalls
    },
    results: [row]
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `multi-entity-synthesis-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `multi-entity-synthesis-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `# Multi Entity Synthesis Pack\n\n- passed: ${report.passed}\n- missingTermCount: ${missingTerms.length}\n- missingSectionCount: ${missingSections.length}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runMultiEntitySynthesisPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteMultiEntitySynthesisPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
