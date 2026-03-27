import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { closePool, queryRows, withMaintenanceLock } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { readConfig } from "../config.js";
import { upsertNamespaceSelfProfile } from "../identity/service.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";
import { runRelationshipAdjudication } from "../jobs/relationship-adjudication.js";
import { getProviderAdapter } from "../providers/registry.js";
import { resolveEmbeddingRuntimeSelection } from "../providers/embedding-config.js";
import { executeMcpTool } from "../mcp/server.js";
import {
  createMonitoredSource,
  deleteMonitoredSource,
  getMonitoredSourcePreview,
  importMonitoredSource,
  listMonitoredSources,
  processScheduledMonitoredSources,
  scanMonitoredSource
} from "../ops/source-service.js";

type Grade = "pass" | "fail";

interface ExtensionCheck {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly present: readonly string[];
  readonly missingRequired: readonly string[];
  readonly missingOptional: readonly string[];
  readonly grade: Grade;
}

interface EmbeddingCheck {
  readonly provider: string;
  readonly model?: string;
  readonly configuredDimensions?: number;
  readonly activeDimensions: readonly number[];
  readonly providerDimensions?: number;
  readonly latencyMs: number;
  readonly grade: Grade;
  readonly failures: readonly string[];
}

interface McpStdioCheck {
  readonly toolCount: number;
  readonly requiredToolsPresent: boolean;
  readonly searchPassed: boolean;
  readonly relationshipsPassed: boolean;
  readonly grade: Grade;
  readonly failures: readonly string[];
}

interface LiveInductionCheck {
  readonly namespaceId: string;
  readonly sourceId: string;
  readonly importPassed: boolean;
  readonly searchPassed: boolean;
  readonly relationshipPassed: boolean;
  readonly grade: Grade;
  readonly failures: readonly string[];
}

export interface DemoReadinessReport {
  readonly generatedAt: string;
  readonly extensions: ExtensionCheck;
  readonly embeddings: EmbeddingCheck;
  readonly mcpStdio: McpStdioCheck;
  readonly liveInduction: LiveInductionCheck;
  readonly passed: boolean;
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function rootDir(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

function generatedRoot(): string {
  return path.resolve(rootDir(), "benchmark-generated", "demo-readiness", "normalized");
}

function collectText(payload: unknown): string {
  if (payload == null) {
    return "";
  }
  if (typeof payload === "string") {
    return payload;
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => collectText(item)).join("\n");
  }
  if (typeof payload === "object") {
    return Object.values(payload as Record<string, unknown>)
      .map((item) => collectText(item))
      .join("\n");
  }
  return String(payload);
}

async function loadActiveEmbeddingColumnDimensions(): Promise<readonly number[]> {
  const rows = await queryRows<{ formatted_type: string }>(
    `
      SELECT format_type(a.atttypid, a.atttypmod) AS formatted_type
      FROM pg_attribute a
      INNER JOIN pg_class c ON c.oid = a.attrelid
      INNER JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('semantic_memory', 'artifact_derivations')
        AND a.attname = 'embedding'
        AND a.attnum > 0
        AND NOT a.attisdropped
    `
  );

  const dimensions = rows
    .map((row) => row.formatted_type.match(/^vector\((\d+)\)$/i)?.[1])
    .map((value) => (value ? Number(value) : undefined))
    .filter((value): value is number => value !== undefined && Number.isFinite(value));

  return [...new Set(dimensions)];
}

async function checkExtensions(): Promise<ExtensionCheck> {
  const required = ["pgcrypto", "vector", "btree_gin", "vectorscale", "pg_search"] as const;
  const optional = ["timescaledb"] as const;
  const rows = await queryRows<{ extname: string }>(`SELECT extname FROM pg_extension ORDER BY extname ASC`);
  const present = rows.map((row) => row.extname);
  const missingRequired = required.filter((name) => !present.includes(name));
  const missingOptional = optional.filter((name) => !present.includes(name));

  return {
    required: [...required],
    optional: [...optional],
    present,
    missingRequired,
    missingOptional,
    grade: missingRequired.length === 0 ? "pass" : "fail"
  };
}

async function checkEmbeddings(): Promise<EmbeddingCheck> {
  const failures: string[] = [];
  const config = readConfig();
  const selection = resolveEmbeddingRuntimeSelection();
  const adapter = getProviderAdapter(selection.provider);
  const activeDimensions = await loadActiveEmbeddingColumnDimensions();
  const startedAt = performance.now();
  const result = await adapter.embedText({
    text: "Embedding invariance smoke check for demo readiness.",
    model: selection.model,
    outputDimensionality: selection.outputDimensionality
  });
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));

  if (!selection.model) {
    failures.push("no embedding model resolved from config");
  }
  if (typeof result.dimensions !== "number") {
    failures.push("provider smoke did not return embedding dimensions");
  }
  if (selection.outputDimensionality && result.dimensions !== selection.outputDimensionality) {
    failures.push(`provider dimensions ${result.dimensions} do not match configured dimensions ${selection.outputDimensionality}`);
  }
  if (activeDimensions.length > 0 && !activeDimensions.includes(result.dimensions)) {
    failures.push(`provider dimensions ${result.dimensions} do not match active pgvector columns (${activeDimensions.join(", ")})`);
  }

  return {
    provider: selection.provider,
    model: selection.model,
    configuredDimensions: config.embeddingDimensions,
    activeDimensions,
    providerDimensions: result.dimensions,
    latencyMs,
    grade: failures.length === 0 ? "pass" : "fail",
    failures
  };
}

