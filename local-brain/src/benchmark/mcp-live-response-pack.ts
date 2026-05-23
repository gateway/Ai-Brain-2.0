import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { closePool } from "../db/client.js";
import { rebuildContractProjectionsNamespace } from "../contract-projections/service.js";
import { executeMcpTool } from "../mcp/server.js";
import { presentHumanReadableQueryResult } from "../mcp/query-presenter.js";
import { LIVE_PERSONAL_QUERY_CASES } from "./live-personal-query-fixtures.js";
import { applyProjectionRuntimeFlags, benchmarkOutputDir, payloadEvidenceItems, projectionRuntimeFlags, restoreProjectionRuntimeFlags } from "./query-benchmark-utils.js";

interface ResponsePackRow {
  readonly label: string;
  readonly query: string;
  readonly contract: string | null;
  readonly domain: string | null;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly queryEmbeddingCacheHit: boolean;
  readonly vectorContribution: string | null;
  readonly selectionTrace: readonly string[];
  readonly renderedFull: {
    readonly answer: string;
    readonly whyThisAnswer: string;
    readonly evidenceSummary: readonly string[];
    readonly sourceTrail: readonly string[];
    readonly uncertainty: string | null;
    readonly suggestedNextQuery: string | null;
  };
  readonly renderedCompact: {
    readonly answer: string;
    readonly whyThisAnswer: string;
    readonly evidenceSummary: readonly string[];
    readonly sourceTrail: readonly string[];
    readonly uncertainty: string | null;
    readonly suggestedNextQuery: string | null;
  };
}

function selectionTraceSummary(payload: Record<string, any>): readonly string[] {
  const trace = Array.isArray(payload?.selectionTrace) ? payload.selectionTrace : [];
  return trace
    .map((item: any) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const stage = typeof item.stage === "string" ? item.stage : null;
      const decision = typeof item.decision === "string" ? item.decision : null;
      const sections = Array.isArray(item.selectedSections)
        ? item.selectedSections.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      if (!stage || !decision) {
        return null;
      }
      return sections.length > 0 ? `${stage}:${decision} (${sections.join(", ")})` : `${stage}:${decision}`;
    })
    .filter((value: string | null): value is string => typeof value === "string" && value.length > 0);
}

export interface McpLiveResponsePackReport {
  readonly generatedAt: string;
  readonly benchmark: "mcp_live_response_pack";
  readonly rows: readonly ResponsePackRow[];
}

