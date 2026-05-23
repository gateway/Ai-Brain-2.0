import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rebuildContractProjectionsNamespace } from "../contract-projections/service.js";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import {
  QUERY_GOLD_FIXTURE_NAMESPACE,
  seedQueryTaxonomyGoldFixture
} from "./query-taxonomy-gold-fixtures.js";
import { runHumanSyntheticWatchBenchmark } from "./human-synthetic-watch.js";

interface ResponsePackRow {
  readonly label: string;
  readonly namespaceId: string;
  readonly toolName: string;
  readonly query: string;
  readonly queryContract: string | null;
  readonly retrievalDomain: string | null;
  readonly answerShape: string | null;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly answer: string;
  readonly evidenceSummary: readonly string[];
}

export interface QueryResponsePackReport {
  readonly generatedAt: string;
  readonly benchmark: "query_response_pack";
  readonly rows: readonly ResponsePackRow[];
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

async function loadPinnedSyntheticNamespaceId(): Promise<string | null> {
  const files = (await readdir(outputDir()))
    .filter((file) => /^human-synthetic-watch-\d{4}-\d{2}-\d{2}T.*\.json$/u.test(file))
    .sort();
  const latest = files.at(-1);
  if (!latest) {
    return null;
  }
  try {
    const report = JSON.parse(await readFile(path.join(outputDir(), latest), "utf8")) as { readonly namespaceId?: unknown };
    return typeof report.namespaceId === "string" && report.namespaceId.trim() ? report.namespaceId.trim() : null;
  } catch {
    return null;
  }
}

function payloadEvidence(payload: any): readonly any[] {
  if (Array.isArray(payload?.duality?.evidence)) return payload.duality.evidence;
  if (Array.isArray(payload?.evidence)) return payload.evidence;
  return [];
}

function answerFromPayload(payload: any): string {
  if (typeof payload?.duality?.claim?.text === "string") return payload.duality.claim.text;
  if (typeof payload?.summaryText === "string") return payload.summaryText;
  if (Array.isArray(payload?.tasks)) {
    return payload.tasks
      .map((task: any) => (typeof task?.title === "string" ? task.title : typeof task?.text === "string" ? task.text : ""))
      .filter(Boolean)
      .join("; ");
  }
  return "";
}

function runtimeFlags(): Record<string, string | undefined> {
  return {
    BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION: process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION,
    BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION: process.env.BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION,
    BRAIN_ENABLE_SHARED_SOCIAL_GRAPH: process.env.BRAIN_ENABLE_SHARED_SOCIAL_GRAPH,
    BRAIN_ENABLE_ALIAS_CURRENT_STATE_PROJECTION: process.env.BRAIN_ENABLE_ALIAS_CURRENT_STATE_PROJECTION,
    BRAIN_ENABLE_CONTINUITY_CURRENT_STATE_PROJECTION: process.env.BRAIN_ENABLE_CONTINUITY_CURRENT_STATE_PROJECTION,
    BRAIN_ENABLE_RECAP_PROFILE_PROJECTION: process.env.BRAIN_ENABLE_RECAP_PROFILE_PROJECTION
  };
}

function applyRuntimeFlags(): void {
  process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION = "1";
  process.env.BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION = "1";
  process.env.BRAIN_ENABLE_SHARED_SOCIAL_GRAPH = "1";
  process.env.BRAIN_ENABLE_ALIAS_CURRENT_STATE_PROJECTION = "1";
  process.env.BRAIN_ENABLE_CONTINUITY_CURRENT_STATE_PROJECTION = "1";
  process.env.BRAIN_ENABLE_RECAP_PROFILE_PROJECTION = "1";
}

function restoreRuntimeFlags(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export async function runQueryResponsePackBenchmark(): Promise<QueryResponsePackReport> {
  const previousFlags = runtimeFlags();
  applyRuntimeFlags();
  try {
    const syntheticNamespaceId =
      process.env.BRAIN_QUERY_RESPONSE_PACK_REFRESH_SYNTHETIC === "1"
        ? (await runHumanSyntheticWatchBenchmark()).namespaceId
        : ((await loadPinnedSyntheticNamespaceId()) ?? (await runHumanSyntheticWatchBenchmark()).namespaceId);
    await seedQueryTaxonomyGoldFixture();
    await rebuildContractProjectionsNamespace(QUERY_GOLD_FIXTURE_NAMESPACE);
    const rows: readonly {
      readonly label: string;
      readonly namespaceId: string;
      readonly toolName: "memory.search" | "memory.extract_tasks";
      readonly query: string;
    }[] = [
      { label: "relationship_chronology", namespaceId: "personal", toolName: "memory.search", query: "what happened between Lauren and me?" },
      { label: "relationship_map", namespaceId: "personal", toolName: "memory.search", query: "Who is Lauren to me?" },
      { label: "entity_dossier_person", namespaceId: "personal", toolName: "memory.search", query: "Tell me everything about Lauren." },
      {
        label: "shared_social_graph_fixture",
        namespaceId: QUERY_GOLD_FIXTURE_NAMESPACE,
        toolName: "memory.search",
        query: "Who are all of mine and Dan's friends?"
      },
      {
        label: "shared_social_graph_personal_gap",
        namespaceId: "personal",
        toolName: "memory.search",
        query: "Who are all of mine and Dan's friends?"
      },
      { label: "current_state", namespaceId: syntheticNamespaceId, toolName: "memory.search", query: "what does Steve prefer now for coffee?" },
      { label: "task_ops", namespaceId: QUERY_GOLD_FIXTURE_NAMESPACE, toolName: "memory.extract_tasks", query: "what do I need to do?" },
      { label: "temporal_history", namespaceId: syntheticNamespaceId, toolName: "memory.search", query: "when did Lauren leave for the US?" },
      { label: "list_collection", namespaceId: "personal", toolName: "memory.search", query: "who are Steve's friends?" },
      { label: "work_history_report", namespaceId: "personal", toolName: "memory.search", query: "What have I done in my career?" },
      {
        label: "work_history_subject_bound",
        namespaceId: "personal",
        toolName: "memory.search",
        query: "What things did I do with id Software and John Carmack?"
      },
      { label: "project_definition", namespaceId: QUERY_GOLD_FIXTURE_NAMESPACE, toolName: "memory.search", query: "What is AI Brain?" },
      { label: "project_definition_broad", namespaceId: QUERY_GOLD_FIXTURE_NAMESPACE, toolName: "memory.search", query: "Tell me everything about AI Brain." },
      { label: "document_lookup", namespaceId: QUERY_GOLD_FIXTURE_NAMESPACE, toolName: "memory.search", query: "how do I run production readiness?" },
      { label: "source_audit", namespaceId: syntheticNamespaceId, toolName: "memory.search", query: "why does the brain think Steve prefers pour-over coffee now?" },
      { label: "abstention", namespaceId: "personal", toolName: "memory.search", query: "what happened between me and them?" },
      { label: "review_unknown", namespaceId: QUERY_GOLD_FIXTURE_NAMESPACE, toolName: "memory.search", query: "classify this uncategorized memory question" }
    ];
    const rendered: ResponsePackRow[] = [];
    for (const row of rows) {
      const wrapped = (await executeMcpTool(row.toolName, {
        namespace_id: row.namespaceId,
        query: row.query,
        limit: 8
      })) as { readonly structuredContent?: any };
      const payload = wrapped.structuredContent ?? {};
      rendered.push({
        label: row.label,
        namespaceId: row.namespaceId,
        toolName: row.toolName,
        query: row.query,
        queryContract: typeof payload?.queryContract === "string" ? payload.queryContract : null,
        retrievalDomain: typeof payload?.retrievalDomain === "string" ? payload.retrievalDomain : null,
        answerShape: typeof payload?.answerShape === "string" ? payload.answerShape : null,
        finalClaimSource:
          typeof payload?.finalClaimSource === "string"
            ? payload.finalClaimSource
            : typeof payload?.meta?.finalClaimSource === "string"
              ? payload.meta.finalClaimSource
              : null,
        evidenceCount: Array.isArray(payloadEvidence(payload)) ? payloadEvidence(payload).length : 0,
        answer: answerFromPayload(payload),
        evidenceSummary: payloadEvidence(payload)
          .slice(0, 3)
          .map((item: any) => String(item?.snippet ?? item?.content ?? "").replace(/\s+/gu, " ").trim())
          .filter(Boolean)
      });
    }
    return {
      generatedAt: new Date().toISOString(),
      benchmark: "query_response_pack",
      rows: rendered
    };
  } finally {
    restoreRuntimeFlags(previousFlags);
  }
}

function markdown(report: QueryResponsePackReport): string {
  const lines = ["# Query Response Pack", ""];
  for (const row of report.rows) {
    lines.push(`## ${row.label}`);
    lines.push(`- query: ${row.query}`);
    lines.push(`- contract: ${row.queryContract ?? "n/a"}`);
    lines.push(`- domain: ${row.retrievalDomain ?? "n/a"}`);
    lines.push(`- answerShape: ${row.answerShape ?? "n/a"}`);
    lines.push(`- finalClaimSource: ${row.finalClaimSource ?? "n/a"}`);
    lines.push(`- evidenceCount: ${row.evidenceCount}`);
    lines.push(`- answer: ${row.answer || "(empty)"}`);
    if (row.evidenceSummary.length > 0) {
      lines.push(`- evidenceSummary: ${row.evidenceSummary.join(" | ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function runAndWriteQueryResponsePackBenchmark(): Promise<QueryResponsePackReport> {
  const report = await runQueryResponsePackBenchmark();
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  await writeFile(path.join(dir, `query-response-pack-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(dir, `query-response-pack-${stamp}.md`), `${markdown(report)}\n`);
  await closePool();
  return report;
}

export async function runQueryResponsePackCli(): Promise<void> {
  const report = await runAndWriteQueryResponsePackBenchmark();
  console.log(JSON.stringify({ rowCount: report.rows.length }, null, 2));
}