async function buildDemoCorpus(root: string): Promise<number> {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "2026", "06", "01"), { recursive: true });
  await mkdir(path.join(root, "2026", "06", "08"), { recursive: true });
  await mkdir(path.join(root, "2026", "06", "15"), { recursive: true });

  const files = [
    {
      relativePath: "2026/06/01/2026-06-01T09-00-00Z__demo__tea.md",
      body: "# Tea Preference\n\nBy June 2026, Steve prefers ginger tea now. This is the new current tea preference.\n"
    },
    {
      relativePath: "2026/06/01/2026-06-01T14-00-00Z__demo__relationships-1.md",
      body: "# Demo Relationships Week 1\n\nSteve is friends with Mina. Steve works with Mina on Demo Pilot.\n"
    },
    {
      relativePath: "2026/06/08/2026-06-08T14-00-00Z__demo__relationships-2.md",
      body: "# Demo Relationships Week 2\n\nAgain, Steve worked with Mina on Demo Pilot this week and still considers Mina a friend.\n"
    },
    {
      relativePath: "2026/06/15/2026-06-15T14-00-00Z__demo__relationships-3.md",
      body: "# Demo Relationships Week 3\n\nFor the third week in a row, Steve and Mina worked together on Demo Pilot and met up as friends afterward.\n"
    }
  ] as const;

  for (const file of files) {
    await writeFile(path.join(root, file.relativePath), file.body, "utf8");
  }

  return files.length;
}

async function writeScheduledDelta(root: string): Promise<readonly string[]> {
  const files = [
    {
      relativePath: "2026/06/22/2026-06-22T10-30-00Z__demo__scheduled-delta-1.md",
      body: "# Demo Scheduled Delta Week 4\n\nSteve and Mina started working with Noor on Demo Launch. Steve prefers sencha tea in the evening now.\n"
    },
    {
      relativePath: "2026/06/29/2026-06-29T10-30-00Z__demo__scheduled-delta-2.md",
      body: "# Demo Scheduled Delta Week 5\n\nSteve worked with Noor again on Demo Launch this week, alongside Mina.\n"
    },
    {
      relativePath: "2026/07/06/2026-07-06T10-30-00Z__demo__scheduled-delta-3.md",
      body: "# Demo Scheduled Delta Week 6\n\nFor the third straight week, Steve, Mina, and Noor worked together on Demo Launch.\n"
    }
  ] as const;

  for (const file of files) {
    const absolutePath = path.join(root, file.relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.body, "utf8");
  }

  return files.map((file) => file.relativePath);
}

