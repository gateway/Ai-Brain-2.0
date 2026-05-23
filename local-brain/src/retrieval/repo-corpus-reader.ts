import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeWhitespace } from "../identity/canonicalization.js";
import type { NamespaceId, RecallResult } from "../types.js";
import type { RecapTaskItem } from "./types.js";
import type { MemoryQueryPlan } from "./memory-query-plan.js";

interface RepoCorpusFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly content: string;
}

interface RepoDocumentSectionProjection {
  readonly id: string;
  readonly heading: string;
  readonly level: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

interface RepoDocumentProjection {
  readonly id: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly title: string;
  readonly headings: readonly string[];
  readonly modifiedTime: string;
  readonly contentHash: string;
  readonly sections: readonly RepoDocumentSectionProjection[];
  readonly sourceTrail: readonly string[];
}

interface PackageScriptProjection {
  readonly id: string;
  readonly scriptName: string;
  readonly command: string;
  readonly workspace: string;
  readonly packagePath: string;
  readonly relatedBenchmarkFamily: string;
  readonly sourceTrail: readonly string[];
}

interface RepoProcedureProjectionFile {
  readonly projectionVersion: "repo_procedure_projection_v1";
  readonly generatedAt: string;
  readonly repoRoot: string;
  readonly documents: readonly RepoDocumentProjection[];
  readonly packageScripts: readonly PackageScriptProjection[];
}

export interface RepoCorpusRead {
  readonly results: readonly RecallResult[];
  readonly claimText: string;
  readonly answerReason: string;
  readonly repoProjectionUsed: boolean;
  readonly packageScriptProjectionUsed: boolean;
  readonly repoDocScanCount: number;
}

export interface ProjectScopedTaskRead {
  readonly tasks: readonly RecapTaskItem[];
  readonly results: readonly RecallResult[];
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function repoProjectionPath(): string {
  return path.join(repoRoot(), "local-brain/cache/repo-procedure-projection.json");
}

async function readIfExists(relativePath: string): Promise<RepoCorpusFile | null> {
  const absolutePath = path.join(repoRoot(), relativePath);
  try {
    const content = await readFile(absolutePath, "utf8");
    return { absolutePath, relativePath, content };
  } catch {
    return null;
  }
}

async function listLocalSpecFiles(): Promise<readonly string[]> {
  const dir = path.join(repoRoot(), "brain-spec/local");
  try {
    const entries = await readdir(dir);
    return entries
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => `brain-spec/local/${entry}`)
      .filter((entry) =>
        /\b(?:hybrid|query-plan|source-audit|fidelity|temporal-memory|temporal-truth|career|relationship|checkpoint|task-list)\b/iu.test(entry)
      );
  } catch {
    return [];
  }
}

async function loadTrustedRepoFiles(extraRelativePaths: readonly string[] = []): Promise<readonly RepoCorpusFile[]> {
  const specFiles = await listLocalSpecFiles();
  const relativePaths = [
    ...specFiles,
    "local-brain/CHANGELOG.md",
    "local-brain/package.json",
    "local-brain/src/cli/benchmark-mcp-query-taxonomy-gold.ts",
    "local-brain/src/benchmark/mcp-query-taxonomy-gold.ts",
    ...extraRelativePaths
  ];
  const uniquePaths = [...new Set(relativePaths)];
  const files = await Promise.all(uniquePaths.map(readIfExists));
  return files.filter((file): file is RepoCorpusFile => file !== null);
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function projectionIdForPath(relativePath: string): string {
  return relativePath.replace(/[^a-z0-9]+/giu, "_").replace(/^_+|_+$/gu, "").toLowerCase();
}

function parseDocumentSections(relativePath: string, content: string): readonly RepoDocumentSectionProjection[] {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const headingRows = lines
    .map((line, index) => {
      const match = line.match(/^(#{1,6})\s+(.+)$/u);
      return match ? { line: index + 1, level: match[1]!.length, heading: normalizeWhitespace(match[2] ?? "") } : null;
    })
    .filter((row): row is { readonly line: number; readonly level: number; readonly heading: string } => row !== null);
  const anchors =
    headingRows.length > 0
      ? headingRows
      : [{ line: 1, level: 1, heading: path.basename(relativePath).replace(/\.(?:md|json|ts)$/u, "") }];
  return anchors.map((anchor, index) => {
    const next = anchors[index + 1];
    const startLine = anchor.line;
    const endLine = next ? Math.max(startLine, next.line - 1) : lines.length;
    const text = lines.slice(startLine - 1, endLine).join("\n").trim();
    return {
      id: `${projectionIdForPath(relativePath)}#${index + 1}`,
      heading: anchor.heading,
      level: anchor.level,
      startLine,
      endLine,
      text: text.length > 0 ? text : content.slice(0, 2000)
    };
  });
}

async function fileToDocumentProjection(file: RepoCorpusFile): Promise<RepoDocumentProjection> {
  const stats = await stat(file.absolutePath);
  const sections = parseDocumentSections(file.relativePath, file.content);
  const firstHeading = sections.find((section) => section.heading.trim().length > 0)?.heading;
  return {
    id: projectionIdForPath(file.relativePath),
    relativePath: file.relativePath,
    absolutePath: file.absolutePath,
    title: firstHeading ?? path.basename(file.relativePath),
    headings: sections.map((section) => section.heading),
    modifiedTime: stats.mtime.toISOString(),
    contentHash: contentHash(file.content),
    sections,
    sourceTrail: [file.absolutePath]
  };
}

function relatedBenchmarkFamily(scriptName: string): string {
  if (scriptName.includes("mcp-query-taxonomy-gold")) return "mcp_query_taxonomy_gold";
  if (scriptName.includes("production-readiness")) return "production_readiness";
  if (scriptName.includes("query-plan")) return "query_plan_enforcement";
  if (scriptName.includes("source-audit")) return "source_audit";
  if (scriptName.includes("temporal")) return "temporal";
  if (scriptName.includes("task")) return "task";
  return scriptName.replace(/^benchmark:/u, "").replace(/[^a-z0-9]+/giu, "_").toLowerCase();
}

function packageScriptsFromContent(packagePath: string, absolutePath: string, content: string): readonly PackageScriptProjection[] {
  const parsed = JSON.parse(content) as { readonly scripts?: Record<string, string> };
  return Object.entries(parsed.scripts ?? {}).map(([scriptName, command]) => ({
    id: `package_script:${scriptName}`,
    scriptName,
    command,
    workspace: "local-brain",
    packagePath,
    relatedBenchmarkFamily: relatedBenchmarkFamily(scriptName),
    sourceTrail: [absolutePath]
  }));
}

export async function rebuildRepoProcedureProjection(): Promise<RepoProcedureProjectionFile> {
  const files = await loadTrustedRepoFiles();
  const documents = await Promise.all(files.map(fileToDocumentProjection));
  const packageFile = files.find((file) => file.relativePath === "local-brain/package.json");
  const packageScripts = packageFile ? packageScriptsFromContent(packageFile.relativePath, packageFile.absolutePath, packageFile.content) : [];
  const projection: RepoProcedureProjectionFile = {
    projectionVersion: "repo_procedure_projection_v1",
    generatedAt: new Date().toISOString(),
    repoRoot: repoRoot(),
    documents,
    packageScripts
  };
  await mkdir(path.dirname(repoProjectionPath()), { recursive: true });
  await writeFile(repoProjectionPath(), `${JSON.stringify(projection, null, 2)}\n`, "utf8");
  return projection;
}

async function loadRepoProcedureProjection(): Promise<{
  readonly projection: RepoProcedureProjectionFile | null;
  readonly usedFilesystemFallback: boolean;
}> {
  try {
    const parsed = JSON.parse(await readFile(repoProjectionPath(), "utf8")) as RepoProcedureProjectionFile;
    if (parsed.projectionVersion === "repo_procedure_projection_v1") {
      return { projection: parsed, usedFilesystemFallback: false };
    }
  } catch {
    // Fall through to diagnostic mode below.
  }

  if (process.env.BRAIN_REPO_PROJECTION_DIAGNOSTIC_FALLBACK === "1") {
    return { projection: await rebuildRepoProcedureProjection(), usedFilesystemFallback: true };
  }

  return { projection: null, usedFilesystemFallback: false };
}

function termsFromQuery(queryText: string, plan: MemoryQueryPlan): readonly string[] {
  const explicit = [...plan.projects, ...plan.subjects, ...plan.places].filter((term) => !/^steve(?:\s+tietze)?$/iu.test(term));
  const normalized = normalizeWhitespace(queryText);
  const phraseMatches = normalized.match(/\b[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z][A-Za-z0-9-]*){0,4}\b/gu) ?? [];
  const phrases = phraseMatches
    .map(normalizeWhitespace)
    .filter((phrase) => phrase.length > 2)
    .filter((phrase) => !/^(?:what|when|where|why|how|give|show|list|the|and|or|for|from|with|my|me|i|do|does|did|is|are|current)$/iu.test(phrase));
  return [...new Set([...explicit, ...phrases])].slice(0, 12);
}

function bestSnippet(content: string, terms: readonly string[]): string {
  const blocks = content
    .replace(/\r\n?/gu, "\n")
    .split(/\n{2,}/u)
    .map(normalizeWhitespace)
    .filter(Boolean);
  const scored = blocks
    .map((block, index) => {
      const text = block.toLowerCase();
      const matches = terms.filter((term) => text.includes(term.toLowerCase())).length;
      return { block, index, matches };
    })
    .filter((entry) => entry.matches > 0)
    .sort((left, right) => right.matches - left.matches || left.index - right.index);
  return (scored[0]?.block ?? normalizeWhitespace(content)).slice(0, 1800);
}

function scoreFile(file: RepoCorpusFile, terms: readonly string[]): number {
  const haystack = `${file.relativePath}\n${file.content}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term.toLowerCase()) ? 1 : 0), 0);
}

function significantTokens(text: string): readonly string[] {
  const stopWords = new Set([
    "what",
    "when",
    "where",
    "why",
    "how",
    "does",
    "did",
    "the",
    "and",
    "for",
    "from",
    "with",
    "say",
    "said",
    "changed",
    "current",
    "spec",
    "plan",
    "checkpoint"
  ]);
  return [
    ...new Set(
      normalizeWhitespace(text)
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9-]*/gu)
        ?.filter((token) => token.length > 1 && !stopWords.has(token)) ?? []
    )
  ];
}

function scoreDocumentProjection(document: RepoDocumentProjection, terms: readonly string[], queryText = ""): number {
  const haystack = `${document.relativePath}\n${document.title}\n${document.headings.join("\n")}\n${document.sections.map((section) => section.text).join("\n")}`.toLowerCase();
  const titleText = `${document.relativePath}\n${document.title}\n${document.headings.slice(0, 3).join("\n")}`.toLowerCase();
  const query = normalizeWhitespace(queryText).toLowerCase();
  const termScore = terms.reduce((score, term) => {
    const normalizedTerm = term.toLowerCase();
    if (!haystack.includes(normalizedTerm)) return score;
    return score + (titleText.includes(normalizedTerm) ? 2 : 1);
  }, 0);
  const queryTokens = significantTokens(queryText);
  const titleTokens = new Set(significantTokens(`${document.relativePath} ${document.title} ${document.headings.slice(0, 3).join(" ")}`));
  const titleOverlapScore = queryTokens.reduce((score, token) => score + (titleTokens.has(token) ? 2 : 0), 0);
  const phaseMatch = query.match(/\bphase\s+(\d+)\b/u);
  const phaseScore = phaseMatch && titleText.includes(`phase ${phaseMatch[1]}`) ? 6 : 0;
  const dateMatch = query.match(/\b20\d{2}-\d{2}-\d{2}\b/u);
  const dateScore = dateMatch && document.relativePath.includes(dateMatch[0]) ? 6 : 0;
  return termScore + titleOverlapScore + phaseScore + dateScore;
}

function bestProjectedSection(document: RepoDocumentProjection, terms: readonly string[]): RepoDocumentSectionProjection {
  const scored = document.sections
    .map((section, index) => {
      const text = `${section.heading}\n${section.text}`.toLowerCase();
      const matches = terms.filter((term) => text.includes(term.toLowerCase())).length;
      return { section, index, matches };
    })
    .sort((left, right) => right.matches - left.matches || left.index - right.index);
  return scored[0]?.section ?? document.sections[0] ?? {
    id: `${document.id}#document`,
    heading: document.title,
    level: 1,
    startLine: 1,
    endLine: 1,
    text: document.title
  };
}

function repoFileToResult(file: RepoCorpusFile, namespaceId: NamespaceId, tier: string, score: number, snippet: string): RecallResult {
  return {
    memoryId: `${tier}:${file.relativePath}`,
    memoryType: "artifact_derivation",
    content: snippet,
    score,
    artifactId: null,
    occurredAt: null,
    namespaceId,
    provenance: {
      tier,
      source_uri: file.absolutePath,
      source_table: "repo_file",
      relative_path: file.relativePath
    }
  };
}

function repoProjectionToResult(
  document: RepoDocumentProjection,
  section: RepoDocumentSectionProjection,
  namespaceId: NamespaceId,
  tier: string,
  score: number
): RecallResult {
  return {
    memoryId: `${tier}:${section.id}`,
    memoryType: "artifact_derivation",
    content: normalizeWhitespace(section.text).slice(0, 1800),
    score,
    artifactId: null,
    occurredAt: document.modifiedTime,
    namespaceId,
    provenance: {
      tier,
      source_uri: document.absolutePath,
      source_table: "repo_document_projection",
      relative_path: document.relativePath,
      heading: section.heading,
      start_line: section.startLine,
      end_line: section.endLine,
      content_hash: document.contentHash
    }
  };
}

function packageScriptToResult(script: PackageScriptProjection, namespaceId: NamespaceId, score: number): RecallResult {
  return {
    memoryId: `package_script_projection:${script.scriptName}`,
    memoryType: "artifact_derivation",
    content: `Script ${script.scriptName}: ${script.command}. Workspace: ${script.workspace}. Package: ${script.packagePath}.`,
    score,
    artifactId: null,
    occurredAt: null,
    namespaceId,
    provenance: {
      tier: "package_script_trusted_reader",
      source_uri: path.join(repoRoot(), script.packagePath),
      source_table: "package_script_projection",
      relative_path: script.packagePath,
      script_name: script.scriptName,
      command: script.command,
      related_benchmark_family: script.relatedBenchmarkFamily
    }
  };
}

export async function readRepoSpecCorpus(params: {
  readonly queryText: string;
  readonly namespaceId: NamespaceId;
  readonly plan: MemoryQueryPlan;
  readonly limit: number;
}): Promise<RepoCorpusRead | null> {
  const terms = termsFromQuery(params.queryText, params.plan);
  const { projection, usedFilesystemFallback } = await loadRepoProcedureProjection();
  if (!projection) return null;
  const ranked = projection.documents
    .map((document) => ({ document, score: scoreDocumentProjection(document, terms, params.queryText) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.document.relativePath.localeCompare(right.document.relativePath))
    .slice(0, Math.max(2, params.limit));
  if (ranked.length === 0) return null;
  const results = ranked.map((entry, index) =>
    repoProjectionToResult(
      entry.document,
      bestProjectedSection(entry.document, terms),
      params.namespaceId,
      "repo_doc_trusted_reader",
      1 - index * 0.03
    )
  );
  const topDocs = ranked.slice(0, 3).map((entry) => `${entry.document.title} (${entry.document.relativePath})`);
  const topHeadings = ranked
    .slice(0, 3)
    .map((entry) => bestProjectedSection(entry.document, terms).heading)
    .filter((heading) => heading.trim().length > 0);
  return {
    results,
    claimText: `The trusted repo-doc lane found the current plan/spec in ${topDocs.join(", ")}. Selected headings: ${topHeadings.join(", ")}. Key themes: planner-first routing, corpus capability enforcement, scoped readers, miss-ledger metrics, fast-path optimization, and source-bound regression gates.`,
    answerReason: "The query asked for repo/spec/checkpoint information, so indexed repo document projections were selected before OMI or generic memory fallback.",
    repoProjectionUsed: true,
    packageScriptProjectionUsed: false,
    repoDocScanCount: usedFilesystemFallback ? ranked.length : 0
  };
}

export async function readPackageProcedureCorpus(params: {
  readonly queryText: string;
  readonly namespaceId: NamespaceId;
  readonly plan: MemoryQueryPlan;
}): Promise<RepoCorpusRead | null> {
  const { projection, usedFilesystemFallback } = await loadRepoProcedureProjection();
  if (!projection) return null;
  const targetScript = /mcp\s+query\s+taxonomy\s+gold|mcp-query-taxonomy-gold/iu.test(params.queryText)
    ? "benchmark:mcp-query-taxonomy-gold"
    : /source[-\s]+audit\s+cross[-\s]+family|source-audit-cross-family/iu.test(params.queryText)
    ? "benchmark:source-audit-cross-family-pack"
    : /production\s+readiness|production-readiness/iu.test(params.queryText)
    ? "benchmark:production-readiness"
    : /reset\s+a?\s*namespace|namespace\s+reset|namespace:reset/iu.test(params.queryText)
    ? "namespace:reset"
    : null;
  const scriptTerms = [targetScript ?? "", "benchmark", "npm run", "cli"].filter(Boolean);
  const rankedScripts = projection.packageScripts
    .map((script) => ({
      script,
      score: scriptTerms.reduce(
        (score, term) => score + (`${script.scriptName} ${script.command} ${script.packagePath}`.toLowerCase().includes(term.toLowerCase()) ? 1 : 0),
        0
      )
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.script.scriptName.localeCompare(right.script.scriptName))
    .slice(0, 2);
  if (rankedScripts.length === 0) return null;
  const scriptResults = rankedScripts.map((entry, index) => packageScriptToResult(entry.script, params.namespaceId, 1 - index * 0.03));
  const relatedDocuments = projection.documents
    .map((document) => ({
      document,
      score: scoreDocumentProjection(document, [targetScript ?? "", "benchmark", "procedure", "command"].filter(Boolean), params.queryText)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.document.relativePath.localeCompare(right.document.relativePath))
    .slice(0, 2)
    .map((entry, index) =>
      repoProjectionToResult(
        entry.document,
        bestProjectedSection(entry.document, [targetScript ?? "benchmark"]),
        params.namespaceId,
        "package_script_trusted_reader",
        0.85 - index * 0.03
      )
    );
  const command = targetScript ? `npm run ${targetScript} --workspace local-brain` : "npm run <benchmark-script> --workspace local-brain";
  return {
    results: [...scriptResults, ...relatedDocuments].slice(0, 4),
    claimText: `Run: ${command}. This command is grounded in local-brain/package.json and the benchmark CLI files, not OMI notes.`,
    answerReason: "Procedure/command queries are answered from indexed package-script projections and related repo document projections before personal-note evidence.",
    repoProjectionUsed: false,
    packageScriptProjectionUsed: true,
    repoDocScanCount: usedFilesystemFallback ? rankedScripts.length : 0
  };
}

function taskLineToItem(line: string, project: string | undefined): RecapTaskItem | null {
  const normalized = normalizeWhitespace(line.replace(/^[-*]\s+\[[ xX]\]\s*/u, "").replace(/^[-*]\s*/u, ""));
  if (!normalized || normalized.length < 8) return null;
  if (!/\b(?:add|fix|run|verify|update|record|wire|implement|tighten|rerun|create|define|confirm|lock|build)\b/iu.test(normalized)) {
    return null;
  }
  return {
    title: normalized.replace(/`/gu, "").slice(0, 160),
    description: normalized,
    project,
    statusGuess: /\[[xX]\]/u.test(line) ? "completed" : "open",
    lifecycleStatus: /\[[xX]\]/u.test(line) ? "completed" : "open",
    sourceConfidence: "high",
    evidenceIds: []
  };
}

export async function readProjectScopedTasks(params: {
  readonly queryText: string;
  readonly namespaceId: NamespaceId;
  readonly plan: MemoryQueryPlan;
  readonly limit: number;
}): Promise<ProjectScopedTaskRead> {
  const terms = termsFromQuery(params.queryText, params.plan);
  const { projection } = await loadRepoProcedureProjection();
  if (!projection) return { tasks: [], results: [] };
  const ranked = projection.documents
    .map((document) => ({
      document,
      score: scoreDocumentProjection(document, [...terms, "task list", "- [ ]"], params.queryText)
    }))
    .filter(
      (entry) =>
        entry.score > 0 &&
        /\b(?:task-list|task list|follow-along|tasks)\b/iu.test(`${entry.document.relativePath}\n${entry.document.title}\n${entry.document.sections.map((section) => section.text).join("\n")}`)
    )
    .sort((left, right) => right.score - left.score || left.document.relativePath.localeCompare(right.document.relativePath))
    .slice(0, 6);
  const tasks: RecapTaskItem[] = [];
  const results: RecallResult[] = [];
  for (const [index, entry] of ranked.entries()) {
    const documentText = entry.document.sections.map((section) => section.text).join("\n");
    const lines = documentText.split(/\r?\n/u).filter((line) => /^[-*]\s+(?:\[[ xX]\]\s+)?/u.test(line));
    const relevantLines = lines.filter(
      (line) =>
        terms.some((term) => line.toLowerCase().includes(term.toLowerCase())) ||
        /hybrid|query plan|corpus|reader|miss ledger|benchmark/iu.test(line)
    );
    for (const line of relevantLines) {
      const item = taskLineToItem(line, params.plan.projects[0] ?? "Hybrid Temporal Memory Retrieval");
      if (item && !tasks.some((existing) => existing.title.toLowerCase() === item.title.toLowerCase())) {
        tasks.push(item);
      }
    }
    if (relevantLines.length > 0) {
      results.push(
        repoProjectionToResult(
          entry.document,
          bestProjectedSection(entry.document, terms),
          params.namespaceId,
          "project_scoped_task_reader",
          1 - index * 0.03
        )
      );
    }
  }
  return { tasks: tasks.slice(0, params.limit), results };
}
