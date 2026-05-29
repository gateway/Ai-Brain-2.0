import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { runAndWriteMultiSourceIngestionPack } from "./multi-source-ingestion-pack.js";
import { runOmiLatestSync } from "./omi-latest-sync.js";
import { payloadEvidenceCount, queryTimeModelCallsFromPayload } from "./query-benchmark-utils.js";

type ToolName = "memory.search" | "memory.extract_tasks" | "memory.extract_calendar";

type AuditCategory =
  | "people"
  | "places"
  | "things"
  | "timeline"
  | "tasks"
  | "specs"
  | "pdfs"
  | "other_ingestion";

interface AuditSeed {
  readonly id: string;
  readonly namespaceKind: "personal" | "multi_source";
  readonly toolName: ToolName;
  readonly query: string;
  readonly categories: readonly AuditCategory[];
  readonly expectedTerms: readonly string[];
}

interface AuditRow {
  readonly id: string;
  readonly query: string;
  readonly namespaceId: string;
  readonly toolName: ToolName;
  readonly categories: readonly AuditCategory[];
  readonly expectedTerms: readonly string[];
  readonly missingTerms: readonly string[];
  readonly finalClaimSource: string | null;
  readonly queryContract: string | null;
  readonly retrievalDomain: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly answerPreview: string;
  readonly residualOwner:
    | "none"
    | "missing_expected_terms"
    | "no_evidence"
    | "empty_source_trail"
    | "missing_claim_audit"
    | "query_time_model_call"
    | "tool_error";
  readonly quality: "strong" | "weak" | "fail";
  readonly passed: boolean;
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function hasComparableTerm(payloadText: string, term: string): boolean {
  return ` ${normalizeComparable(payloadText)} `.includes(` ${normalizeComparable(term)} `);
}

function expectedTermsForPhrase(phrase: string): readonly string[] {
  const stopwords = new Set([
    "the",
    "and",
    "with",
    "from",
    "that",
    "this",
    "then",
    "they",
    "also",
    "need",
    "needs",
    "after",
    "before",
    "unit"
  ]);
  return [
    ...new Set(
      normalizeComparable(phrase)
        .split(" ")
        .filter((token) => token.length >= 4 && !stopwords.has(token))
        .slice(0, 4)
    )
  ];
}

function rawOmiPathForNormalizedPath(normalizedPath: string): string {
  if (!normalizedPath.includes("/normalized/") || !normalizedPath.endsWith(".md")) {
    throw new Error(`Could not derive raw OMI path from normalized path: ${normalizedPath}`);
  }
  return normalizedPath.replace("/normalized/", "/raw/").replace(/\.md$/u, ".json");
}

async function latestOmiTaskExpectedTerms(namespaceId = "personal"): Promise<readonly string[]> {
  const sync = await runOmiLatestSync({
    namespaceId,
    skipCompiler: true
  });
  const rawPath = rawOmiPathForNormalizedPath(sync.report.latestFile.absolutePath);
  const raw = JSON.parse(await readFile(rawPath, "utf8")) as {
    readonly structured?: {
      readonly action_items?: readonly { readonly description?: string | null }[];
    } | null;
  };
  const firstActionItem = raw.structured?.action_items?.find((item) => typeof item.description === "string" && item.description.trim().length > 0);
  return firstActionItem ? expectedTermsForPhrase(firstActionItem.description ?? "") : [];
}

function answerPreview(payload: any): string {
  const answer =
    typeof payload?.humanReadable?.answer === "string"
      ? payload.humanReadable.answer
      : typeof payload?.answer === "string"
        ? payload.answer
        : typeof payload?.summaryText === "string"
          ? payload.summaryText
          : "";
  const normalized = answer.replace(/\s+/gu, " ").trim();
  return normalized.length > 500 ? `${normalized.slice(0, 499)}…` : normalized;
}

function sourceTrailEntries(payload: any): readonly any[] {
  const topLevel = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail : [];
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks.flatMap((task: any) => (Array.isArray(task?.sourceTrail) ? task.sourceTrail : [])) : [];
  const commitments = Array.isArray(payload?.commitments)
    ? payload.commitments.flatMap((commitment: any) => (Array.isArray(commitment?.sourceTrail) ? commitment.sourceTrail : []))
    : [];
  return [...topLevel, ...tasks, ...commitments];
}

function classifyRow(params: {
  readonly missingTerms: readonly string[];
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly queryTimeModelCalls: number;
  readonly toolError: boolean;
}): Pick<AuditRow, "quality" | "residualOwner" | "passed"> {
  if (params.toolError) return { quality: "fail", residualOwner: "tool_error", passed: false };
  if (params.queryTimeModelCalls > 0) return { quality: "fail", residualOwner: "query_time_model_call", passed: false };
  if (params.evidenceCount <= 0) return { quality: "weak", residualOwner: "no_evidence", passed: false };
  if (params.sourceTrailCount <= 0) return { quality: "weak", residualOwner: "empty_source_trail", passed: false };
  if (params.claimAuditCount <= 0) return { quality: "weak", residualOwner: "missing_claim_audit", passed: false };
  if (params.missingTerms.length > 0) return { quality: "weak", residualOwner: "missing_expected_terms", passed: false };
  return { quality: "strong", residualOwner: "none", passed: true };
}

function queryVariants(query: string): readonly string[] {
  const compact = query.replace(/[?.!]+$/u, "");
  const lowerFirst = compact.charAt(0).toLowerCase() + compact.slice(1);
  return [
    query,
    `Give me the short version: ${compact}.`,
    `${compact}. Please include source-backed support.`,
    `In plain English, ${lowerFirst}?`
  ];
}

const PERSONAL_SEEDS: readonly AuditSeed[] = [
  {
    id: "people_chiang_mai_friends",
    namespaceKind: "personal",
    toolName: "memory.search",
    query: "Who are my friends in Chiang Mai?",
    categories: ["people", "places"],
    expectedTerms: ["Dan", "Gummi", "Tim", "Ben", "Chiang Mai"]
  },
  {
    id: "people_dan_intro",
    namespaceKind: "personal",
    toolName: "memory.search",
    query: "Who did Dan introduce me to in Chiang Mai?",
    categories: ["people", "places"],
    expectedTerms: ["Dan", "Gummi", "Tim", "Ben", "Chiang Mai"]
  },
  {
    id: "people_shared_social",
    namespaceKind: "personal",
    toolName: "memory.search",
    query: "Who are all of mine and Dan's friends, and do not fall back to a generic relationship map?",
    categories: ["people"],
    expectedTerms: ["Dan", "Gummi", "Tim", "Ben"]
  },
  {
    id: "people_source_audit",
    namespaceKind: "personal",
    toolName: "memory.search",
    query: "Show the sources for my Chiang Mai friends answer: Dan, Gummi, Tim, and Ben.",
    categories: ["people", "places"],
    expectedTerms: ["Dan", "Gummi", "Tim", "Ben"]
  },
  {
    id: "timeline_july_trip",
    namespaceKind: "personal",
    toolName: "memory.extract_calendar",
    query: "What trips did I mention for mid to late July?",
    categories: ["timeline", "places"],
    expectedTerms: ["July", "US"]
  },
  {
    id: "timeline_september_trip",
    namespaceKind: "personal",
    toolName: "memory.extract_calendar",
    query: "What trips did I mention for September 2026?",
    categories: ["timeline", "places"],
    expectedTerms: ["September"]
  },
  {
    id: "timeline_change",
    namespaceKind: "personal",
    toolName: "memory.extract_calendar",
    query: "What changed about my July and September travel plans?",
    categories: ["timeline"],
    expectedTerms: ["July", "September"]
  },
  {
    id: "tasks_latest_note",
    namespaceKind: "personal",
    toolName: "memory.extract_tasks",
    query: "What tasks did I mention in my most recent OMI note?",
    categories: ["tasks", "other_ingestion"],
    expectedTerms: ["releasing", "reenergize"]
  },
  {
    id: "tasks_recent_travel",
    namespaceKind: "personal",
    toolName: "memory.extract_tasks",
    query: "What tasks are still open from my recent travel planning notes?",
    categories: ["tasks", "timeline"],
    expectedTerms: ["Store Jeep", "RV", "driver"]
  },
  {
    id: "tasks_hybrid_temporal",
    namespaceKind: "personal",
    toolName: "memory.extract_tasks",
    query: "What open tasks remain from the hybrid temporal memory retrieval work?",
    categories: ["tasks", "specs"],
    expectedTerms: ["benchmark", "memory"]
  },
  {
    id: "things_active_building",
    namespaceKind: "personal",
    toolName: "memory.search",
    query: "What am I actively building now?",
    categories: ["things", "specs"],
    expectedTerms: ["AI Brain"]
  },
  {
    id: "things_two_way_work",
    namespaceKind: "personal",
    toolName: "memory.search",
    query: "What is Two Way and what work am I doing there?",
    categories: ["things", "specs"],
    expectedTerms: ["Two Way", "Project", "role"]
  },
  {
    id: "timeline_career",
    namespaceKind: "personal",
    toolName: "memory.search",
    query: "Give me my full work history with roles and dates.",
    categories: ["timeline", "things"],
    expectedTerms: ["Two-Way", "Well Inked"]
  },
  {
    id: "things_companies",
    namespaceKind: "personal",
    toolName: "memory.search",
    query: "What companies have I worked for?",
    categories: ["things"],
    expectedTerms: ["Two-Way", "Well Inked"]
  },
  {
    id: "people_id_carmack",
    namespaceKind: "personal",
    toolName: "memory.search",
    query: "What did I do when I worked with id Software and John Carmack?",
    categories: ["people", "timeline"],
    expectedTerms: ["id Software", "John Carmack"]
  },
  {
    id: "things_roles",
    namespaceKind: "personal",
    toolName: "memory.search",
    query: "What roles have I had at Two-Way and Well Inked?",
    categories: ["things", "timeline"],
    expectedTerms: ["Two-Way", "Well Inked"]
  },
  {
    id: "things_coffee",
    namespaceKind: "personal",
    toolName: "memory.search",
    query: "What coffee do I prefer now?",
    categories: ["things"],
    expectedTerms: ["coffee"]
  },
  {
    id: "things_peanuts",
    namespaceKind: "personal",
    toolName: "memory.search",
    query: "Can I have peanuts for dinner?",
    categories: ["things"],
    expectedTerms: ["peanuts"]
  },
  {
    id: "things_spicy_history",
    namespaceKind: "personal",
    toolName: "memory.search",
    query: "Did I use to like spicy food?",
    categories: ["things", "timeline"],
    expectedTerms: ["spicy"]
  },
  {
    id: "specs_mcp_gold",
    namespaceKind: "personal",
    toolName: "memory.search",
    query: "How do I run the MCP query taxonomy gold benchmark?",
    categories: ["specs"],
    expectedTerms: ["npm run benchmark:mcp-query-taxonomy-gold", "--workspace local-brain"]
  },
  {
    id: "people_multi_entity",
    namespaceKind: "personal",
    toolName: "memory.search",
    query: "What do I know about Gummi, Two Way, and the Istanbul trip?",
    categories: ["people", "places", "things", "timeline"],
    expectedTerms: ["Gummi", "Two Way", "Istanbul"]
  }
];

const MULTI_SOURCE_SEEDS: readonly AuditSeed[] = [
  {
    id: "multi_tasks_notes_pdfs_exports",
    namespaceKind: "multi_source",
    toolName: "memory.extract_tasks",
    query: "What tasks did I mention across notes, PDFs, and task exports this week?",
    categories: ["tasks", "pdfs", "other_ingestion"],
    expectedTerms: ["Schema-Grounded Memory PDF", "document chunking fixture", "Phase 14 retrieval spec"]
  },
  {
    id: "multi_calendar_exports",
    namespaceKind: "multi_source",
    toolName: "memory.extract_calendar",
    query: "What travel or calendar commitments are in my notes and calendar exports for June 2026?",
    categories: ["timeline", "other_ingestion"],
    expectedTerms: ["Bangkok AI model meetup", "2026-06-15", "AI memory PDF review"]
  },
  {
    id: "multi_ai_memory_pdfs",
    namespaceKind: "multi_source",
    toolName: "memory.search",
    query: "What AI memory PDFs did I save for retrieval planning?",
    categories: ["pdfs", "specs"],
    expectedTerms: ["Schema-Grounded Memory", "xMemory", "chunking"]
  },
  {
    id: "multi_project_specs",
    namespaceKind: "multi_source",
    toolName: "memory.search",
    query: "What project specs mention Phase 14 retrieval planning across notes and PDFs?",
    categories: ["specs", "pdfs", "other_ingestion"],
    expectedTerms: ["Phase 14", "retrieval planning", "source envelope"]
  }
];

async function buildPersonalSeeds(): Promise<readonly AuditSeed[]> {
  const latestTaskExpectedTerms = await latestOmiTaskExpectedTerms();
  return PERSONAL_SEEDS.map((seed) =>
    seed.id === "tasks_latest_note" && latestTaskExpectedTerms.length > 0 ? { ...seed, expectedTerms: latestTaskExpectedTerms } : seed
  );
}

async function runAuditRow(seed: AuditSeed, variantIndex: number, namespaceId: string, query: string): Promise<AuditRow> {
  const startedAt = performance.now();
  try {
    const wrapped = (await executeMcpTool(seed.toolName, {
      namespace_id: namespaceId,
      query,
      limit: 10,
      detail_mode: "compact",
      detailMode: "compact",
      reference_now: seed.namespaceKind === "multi_source" ? "2026-05-23T08:30:00.000Z" : undefined
    })) as { readonly structuredContent?: any };
    const payload = wrapped.structuredContent ?? {};
    const serialized = JSON.stringify(payload);
    const missingTerms = seed.expectedTerms.filter((term) => !hasComparableTerm(serialized, term));
    const evidenceCount = payloadEvidenceCount(payload);
    const sourceTrailCount = sourceTrailEntries(payload).length;
    const claimAuditCount = Array.isArray(payload.claimAudit) ? payload.claimAudit.length : 0;
    const queryTimeModelCalls = queryTimeModelCallsFromPayload(payload);
    const classification = classifyRow({
      missingTerms,
      evidenceCount,
      sourceTrailCount,
      claimAuditCount,
      queryTimeModelCalls,
      toolError: false
    });
    return {
      id: `${seed.id}_v${variantIndex + 1}`,
      query,
      namespaceId,
      toolName: seed.toolName,
      categories: seed.categories,
      expectedTerms: seed.expectedTerms,
      missingTerms,
      finalClaimSource: typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : null,
      queryContract: typeof payload.queryContract === "string" ? payload.queryContract : null,
      retrievalDomain: typeof payload.retrievalDomain === "string" ? payload.retrievalDomain : null,
      evidenceCount,
      sourceTrailCount,
      claimAuditCount,
      queryTimeModelCalls,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      answerPreview: answerPreview(payload),
      ...classification
    };
  } catch (error) {
    return {
      id: `${seed.id}_v${variantIndex + 1}`,
      query,
      namespaceId,
      toolName: seed.toolName,
      categories: seed.categories,
      expectedTerms: seed.expectedTerms,
      missingTerms: seed.expectedTerms,
      finalClaimSource: null,
      queryContract: null,
      retrievalDomain: null,
      evidenceCount: 0,
      sourceTrailCount: 0,
      claimAuditCount: 0,
      queryTimeModelCalls: 0,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      answerPreview: error instanceof Error ? error.message : String(error),
      quality: "fail",
      residualOwner: "tool_error",
      passed: false
    };
  }
}

function metricsFromRows(rows: readonly AuditRow[]): Record<string, unknown> {
  const categories = new Map<string, { total: number; strong: number; weak: number; fail: number }>();
  for (const row of rows) {
    for (const category of row.categories) {
      const bucket = categories.get(category) ?? { total: 0, strong: 0, weak: 0, fail: 0 };
      bucket.total += 1;
      if (row.quality === "strong") bucket.strong += 1;
      if (row.quality === "weak") bucket.weak += 1;
      if (row.quality === "fail") bucket.fail += 1;
      categories.set(category, bucket);
    }
  }
  return {
    totalRows: rows.length,
    strongCount: rows.filter((row) => row.quality === "strong").length,
    weakCount: rows.filter((row) => row.quality === "weak").length,
    failCount: rows.filter((row) => row.quality === "fail").length,
    missingExpectedTermRows: rows.filter((row) => row.missingTerms.length > 0).length,
    supportedEmptySourceTrailRows: rows.filter((row) => row.evidenceCount > 0 && row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditRows: rows.filter((row) => row.evidenceCount > 0 && row.claimAuditCount === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    categoryBreakdown: Object.fromEntries([...categories.entries()].sort(([left], [right]) => left.localeCompare(right))),
    residualOwnerCounts: rows.reduce<Record<string, number>>((counts, row) => {
      counts[row.residualOwner] = (counts[row.residualOwner] ?? 0) + 1;
      return counts;
    }, {})
  };
}

function toMarkdown(report: any): string {
  const lines = [
    "# MCP Human Query Audit 100",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- totalRows: ${report.metrics.totalRows}`,
    `- strongCount: ${report.metrics.strongCount}`,
    `- weakCount: ${report.metrics.weakCount}`,
    `- failCount: ${report.metrics.failCount}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    `- multiSourceNamespaceId: ${report.multiSourceNamespaceId}`,
    "",
    "## Weak Or Failed Rows",
    "",
    ...report.results
      .filter((row: AuditRow) => row.quality !== "strong")
      .map(
        (row: AuditRow) =>
          `- ${row.id}: quality=${row.quality} owner=${row.residualOwner} missing=${row.missingTerms.join("|") || "none"} query=${row.query}`
      ),
    "",
    "## Examples",
    "",
    ...report.results
      .filter((row: AuditRow) => row.quality === "strong")
      .slice(0, 12)
      .map((row: AuditRow) => `- ${row.id}: ${row.answerPreview || row.finalClaimSource || "source-backed"}`),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteMcpHumanQueryAudit100(): Promise<{
  readonly report: any;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const { rows, multiSourceNamespaceId, multiSourceIngestionArtifact } = await runMcpHumanQueryAuditRows();
  const generatedAt = new Date().toISOString();
  const metrics = metricsFromRows(rows);
  const report = {
    generatedAt,
    benchmark: "mcp_human_query_audit_100",
    passed:
      rows.length === 100 &&
      metrics.weakCount === 0 &&
      metrics.failCount === 0 &&
      metrics.missingExpectedTermRows === 0 &&
      metrics.supportedEmptySourceTrailRows === 0 &&
      metrics.supportedMissingClaimAuditRows === 0 &&
      metrics.queryTimeModelCalls === 0,
    multiSourceNamespaceId,
    multiSourceIngestionArtifact,
    metrics,
    results: rows
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `mcp-human-query-audit-100-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `mcp-human-query-audit-100-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runMcpHumanQueryAuditRows(options: { readonly rowLimit?: number } = {}): Promise<{
  readonly rows: readonly AuditRow[];
  readonly multiSourceNamespaceId: string;
  readonly multiSourceIngestionArtifact: string;
}> {
  const multiSource = await runAndWriteMultiSourceIngestionPack();
  const multiSourceNamespaceId = multiSource.report.namespaceId;
  const rows: AuditRow[] = [];
  const personalSeeds = await buildPersonalSeeds();
  const seeds = [...personalSeeds, ...MULTI_SOURCE_SEEDS];
  for (const seed of seeds) {
    const namespaceId = seed.namespaceKind === "personal" ? "personal" : multiSourceNamespaceId;
    const variants = queryVariants(seed.query);
    for (let index = 0; index < variants.length; index += 1) {
      if (typeof options.rowLimit === "number" && rows.length >= options.rowLimit) {
        return {
          rows,
          multiSourceNamespaceId,
          multiSourceIngestionArtifact: multiSource.output.jsonPath
        };
      }
      rows.push(await runAuditRow(seed, index, namespaceId, variants[index]!));
    }
  }

  return {
    rows,
    multiSourceNamespaceId,
    multiSourceIngestionArtifact: multiSource.output.jsonPath
  };
}

export async function runMcpHumanQueryAudit100Cli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteMcpHumanQueryAudit100();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
