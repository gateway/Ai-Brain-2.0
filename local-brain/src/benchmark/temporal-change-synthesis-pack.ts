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

export async function runAndWriteTemporalChangeSynthesisPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const query = "What changed about my July and September travel plans?";
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool("memory.extract_calendar", { namespace_id: "personal", query, limit: 8, detailMode: "compact" })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const expectedTerms = ["mid-to-late July", "US", "Iceland"];
  const missingTerms = expectedTerms.filter((term) => !hasTerm(payload, term));
  const row = {
    query,
    finalClaimSource: payload.finalClaimSource ?? null,
    evidenceCount: payloadEvidenceCount(payload),
    sourceTrailCount: Array.isArray(payload.sourceTrail) ? payload.sourceTrail.length : 0,
    claimAuditCount: Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0,
    missingTerms,
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    passed: missingTerms.length === 0 && payloadEvidenceCount(payload) > 0 && queryTimeModelCallsFromPayload(payload) === 0
  };
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    benchmark: "temporal_change_synthesis_pack",
    passed: row.passed,
    metrics: {
      missingTermCount: missingTerms.length,
      supportedEmptySourceTrailCount: row.evidenceCount > 0 && row.sourceTrailCount === 0 ? 1 : 0,
      queryTimeModelCalls: row.queryTimeModelCalls
    },
    results: [row]
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `temporal-change-synthesis-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `temporal-change-synthesis-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `# Temporal Change Synthesis Pack\n\n- passed: ${report.passed}\n- missingTermCount: ${missingTerms.length}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runTemporalChangeSynthesisPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteTemporalChangeSynthesisPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