async function ensureSource(namespaceId: string, rootPath: string) {
  const existing = (await listMonitoredSources(100)).filter((source) => source.namespaceId === namespaceId);
  for (const source of existing) {
    await deleteMonitoredSource(source.id);
  }
  return createMonitoredSource({
    sourceType: "folder",
    namespaceId,
    label: "Demo Readiness Source",
    rootPath,
    includeSubfolders: true,
    monitorEnabled: true,
    scanSchedule: "every_30_minutes",
    notes: "Demo-readiness induction source.",
    metadata: {
      source_intent: "ongoing_folder_monitor",
      producer: "demo_readiness_benchmark",
      smoke_test: true
    }
  });
}

async function checkLiveInduction(namespaceId = `demo_readiness_${Date.now()}`): Promise<LiveInductionCheck> {
  const failures: string[] = [];
  const root = generatedRoot();
  const markdownFiles = await buildDemoCorpus(root);
  await upsertNamespaceSelfProfile({
    namespaceId,
    canonicalName: "Steve Tietze",
    aliases: ["Steve"],
    note: "Demo readiness self anchor."
  });
  const source = await ensureSource(namespaceId, root);
  const preview = await scanMonitoredSource(source.id);
  const importResult = await importMonitoredSource(source.id, "onboarding");
  const scheduledRelativePaths = await writeScheduledDelta(root);
  await processScheduledMonitoredSources({
    sourceId: source.id,
    now: new Date(Date.now() + 31 * 60 * 1000),
    importAfterScan: true
  });
  const afterScheduled = await getMonitoredSourcePreview(source.id);
  await runCandidateConsolidation(namespaceId, 600);
  await runRelationshipAdjudication(namespaceId, {
    limit: 800,
    acceptThreshold: 0.58,
    rejectThreshold: 0.38
  });

  const search = (await executeMcpTool("memory.search", {
    namespace_id: namespaceId,
    query: "what tea does Steve prefer in the evening now?",
    limit: 8
  })) as { readonly structuredContent?: any };
  const coworkerSearch = (await executeMcpTool("memory.search", {
    namespace_id: namespaceId,
    query: "who joined Steve and Mina on Demo Launch?",
    limit: 8
  })) as { readonly structuredContent?: any };
  const searchText = collectText(search.structuredContent);
  const relationshipText = collectText(coworkerSearch.structuredContent);

  if (preview.preview.totalFiles < markdownFiles) {
    failures.push(`preview saw ${preview.preview.totalFiles} files, expected at least ${markdownFiles}`);
  }
  if ((importResult.importRun?.filesImported ?? 0) < markdownFiles) {
    failures.push(`imported ${(importResult.importRun?.filesImported ?? 0)} files, expected at least ${markdownFiles}`);
  }
  if ((afterScheduled.latestImport?.filesImported ?? 0) < scheduledRelativePaths.length) {
    failures.push(`scheduled monitor pass imported ${(afterScheduled.latestImport?.filesImported ?? 0)} files, expected at least ${scheduledRelativePaths.length}`);
  }
  const importedScheduledCount = scheduledRelativePaths.filter((relativePath) =>
    afterScheduled.files.some((file) => file.relativePath === relativePath && file.lastStatus === "imported")
  ).length;
  if (importedScheduledCount < scheduledRelativePaths.length) {
    failures.push(`scheduled delta import marked ${importedScheduledCount} of ${scheduledRelativePaths.length} files as imported`);
  }
  if (!searchText.toLowerCase().includes("sencha")) {
    failures.push("live induction search did not return the scheduled sencha tea delta");
  }
  if (!relationshipText.toLowerCase().includes("noor")) {
    failures.push("live induction relationship lookup did not return Noor from the scheduled delta");
  }

  const importPassed =
    preview.preview.totalFiles >= markdownFiles &&
    (importResult.importRun?.filesImported ?? 0) >= markdownFiles &&
    (afterScheduled.latestImport?.filesImported ?? 0) >= 1;

  return {
    namespaceId,
    sourceId: source.id,
    importPassed,
    searchPassed: searchText.toLowerCase().includes("sencha"),
    relationshipPassed: relationshipText.toLowerCase().includes("noor"),
    grade: failures.length === 0 ? "pass" : "fail",
    failures
  };
}