function followUpSourceAuditRow(previousQuery: string, payload: Record<string, any>): ResponsePackRow {
  const evidence = payloadEvidenceItems(payload)
    .slice(0, 3)
    .map((item: any) => String(item?.snippet ?? item?.content ?? "").replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  return {
    label: "source_audit_follow_up",
    query: "Where did that answer come from?",
    contract: "source_audit",
    domain: "source_audit",
    finalClaimSource: typeof payload?.finalClaimSource === "string" ? payload.finalClaimSource : null,
    evidenceCount: evidence.length,
    queryEmbeddingCacheHit: payload?.queryEmbeddingCacheHit === true,
    vectorContribution: typeof payload?.vectorContribution === "string" ? payload.vectorContribution : null,
    selectionTrace: selectionTraceSummary(payload),
    renderedFull: {
      answer:
        evidence.length > 0
          ? `That answer came from the prior ${payload?.queryContract ?? "memory"} result for "${previousQuery}", backed by the returned evidence.`
          : "The prior answer did not include authoritative evidence.",
      whyThisAnswer:
        evidence.length > 0
          ? `The skill used the previous MCP payload and its evidence instead of guessing from free text.`
          : "The skill could not produce provenance because the prior payload was not source-backed.",
      evidenceSummary: evidence,
      sourceTrail: [],
      uncertainty: evidence.length > 0 ? null : "No authoritative evidence was available in the prior answer.",
      suggestedNextQuery: evidence.length > 0 ? "Ask for the direct fact again if you want the current value rather than the provenance." : "Ask the original question in a more specific way."
    },
    renderedCompact: {
      answer: evidence.length > 0 ? "That answer came from the prior grounded result." : "The prior answer was not source-backed.",
      whyThisAnswer:
        evidence.length > 0
          ? "The skill reused the prior MCP evidence instead of guessing."
          : "No grounded provenance was available for the prior answer.",
      evidenceSummary: evidence.slice(0, 1),
      sourceTrail: [],
      uncertainty: evidence.length > 0 ? null : "No authoritative evidence was available in the prior answer.",
      suggestedNextQuery: evidence.length > 0 ? "Ask for the direct fact again for the current value." : "Ask the original question in a more specific way."
    }
  };
}

function markdown(report: McpLiveResponsePackReport): string {
  const lines = ["# MCP Live Response Pack", ""];
  for (const row of report.rows) {
    lines.push(`## ${row.label}`);
    lines.push(`- query: ${row.query}`);
    lines.push(`- contract: ${row.contract ?? "n/a"}`);
    lines.push(`- domain: ${row.domain ?? "n/a"}`);
    lines.push(`- finalClaimSource: ${row.finalClaimSource ?? "n/a"}`);
    lines.push(`- evidenceCount: ${row.evidenceCount}`);
    lines.push(`- queryEmbeddingCacheHit: ${row.queryEmbeddingCacheHit}`);
    lines.push(`- vectorContribution: ${row.vectorContribution ?? "n/a"}`);
    if (row.selectionTrace.length > 0) {
      lines.push(`- Selection trace: ${row.selectionTrace.join(" | ")}`);
    }
    lines.push(`- Full answer: ${row.renderedFull.answer || "(empty)"}`);
    lines.push(`- Full why: ${row.renderedFull.whyThisAnswer}`);
    if (row.renderedFull.evidenceSummary.length > 0) {
      lines.push(`- Full evidence summary: ${row.renderedFull.evidenceSummary.join(" | ")}`);
    }
    if (row.renderedFull.sourceTrail.length > 0) {
      lines.push(`- Full source trail: ${row.renderedFull.sourceTrail.join(" | ")}`);
    }
    if (row.renderedFull.uncertainty) {
      lines.push(`- Full uncertainty: ${row.renderedFull.uncertainty}`);
    }
    if (row.renderedFull.suggestedNextQuery) {
      lines.push(`- Full suggested next query: ${row.renderedFull.suggestedNextQuery}`);
    }
    lines.push(`- Compact answer: ${row.renderedCompact.answer || "(empty)"}`);
    if (row.renderedCompact.sourceTrail.length > 0) {
      lines.push(`- Compact source trail: ${row.renderedCompact.sourceTrail.join(" | ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function runMcpLiveResponsePackBenchmark(): Promise<McpLiveResponsePackReport> {
  const previousFlags = projectionRuntimeFlags();
  applyProjectionRuntimeFlags();
  try {
    await rebuildContractProjectionsNamespace("personal");
    const rows: ResponsePackRow[] = [];
    let priorQuery: string | null = null;
    let priorPayload: Record<string, any> | null = null;
    for (const testCase of LIVE_PERSONAL_QUERY_CASES) {
      const wrapped = (await executeMcpTool(testCase.toolName, {
        namespace_id: "personal",
        query: testCase.query,
        limit: 8,
        detail_mode: "full"
      })) as { readonly structuredContent?: any };
      const compactWrapped = (await executeMcpTool(testCase.toolName, {
        namespace_id: "personal",
        query: testCase.query,
        limit: 8,
        detail_mode: "compact"
      })) as { readonly structuredContent?: any };
      const payload = (wrapped.structuredContent ?? {}) as Record<string, any>;
      const compactPayload = (compactWrapped.structuredContent ?? {}) as Record<string, any>;
      rows.push({
        label: testCase.id,
        query: testCase.query,
        contract: typeof payload?.queryContract === "string" ? payload.queryContract : null,
        domain: typeof payload?.retrievalDomain === "string" ? payload.retrievalDomain : null,
        finalClaimSource: typeof payload?.finalClaimSource === "string" ? payload.finalClaimSource : null,
        evidenceCount: Array.isArray(payloadEvidenceItems(payload)) ? payloadEvidenceItems(payload).length : 0,
        queryEmbeddingCacheHit: payload?.queryEmbeddingCacheHit === true,
        vectorContribution: typeof payload?.vectorContribution === "string" ? payload.vectorContribution : null,
        selectionTrace: selectionTraceSummary(payload),
        renderedFull:
          payload?.humanReadable && typeof payload.humanReadable === "object"
            ? (payload.humanReadable as ResponsePackRow["renderedFull"])
            : presentHumanReadableQueryResult({ query: testCase.query, payload, detailMode: "full" }),
        renderedCompact:
          compactPayload?.humanReadable && typeof compactPayload.humanReadable === "object"
            ? (compactPayload.humanReadable as ResponsePackRow["renderedCompact"])
            : presentHumanReadableQueryResult({ query: testCase.query, payload, detailMode: "compact" })
      });
      priorQuery = testCase.query;
      priorPayload = payload;
      if (testCase.id === "preference_profile" && priorQuery && priorPayload) {
        rows.push(followUpSourceAuditRow(priorQuery, priorPayload));
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      benchmark: "mcp_live_response_pack",
      rows
    };
  } finally {
    restoreProjectionRuntimeFlags(previousFlags);
  }
}

export async function runAndWriteMcpLiveResponsePackBenchmark(): Promise<McpLiveResponsePackReport> {
  const report = await runMcpLiveResponsePackBenchmark();
  const dir = benchmarkOutputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  await writeFile(path.join(dir, `mcp-live-response-pack-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(dir, `mcp-live-response-pack-${stamp}.md`), `${markdown(report)}\n`);
  await closePool();
  return report;
}

export async function runMcpLiveResponsePackCli(): Promise<void> {
  const report = await runAndWriteMcpLiveResponsePackBenchmark();
  console.log(JSON.stringify({ rowCount: report.rows.length }, null, 2));
}