function encodeFrame(payload: unknown): string {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

async function readMcpFrame(stdout: NodeJS.ReadableStream, state: { buffer: Buffer }): Promise<JsonRpcResponse> {
  while (true) {
    const headerEnd = state.buffer.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const header = state.buffer.slice(0, headerEnd).toString("utf8");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (match) {
        const bodyStart = headerEnd + 4;
        const bodyLength = Number(match[1]);
        if (state.buffer.length >= bodyStart + bodyLength) {
          const body = state.buffer.slice(bodyStart, bodyStart + bodyLength).toString("utf8");
          state.buffer = state.buffer.slice(bodyStart + bodyLength);
          return JSON.parse(body) as JsonRpcResponse;
        }
      }
    }

    const chunk = await new Promise<Buffer>((resolve, reject) => {
      const onData = (data: Buffer) => {
        cleanup();
        resolve(data);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onEnd = () => {
        cleanup();
        reject(new Error("MCP stdio server ended before returning a frame."));
      };
      const cleanup = () => {
        stdout.off("data", onData);
        stdout.off("error", onError);
        stdout.off("end", onEnd);
      };
      stdout.on("data", onData);
      stdout.on("error", onError);
      stdout.on("end", onEnd);
    });
    state.buffer = Buffer.concat([state.buffer, chunk]);
  }
}

async function checkMcpStdio(namespaceId: string): Promise<McpStdioCheck> {
  const failures: string[] = [];
  const localBrainDir = path.resolve(rootDir());
  const child = spawn("node", ["dist/cli/mcp.js"], {
    cwd: localBrainDir,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const state = { buffer: Buffer.alloc(0) };

  try {
    child.stdin.write(encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    const initialize = await readMcpFrame(child.stdout, state);
    if (initialize.error) {
      failures.push(`initialize failed: ${initialize.error.message}`);
    }

    child.stdin.write(encodeFrame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
    const listed = await readMcpFrame(child.stdout, state);
    const tools = Array.isArray((listed.result as any)?.tools) ? ((listed.result as any).tools as Array<{ name?: string }>) : [];
    const toolNames = tools.map((tool) => tool.name).filter((name): name is string => typeof name === "string");
    const requiredTools = ["memory.search", "memory.get_relationships", "memory.get_clarifications", "memory.get_protocols"];
    const requiredToolsPresent = requiredTools.every((tool) => toolNames.includes(tool));
    if (!requiredToolsPresent) {
      failures.push("stdio tools/list missing one or more required tools");
    }

    child.stdin.write(
      encodeFrame({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "memory.search",
          arguments: {
            namespace_id: namespaceId,
            query: "what does Steve prefer now for tea?",
            limit: 6
          }
        }
      })
    );
    const search = await readMcpFrame(child.stdout, state);
    const searchText = collectText((search.result as any)?.structuredContent);
    const searchPassed = search.error === undefined && searchText.toLowerCase().includes("ginger tea");
    if (!searchPassed) {
      failures.push("stdio memory.search did not return ginger tea");
    }

    child.stdin.write(
      encodeFrame({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "memory.get_relationships",
          arguments: {
            namespace_id: namespaceId,
            entity_name: "Steve Tietze",
            limit: 10
          }
        }
      })
    );
    const relationships = await readMcpFrame(child.stdout, state);
    const relationshipText = collectText((relationships.result as any)?.structuredContent);
    const relationshipsPassed = relationships.error === undefined && relationshipText.toLowerCase().includes("mina");
    if (!relationshipsPassed) {
      failures.push("stdio memory.get_relationships did not return Mina");
    }

    return {
      toolCount: toolNames.length,
      requiredToolsPresent,
      searchPassed,
      relationshipsPassed,
      grade: failures.length === 0 ? "pass" : "fail",
      failures
    };
  } finally {
    child.kill("SIGTERM");
  }
}

function toMarkdown(report: DemoReadinessReport): string {
  const lines = [
    "# Demo Readiness Report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    "",
    "## Extensions",
    "",
    `- grade: ${report.extensions.grade}`,
    `- present: ${report.extensions.present.join(", ")}`,
    `- missing required: ${report.extensions.missingRequired.join(", ") || "none"}`,
    `- missing optional: ${report.extensions.missingOptional.join(", ") || "none"}`,
    "",
    "## Embeddings",
    "",
    `- grade: ${report.embeddings.grade}`,
    `- provider: ${report.embeddings.provider}`,
    `- model: ${report.embeddings.model ?? "n/a"}`,
    `- configured dimensions: ${report.embeddings.configuredDimensions ?? "n/a"}`,
    `- active dimensions: ${report.embeddings.activeDimensions.join(", ") || "none"}`,
    `- provider dimensions: ${report.embeddings.providerDimensions ?? "n/a"}`,
    `- latency: ${report.embeddings.latencyMs}ms`,
    ...report.embeddings.failures.map((failure) => `- ${failure}`),
    "",
    "## MCP Stdio",
    "",
    `- grade: ${report.mcpStdio.grade}`,
    `- tool count: ${report.mcpStdio.toolCount}`,
    `- required tools present: ${report.mcpStdio.requiredToolsPresent}`,
    `- memory.search passed: ${report.mcpStdio.searchPassed}`,
    `- memory.get_relationships passed: ${report.mcpStdio.relationshipsPassed}`,
    ...report.mcpStdio.failures.map((failure) => `- ${failure}`),
    "",
    "## Live Induction",
    "",
    `- grade: ${report.liveInduction.grade}`,
    `- namespace: ${report.liveInduction.namespaceId}`,
    `- sourceId: ${report.liveInduction.sourceId}`,
    `- import passed: ${report.liveInduction.importPassed}`,
    `- search passed: ${report.liveInduction.searchPassed}`,
    `- relationship passed: ${report.liveInduction.relationshipPassed}`,
    ...report.liveInduction.failures.map((failure) => `- ${failure}`),
    ""
  ];

  return `${lines.join("\n")}\n`;
}

export async function runDemoReadinessBenchmark(): Promise<DemoReadinessReport> {
  return withMaintenanceLock("the demo readiness benchmark", async () => {
    await runMigrations();
    const extensions = await checkExtensions();
    const embeddings = await checkEmbeddings();
    const liveInduction = await checkLiveInduction();
    const mcpStdio = await checkMcpStdio(liveInduction.namespaceId);

    return {
      generatedAt: new Date().toISOString(),
      extensions,
      embeddings,
      mcpStdio,
      liveInduction,
      passed:
        extensions.grade === "pass" &&
        embeddings.grade === "pass" &&
        mcpStdio.grade === "pass" &&
        liveInduction.grade === "pass"
    };
  });
}

export async function runAndWriteDemoReadinessBenchmark(): Promise<{
  readonly report: DemoReadinessReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  try {
    const report = await runDemoReadinessBenchmark();
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const jsonPath = path.join(dir, `demo-readiness-${stamp}.json`);
    const markdownPath = path.join(dir, `demo-readiness-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, toMarkdown(report), "utf8");
    return {
      report,
      output: {
        jsonPath,
        markdownPath
      }
    };
  } finally {
    await closePool();
  }
}

export async function runDemoReadinessBenchmarkCli(): Promise<void> {
  const result = await runAndWriteDemoReadinessBenchmark();
  console.log(JSON.stringify(result, null, 2));
}
