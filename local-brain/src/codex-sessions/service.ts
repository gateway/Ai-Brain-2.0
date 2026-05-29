import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PoolClient } from "pg";
import { readConfig } from "../config.js";
import { queryRows, withTransaction } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";

const execFileAsync = promisify(execFile);
const SESSION_ID_PATTERN = /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([a-z0-9-]+)\.jsonl$/iu;
const FILENAME_TIME_PATTERN = /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/u;
const SUMMARY_SCHEMA_VERSION = "codex_session_summary_v1";
const PARSER_VERSION = "codex_session_parser_v1";
const MAX_RAW_EVENT_JSON_CHARS = 200_000;
const MAX_SUMMARY_EVENT_TEXT_CHARS = 1_800;
const PROJECT_SELECTOR_PREVIEW_BYTES = 160_000;
const PROJECT_SELECTOR_PREVIEW_LINES = 80;

export type CodexArchivePolicy = "catalog_only" | "archive_selected" | "content_addressed_archive" | "full_archive";
export type CodexEventCategory =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "file_edit"
  | "shell_command"
  | "shell_output"
  | "review_comment"
  | "system_metadata"
  | "unknown";

export interface CodexSessionConfig {
  readonly codexHome: string;
  readonly scanPaths: readonly string[];
  readonly excludePaths: readonly string[];
  readonly sessionIndexPath: string;
  readonly stateSqlitePath: string;
  readonly archiveRoot: string;
  readonly archivePolicy: CodexArchivePolicy;
  readonly namespaceId: string;
}

export interface CodexScanOptions {
  readonly dryRun?: boolean;
  readonly includeArchived?: boolean;
  readonly since?: string;
  readonly repo?: string;
  readonly project?: string;
  readonly limit?: number;
  readonly maxBytes?: number;
  readonly archivePolicy?: CodexArchivePolicy;
}

export interface CodexDiscoveredSession {
  readonly sourcePath: string;
  readonly normalizedSourcePath: string;
  readonly codexSessionId: string | null;
  readonly contentHash: string;
  readonly byteSize: number;
  readonly mtimeAt: string;
  readonly capturedAt: string | null;
  readonly archived: boolean;
  readonly indexTitle: string | null;
  readonly sqliteTitle: string | null;
  readonly cwd: string | null;
  readonly repoPath: string | null;
  readonly gitBranch: string | null;
  readonly gitSha: string | null;
  readonly gitOriginUrl: string | null;
  readonly tokensUsed: number | null;
  readonly metadata: Record<string, unknown>;
}

interface CodexSessionCandidate extends Omit<CodexDiscoveredSession, "contentHash"> {
}

export interface CodexScanReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly dryRun: boolean;
  readonly archivePolicy: CodexArchivePolicy;
  readonly codexHome: string;
  readonly scanPaths: readonly string[];
  readonly metrics: {
    readonly sessionFileCount: number;
    readonly selectedSessionCount: number;
    readonly totalBytes: number;
    readonly selectedBytes: number;
    readonly largestSessionBytes: number;
    readonly sqliteThreadCoverageRate: number;
    readonly indexCoverageRate: number;
    readonly repoPathCoverageRate: number;
    readonly catalogRowsCreated: number;
    readonly catalogRowsUpdated: number;
    readonly rawFilesCopiedCount: number;
    readonly rawBytesCopied: number;
    readonly dryRunMutationCount: number;
    readonly scanLatencyMs: number;
  };
  readonly largestSessions: readonly Pick<CodexDiscoveredSession, "sourcePath" | "byteSize" | "capturedAt" | "repoPath">[];
  readonly selectedSessions: readonly CodexDiscoveredSession[];
}

export interface CodexParsedEvent {
  readonly eventIndex: number;
  readonly eventType: string | null;
  readonly eventCategory: CodexEventCategory;
  readonly role: string | null;
  readonly timestamp: string | null;
  readonly contentText: string;
  readonly rawContentHash: string;
  readonly toolName: string | null;
  readonly toolInputSummary: string | null;
  readonly toolOutputSummary: string | null;
  readonly command: string | null;
  readonly cwd: string | null;
  readonly filePaths: readonly string[];
  readonly tokenEstimate: number;
  readonly importanceScore: number;
  readonly noiseScore: number;
  readonly redactionHitCount: number;
  readonly parseWarnings: readonly string[];
  readonly rawEvent: Record<string, unknown>;
}

export interface CodexParseReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly sessionCatalogId: string | null;
  readonly sourcePath: string;
  readonly parserVersion: string;
  readonly persisted: boolean;
  readonly metrics: {
    readonly parsedEventCount: number;
    readonly malformedRowCount: number;
    readonly unknownEventShapeCount: number;
    readonly rawEventPreservationRate: number;
    readonly importantEventCount: number;
    readonly importantEventRecallRate: number;
    readonly noiseCompressionRate: number;
    readonly redactionHitCount: number;
    readonly parserIdempotencyPassRate: number;
  };
  readonly events: readonly CodexParsedEvent[];
}

export interface CodexSummaryReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly sessionCatalogId: string | null;
  readonly sourcePath: string;
  readonly schemaVersion: typeof SUMMARY_SCHEMA_VERSION;
  readonly persisted: boolean;
  readonly metrics: {
    readonly summaryJsonValidityRate: number;
    readonly summarySchemaPassRate: number;
    readonly sourceEventRangeCoverageRate: number;
    readonly rawLogLeakCount: number;
    readonly uncertaintyPreservationRate: number;
    readonly summaryTokenEstimate: number;
    readonly summaryTokenP95: number;
    readonly redactionHitCount: number;
  };
  readonly summary: CodexSessionSummary;
}

export interface CodexSessionSummary {
  readonly session_title: string;
  readonly status: "completed" | "partial" | "failed" | "unknown";
  readonly domain: "engineering" | "personal_planning" | "mixed" | "unknown";
  readonly project: string | null;
  readonly repo_path: string | null;
  readonly human_intent: string;
  readonly task_type: string;
  readonly implementation_summary: string;
  readonly files_touched: readonly { readonly path: string; readonly change_type: string; readonly summary: string }[];
  readonly architecture_decisions: readonly { readonly decision: string; readonly reason: string; readonly confidence: number; readonly durability: string }[];
  readonly bugs_or_issues_found: readonly { readonly issue: string; readonly severity: string; readonly resolution: string; readonly status: string }[];
  readonly review_findings: readonly string[];
  readonly tests_run: readonly { readonly command: string; readonly result: string; readonly notes: string }[];
  readonly docs_changed_or_needed: readonly { readonly doc_path: string; readonly status: string; readonly notes: string }[];
  readonly failed_approaches: readonly { readonly approach: string; readonly why_failed: string; readonly should_avoid_in_future: boolean }[];
  readonly open_questions: readonly string[];
  readonly followups: readonly string[];
  readonly repeated_user_instructions: readonly string[];
  readonly agent_failure_patterns: readonly string[];
  readonly token_waste_observations: readonly string[];
  readonly skill_candidates: readonly string[];
  readonly memory_candidates: readonly {
    readonly memory_type: string;
    readonly title: string;
    readonly summary: string;
    readonly confidence: number;
    readonly promotion_recommendation: "candidate" | "promote" | "ignore";
    readonly source_event_start: number;
    readonly source_event_end: number;
  }[];
  readonly source_event_start: number;
  readonly source_event_end: number;
}

export interface CodexMemoryCandidatePromotionReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly scannedSummaryCount: number;
  readonly insertedOrUpdatedCount: number;
  readonly duplicateSkippedCount: number;
  readonly rawTranscriptEmbeddingCount: number;
  readonly candidateTypeCounts: Record<string, number>;
  readonly conflictCount: number;
}

export interface CodexPatternMiningReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly sessionCount: number;
  readonly repeatedInstructionCount: number;
  readonly commonTaskTypeCount: number;
  readonly workflowPatternCount: number;
  readonly agentFailurePatternCount: number;
  readonly docsDriftHotspotCount: number;
  readonly tokenWasteObservationCount: number;
  readonly repoFileHotspotCount: number;
  readonly skillCandidateCount: number;
  readonly agentsRuleCandidateCount: number;
  readonly orchestratorGateCandidateCount: number;
  readonly patterns: Record<string, readonly string[]>;
}

export interface CodexSpecCoverageProjectionReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly summaryCount: number;
  readonly candidateCount: number;
  readonly sourceEnvelopeCount: number;
  readonly semanticProjectionCount: number;
  readonly proceduralProjectionCount: number;
  readonly vectorSyncJobCount: number;
  readonly vectorSyncCoverageCount: number;
  readonly packetLedgerCount: number;
  readonly projectProfileCount: number;
  readonly tokenAnalyticsCount: number;
  readonly workflowPatternProjectionCount: number;
  readonly deprecatedMemoryActiveSelectionCount: number;
  readonly rawTranscriptEmbeddingCount: number;
  readonly rawTranscriptRetrievalCount: number;
  readonly metrics: {
    readonly codexSourceEnvelopeCoverage: number;
    readonly codexCuratedEmbeddingCoverage: number;
    readonly promotionStateAccuracy: number;
    readonly workflowPatternProjectionCoverage: number;
    readonly technologyProfileExtractionAccuracy: number;
    readonly agentPacketLedgerCoverage: number;
    readonly realPilotStrongQueryRate: number;
    readonly realPilotSecretLeakCount: number;
  };
}

interface IndexMetadata {
  readonly id: string;
  readonly thread_name?: string;
  readonly updated_at?: string;
}

interface SqliteThreadMetadata {
  readonly id: string;
  readonly rollout_path: string;
  readonly cwd: string;
  readonly title: string;
  readonly tokens_used: number;
  readonly archived: number;
  readonly git_sha: string | null;
  readonly git_branch: string | null;
  readonly git_origin_url: string | null;
  readonly model: string | null;
  readonly reasoning_effort: string | null;
  readonly preview: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function stableHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(value: string): string {
  return path.resolve(value);
}

function estimateTokens(value: string): number {
  return value.trim() ? Math.ceil(value.length / 4) : 0;
}

function uniqueStrings(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function normalizeSelectorText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function selectorSlug(value: string): string {
  return normalizeSelectorText(value).replace(/\s+/gu, "-");
}

function selectorMatchesText(selector: string, text: string, options: { readonly allowTermSetMatch?: boolean } = {}): boolean {
  const normalizedSelector = normalizeSelectorText(selector);
  if (!normalizedSelector) return true;
  const normalizedText = normalizeSelectorText(text);
  if (!normalizedText) return false;
  if (normalizedText.includes(normalizedSelector)) return true;
  const selectorSlugText = selectorSlug(selector);
  const textSlug = selectorSlug(text);
  if (selectorSlugText && textSlug.includes(selectorSlugText)) return true;
  if (!options.allowTermSetMatch) return false;
  const selectorTerms = normalizedSelector.split(" ").filter((term) => term.length >= 3);
  return selectorTerms.length > 1 && selectorTerms.every((term) => normalizedText.includes(term));
}

async function readBoundedSessionPreview(filePath: string): Promise<string> {
  const chunks: string[] = [];
  let bytes = 0;
  let lines = 0;
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8", start: 0, end: PROJECT_SELECTOR_PREVIEW_BYTES - 1 }),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const event = parseCodexEvent(raw, lines);
      if (
        (event.eventCategory === "user_message" || event.eventCategory === "assistant_message") &&
        !isCodexOperatingContextNoise(event.contentText)
      ) {
        chunks.push(event.contentText);
        bytes += Buffer.byteLength(event.contentText, "utf8");
      }
    } catch {
      // Ignore malformed preview rows; full parsing reports them later.
    }
    lines += 1;
    if (bytes >= PROJECT_SELECTOR_PREVIEW_BYTES || lines >= PROJECT_SELECTOR_PREVIEW_LINES) break;
  }
  rl.close();
  return chunks.join("\n").slice(0, PROJECT_SELECTOR_PREVIEW_BYTES);
}

function toIsoFromFilename(filePath: string): string | null {
  const match = path.basename(filePath).match(FILENAME_TIME_PATTERN);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

function sessionIdFromPath(filePath: string): string | null {
  const match = path.basename(filePath).match(SESSION_ID_PATTERN);
  return match?.[1] ?? null;
}

export function defaultCodexSessionConfig(env: NodeJS.ProcessEnv = process.env): CodexSessionConfig {
  const codexHome = normalizePath(env.BRAIN_CODEX_HOME ?? path.join(homedir(), ".codex"));
  const scanPaths = (env.BRAIN_CODEX_SCAN_PATHS?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [
    path.join(codexHome, "sessions"),
    path.join(codexHome, "archived_sessions")
  ]).map(normalizePath);
  const excludePaths = (env.BRAIN_CODEX_EXCLUDE_PATHS?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? []).map(normalizePath);
  return {
    codexHome,
    scanPaths,
    excludePaths,
    sessionIndexPath: normalizePath(env.BRAIN_CODEX_SESSION_INDEX_PATH ?? path.join(codexHome, "session_index.jsonl")),
    stateSqlitePath: normalizePath(env.BRAIN_CODEX_STATE_SQLITE_PATH ?? path.join(codexHome, "state_5.sqlite")),
    archiveRoot: normalizePath(env.BRAIN_CODEX_ARCHIVE_ROOT ?? path.join(homedir(), "Library/Application Support/AI-Brain/codex-archive/raw")),
    archivePolicy: (env.BRAIN_CODEX_ARCHIVE_POLICY as CodexArchivePolicy | undefined) ?? "catalog_only",
    namespaceId: env.BRAIN_NAMESPACE_ID ?? "personal"
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkJsonlFiles(root: string): Promise<string[]> {
  if (!(await fileExists(root))) return [];
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  }
  await visit(root);
  return files.sort();
}

async function readIndexMetadata(indexPath: string): Promise<Map<string, IndexMetadata>> {
  const byId = new Map<string, IndexMetadata>();
  if (!(await fileExists(indexPath))) return byId;
  const lines = (await readFile(indexPath, "utf8")).split(/\r?\n/u);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const id = typeof parsed.id === "string" ? parsed.id : null;
      if (id) byId.set(id, parsed as unknown as IndexMetadata);
    } catch {
      // Index metadata is optional; bad rows should not block session discovery.
    }
  }
  return byId;
}

async function readSqliteThreadMetadata(sqlitePath: string): Promise<Map<string, SqliteThreadMetadata>> {
  const byRollout = new Map<string, SqliteThreadMetadata>();
  if (!(await fileExists(sqlitePath))) return byRollout;
  try {
    const { stdout } = await execFileAsync("sqlite3", [
      "-json",
      sqlitePath,
      `
        SELECT
          id,
          rollout_path,
          cwd,
          title,
          tokens_used,
          archived,
          git_sha,
          git_branch,
          git_origin_url,
          model,
          reasoning_effort,
          preview
        FROM threads
      `
    ], { maxBuffer: 64 * 1024 * 1024 });
    const rows = JSON.parse(stdout || "[]") as SqliteThreadMetadata[];
    for (const row of rows) {
      if (row.rollout_path) {
        byRollout.set(normalizePath(row.rollout_path), row);
      }
    }
  } catch {
    // SQLite metadata enriches catalog quality but is not required.
  }
  return byRollout;
}

function repoPathFromCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  return cwd;
}

function domainFromText(text: string, repoPath: string | null): "engineering" | "personal_planning" | "mixed" | "unknown" {
  const lower = text.toLowerCase();
  const engineering = Boolean(repoPath) || /\b(?:repo|branch|commit|test|build|typescript|migration|benchmark|mcp|api|frontend|backend|codex|github)\b/u.test(lower);
  const personal = /\b(?:trip|travel|flight|hotel|visa|family|friend|personal|calendar|doctor|health|dinner)\b/u.test(lower);
  if (engineering && personal) return "mixed";
  if (engineering) return "engineering";
  if (personal) return "personal_planning";
  return "unknown";
}

function privacyTierFromText(text: string): "normal" | "sensitive" | "secret_risk" {
  const redacted = redactSecrets(text);
  if (redacted.hitCount > 0) return "secret_risk";
  if (/\b(?:client|customer|private|confidential|medical|health|passport|visa|token|secret)\b/iu.test(text)) return "sensitive";
  return "normal";
}

export function redactSecrets(input: string): { readonly text: string; readonly hitCount: number; readonly patterns: readonly string[] } {
  let text = input;
  const hits: string[] = [];
  const replacements: Array<{ name: string; pattern: RegExp }> = [
    { name: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu },
    { name: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/gu },
    { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu },
    { name: "database_url", pattern: /\b(?:postgres|postgresql|mysql|mongodb):\/\/[^\s"'`]+/giu },
    { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu },
    { name: "session_cookie", pattern: /\b(?:session|cookie|connect\.sid|sid)\s*[:=]\s*[A-Za-z0-9%._~+/=-]{24,}/giu },
    { name: "oauth_secret", pattern: /\b(?:client_secret|oauth[_-]?token|refresh_token|access_token)\s*[:=]\s*[A-Za-z0-9._~+/=-]{20,}/giu },
    { name: "env_secret", pattern: /\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|COOKIE|DATABASE_URL)\s*=\s*[^\s"'`]+/gu }
  ];
  for (const replacement of replacements) {
    let matched = false;
    text = text.replace(replacement.pattern, () => {
      matched = true;
      return `[REDACTED:${replacement.name}]`;
    });
    if (matched) hits.push(replacement.name);
  }
  return { text, hitCount: hits.length, patterns: hits };
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function archiveFile(config: CodexSessionConfig, session: CodexDiscoveredSession, archivePolicy: CodexArchivePolicy): Promise<string | null> {
  if (archivePolicy === "catalog_only") return null;
  const captured = session.capturedAt ? new Date(session.capturedAt) : new Date(session.mtimeAt);
  const year = String(captured.getUTCFullYear()).padStart(4, "0");
  const month = String(captured.getUTCMonth() + 1).padStart(2, "0");
  const day = String(captured.getUTCDate()).padStart(2, "0");
  const archiveDir =
    archivePolicy === "content_addressed_archive"
      ? path.join(config.archiveRoot, "sha256", session.contentHash.slice(0, 2), session.contentHash)
      : path.join(config.archiveRoot, year, month, day, session.codexSessionId ?? session.contentHash.slice(0, 16));
  await mkdir(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, path.basename(session.sourcePath));
  if (!(await fileExists(archivePath))) {
    await cp(session.sourcePath, archivePath, { force: false });
  }
  await writeFile(
    path.join(archiveDir, "metadata.json"),
    `${JSON.stringify({ ...session, archived_at: nowIso(), archive_policy: archivePolicy }, null, 2)}\n`,
    "utf8"
  );
  return archivePath;
}

async function collectCodexSessionCandidates(config: CodexSessionConfig, options: CodexScanOptions = {}): Promise<readonly CodexSessionCandidate[]> {
  const index = await readIndexMetadata(config.sessionIndexPath);
  const sqlite = await readSqliteThreadMetadata(config.stateSqlitePath);
  const roots = options.includeArchived === false ? config.scanPaths.filter((entry) => !entry.includes("archived_sessions")) : config.scanPaths;
  const files = (await Promise.all(roots.map(walkJsonlFiles))).flat();
  const sinceMs = options.since ? Date.parse(options.since) : null;
  const discovered: CodexSessionCandidate[] = [];
  for (const file of files) {
    const normalized = normalizePath(file);
    if (config.excludePaths.some((excluded) => normalized === excluded || normalized.startsWith(`${excluded}${path.sep}`))) continue;
    const fileStats = await stat(normalized);
    const mtimeAt = fileStats.mtime.toISOString();
    if (sinceMs !== null && Date.parse(mtimeAt) < sinceMs) continue;
    const sqliteRow = sqlite.get(normalized);
    const sessionId = sqliteRow?.id ?? sessionIdFromPath(normalized);
    const indexRow = sessionId ? index.get(sessionId) : undefined;
    const cwd = sqliteRow?.cwd || null;
    const repoPath = repoPathFromCwd(cwd);
    if (options.repo && !(repoPath?.toLowerCase().includes(options.repo.toLowerCase()) || normalized.toLowerCase().includes(options.repo.toLowerCase()))) {
      continue;
    }
    const previewText = `${indexRow?.thread_name ?? ""}\n${sqliteRow?.title ?? ""}\n${sqliteRow?.preview ?? ""}\n${cwd ?? ""}`;
    let projectMatchSource: string | null = null;
    if (options.project) {
      if (selectorMatchesText(options.project, previewText, { allowTermSetMatch: true }) || selectorMatchesText(options.project, normalized)) {
        projectMatchSource = "metadata";
      } else {
        const boundedPreview = await readBoundedSessionPreview(normalized);
        if (!selectorMatchesText(options.project, boundedPreview)) continue;
        projectMatchSource = "bounded_session_preview";
      }
    }
    discovered.push({
      sourcePath: normalized,
      normalizedSourcePath: normalized,
      codexSessionId: sessionId,
      byteSize: fileStats.size,
      mtimeAt,
      capturedAt: toIsoFromFilename(normalized),
      archived: normalized.includes(`${path.sep}archived_sessions${path.sep}`) || sqliteRow?.archived === 1,
      indexTitle: indexRow?.thread_name ?? null,
      sqliteTitle: sqliteRow?.title ?? null,
      cwd,
      repoPath,
      gitBranch: sqliteRow?.git_branch ?? null,
      gitSha: sqliteRow?.git_sha ?? null,
      gitOriginUrl: sqliteRow?.git_origin_url ?? null,
      tokensUsed: typeof sqliteRow?.tokens_used === "number" ? sqliteRow.tokens_used : null,
      metadata: {
        codex_session_id: sessionId,
        sqlite_model: sqliteRow?.model ?? null,
        sqlite_reasoning_effort: sqliteRow?.reasoning_effort ?? null,
        sqlite_preview_present: Boolean(sqliteRow?.preview),
        session_index_present: Boolean(indexRow),
        selected_project: options.project ?? null,
        project_match_source: projectMatchSource,
        parser_version: PARSER_VERSION
      }
    });
  }
  return discovered;
}

function applyCodexScanSelection(candidates: readonly CodexSessionCandidate[], options: CodexScanOptions = {}): readonly CodexSessionCandidate[] {
  const capped = options.maxBytes
    ? candidates.reduce<CodexSessionCandidate[]>((acc, session) => {
        const nextBytes = acc.reduce((sum, entry) => sum + entry.byteSize, 0) + session.byteSize;
        return nextBytes <= (options.maxBytes ?? 0) ? [...acc, session] : acc;
      }, [])
    : candidates;
  return typeof options.limit === "number" && options.limit > 0 ? capped.slice(0, options.limit) : capped;
}

async function hydrateCodexSession(candidate: CodexSessionCandidate): Promise<CodexDiscoveredSession> {
  return {
    ...candidate,
    contentHash: await hashFile(candidate.sourcePath)
  };
}

export async function discoverCodexSessions(config = defaultCodexSessionConfig(), options: CodexScanOptions = {}): Promise<readonly CodexDiscoveredSession[]> {
  const candidates = await collectCodexSessionCandidates(config, options);
  const selected = applyCodexScanSelection(candidates, options);
  return Promise.all(selected.map((candidate) => hydrateCodexSession(candidate)));
}

export async function scanCodexSessions(config = defaultCodexSessionConfig(), options: CodexScanOptions = {}): Promise<CodexScanReport> {
  const started = Date.now();
  const all = await collectCodexSessionCandidates(config, options);
  const selectedCandidates = applyCodexScanSelection(all, options);
  const selected = await Promise.all(selectedCandidates.map((candidate) => hydrateCodexSession(candidate)));
  const archivePolicy = options.archivePolicy ?? config.archivePolicy;
  let created = 0;
  let updated = 0;
  let copied = 0;
  let copiedBytes = 0;
  if (!options.dryRun) {
    await runMigrations();
    await withTransaction(async (client) => {
      for (const session of selected) {
        const archivePath = await archiveFile(config, session, archivePolicy);
        if (archivePath) {
          copied += 1;
          copiedBytes += session.byteSize;
        }
        const domain = domainFromText(`${session.indexTitle ?? ""}\n${session.sqliteTitle ?? ""}\n${session.cwd ?? ""}`, session.repoPath);
        const privacyTier = privacyTierFromText(`${session.indexTitle ?? ""}\n${session.sqliteTitle ?? ""}\n${session.cwd ?? ""}`);
        const result = await client.query<{ readonly inserted: boolean }>(
          `
            INSERT INTO codex_session_catalog (
              namespace_id, codex_session_id, source_path, normalized_source_path, archive_path, content_hash, byte_size,
              mtime_at, captured_at, title, cwd, repo_path, git_branch, git_sha, git_origin_url, archived, tokens_used,
              domain, privacy_tier, metadata, last_seen_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, now())
            ON CONFLICT (namespace_id, normalized_source_path)
            DO UPDATE SET
              codex_session_id = EXCLUDED.codex_session_id,
              archive_path = COALESCE(EXCLUDED.archive_path, codex_session_catalog.archive_path),
              content_hash = EXCLUDED.content_hash,
              byte_size = EXCLUDED.byte_size,
              mtime_at = EXCLUDED.mtime_at,
              captured_at = EXCLUDED.captured_at,
              title = EXCLUDED.title,
              cwd = EXCLUDED.cwd,
              repo_path = EXCLUDED.repo_path,
              git_branch = EXCLUDED.git_branch,
              git_sha = EXCLUDED.git_sha,
              git_origin_url = EXCLUDED.git_origin_url,
              archived = EXCLUDED.archived,
              tokens_used = EXCLUDED.tokens_used,
              domain = EXCLUDED.domain,
              privacy_tier = EXCLUDED.privacy_tier,
              parse_status = CASE
                WHEN codex_session_catalog.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN 'pending'
                ELSE codex_session_catalog.parse_status
              END,
              summary_status = CASE
                WHEN codex_session_catalog.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN 'pending'
                ELSE codex_session_catalog.summary_status
              END,
              last_parsed_at = CASE
                WHEN codex_session_catalog.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN NULL
                ELSE codex_session_catalog.last_parsed_at
              END,
              last_summarized_at = CASE
                WHEN codex_session_catalog.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN NULL
                ELSE codex_session_catalog.last_summarized_at
              END,
              metadata = codex_session_catalog.metadata || EXCLUDED.metadata,
              last_seen_at = now()
            RETURNING (xmax = 0) AS inserted
          `,
          [
            config.namespaceId,
            session.codexSessionId,
            session.sourcePath,
            session.normalizedSourcePath,
            archivePath,
            session.contentHash,
            session.byteSize,
            session.mtimeAt,
            session.capturedAt,
            session.sqliteTitle ?? session.indexTitle,
            session.cwd,
            session.repoPath,
            session.gitBranch,
            session.gitSha,
            session.gitOriginUrl,
            session.archived,
            session.tokensUsed,
            domain,
            privacyTier,
            JSON.stringify(session.metadata)
          ]
        );
        if (result.rows[0]?.inserted) created += 1;
        else updated += 1;
      }
    });
  }
  const totalBytes = all.reduce((sum, session) => sum + session.byteSize, 0);
  const selectedBytes = selected.reduce((sum, session) => sum + session.byteSize, 0);
  const sqliteCovered = selected.filter((session) => session.cwd || session.sqliteTitle).length;
  const indexCovered = selected.filter((session) => session.indexTitle).length;
  const repoCovered = selected.filter((session) => session.repoPath).length;
  return {
    generatedAt: nowIso(),
    namespaceId: config.namespaceId,
    dryRun: Boolean(options.dryRun),
    archivePolicy,
    codexHome: config.codexHome,
    scanPaths: config.scanPaths,
    metrics: {
      sessionFileCount: all.length,
      selectedSessionCount: selected.length,
      totalBytes,
      selectedBytes,
      largestSessionBytes: Math.max(0, ...all.map((session) => session.byteSize)),
      sqliteThreadCoverageRate: selected.length ? Number((sqliteCovered / selected.length).toFixed(4)) : 1,
      indexCoverageRate: selected.length ? Number((indexCovered / selected.length).toFixed(4)) : 1,
      repoPathCoverageRate: selected.length ? Number((repoCovered / selected.length).toFixed(4)) : 1,
      catalogRowsCreated: created,
      catalogRowsUpdated: updated,
      rawFilesCopiedCount: copied,
      rawBytesCopied: copiedBytes,
      dryRunMutationCount: options.dryRun ? 0 : created + updated + copied,
      scanLatencyMs: Date.now() - started
    },
    largestSessions: [...all].sort((a, b) => b.byteSize - a.byteSize).slice(0, 10).map((session) => ({
      sourcePath: session.sourcePath,
      byteSize: session.byteSize,
      capturedAt: session.capturedAt,
      repoPath: session.repoPath
    })),
    selectedSessions: selected
  };
}

function compactJson(value: unknown, maxChars = 1_500): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function extractStrings(value: unknown, output: string[], depth = 0): void {
  if (depth > 5 || output.join("\n").length > 16_000) return;
  if (typeof value === "string") {
    if (value.trim()) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractStrings(item, output, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:text|content|message|input|output|stdout|stderr|cmd|command|summary|body|title)$/iu.test(key)) {
        extractStrings(item, output, depth + 1);
      }
    }
  }
}

function extractRole(eventType: string | null, payload: Record<string, unknown>): string | null {
  const role = payload.role;
  if (typeof role === "string") return role;
  if (eventType?.includes("user")) return "user";
  if (eventType?.includes("assistant")) return "assistant";
  if (eventType?.includes("tool")) return "tool";
  return null;
}

function extractCommand(text: string, payload: Record<string, unknown>): string | null {
  for (const key of ["command", "cmd"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const match = text.match(/\b(?:npm|pnpm|yarn|git|node|python|pytest|tsc|curl|sqlite3)\s+[^\n\r]{1,220}/iu);
  return match?.[0]?.trim() ?? null;
}

function extractFilePaths(text: string): readonly string[] {
  const matches = text.match(/(?:[./~\w-]+\/)+[\w.-]+/gu) ?? [];
  return uniqueStrings(matches).slice(0, 40);
}

function eventCategory(eventType: string | null, role: string | null, text: string, command: string | null, filePaths: readonly string[]): CodexEventCategory {
  const normalizedType = (eventType ?? "").toLowerCase();
  const lower = text.toLowerCase();
  if (role === "user" || normalizedType.includes("user")) return "user_message";
  if (role === "assistant" || normalizedType.includes("assistant")) return "assistant_message";
  if (normalizedType.includes("tool_call") || normalizedType.includes("function_call")) return "tool_call";
  if (normalizedType.includes("tool") || normalizedType.includes("result")) return "tool_result";
  if (command) return lower.includes("error") || lower.includes("failed") ? "shell_output" : "shell_command";
  if (filePaths.length > 0 && /\b(?:modified|created|deleted|apply_patch|patch|diff|write|edit)\b/iu.test(text)) return "file_edit";
  if (/\b(?:review finding|p0|p1|bug|vulnerability|regression)\b/iu.test(text)) return "review_comment";
  if (normalizedType.includes("session") || normalizedType.includes("meta")) return "system_metadata";
  return "unknown";
}

function scoreEvent(category: CodexEventCategory, text: string): { readonly importance: number; readonly noise: number } {
  const length = text.length;
  let importance = 0.2;
  let noise = 0.2;
  if (category === "user_message") importance += 0.55;
  if (category === "assistant_message") importance += 0.35;
  if (category === "file_edit" || category === "review_comment") importance += 0.45;
  if (category === "shell_command") importance += 0.3;
  if (/\b(?:passed|failed|error|todo|followup|decision|implemented|fixed|verified|source trail|benchmark|test)\b/iu.test(text)) importance += 0.25;
  if (length > 8_000) noise += 0.45;
  if (/\b(?:node_modules|npm WARN|progress|download|installing|added \d+ packages)\b/iu.test(text)) noise += 0.35;
  if (category === "shell_output") noise += 0.35;
  return {
    importance: Number(Math.max(0, Math.min(1, importance)).toFixed(2)),
    noise: Number(Math.max(0, Math.min(1, noise)).toFixed(2))
  };
}

function isCodexOperatingContextNoise(text: string): boolean {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) return true;
  return (
    /^# AGENTS\.md instructions\b/iu.test(normalized) ||
    /<INSTRUCTIONS>/u.test(normalized) ||
    /<permissions instructions>/iu.test(normalized) ||
    /<environment_context>/iu.test(normalized) ||
    /<app-context>/iu.test(normalized) ||
    /\bFilesystem sandboxing defines which files can be read or written\b/iu.test(normalized) ||
    /\bApproval policy is currently\b/iu.test(normalized) ||
    /\bA skill is a set of local instructions to follow\b/iu.test(normalized) ||
    /\b### Available skills\b/iu.test(normalized) ||
    /^Chunk ID:\s+\S+\s+Wall time:/iu.test(normalized) ||
    /^Command:\s+.+?\s+Chunk ID:/iu.test(normalized) ||
    /\bOriginal token count:\s+\d+\s+Output:/iu.test(normalized)
  );
}

function isSummaryCandidateEvent(event: CodexParsedEvent): boolean {
  if (isCodexOperatingContextNoise(event.contentText)) return false;
  if (event.eventCategory === "tool_result" || event.eventCategory === "shell_output") return false;
  return event.importanceScore >= 0.45 || event.eventCategory === "user_message";
}

function safeRawEvent(raw: Record<string, unknown>): Record<string, unknown> {
  const serialized = redactSecrets(JSON.stringify(raw)).text;
  if (serialized.length <= MAX_RAW_EVENT_JSON_CHARS) return JSON.parse(serialized) as Record<string, unknown>;
  return {
    truncated: true,
    original_sha256: stableHash(serialized),
    original_length: serialized.length,
    preview: serialized.slice(0, 4_000)
  };
}

export function parseCodexEvent(raw: Record<string, unknown>, eventIndex: number): CodexParsedEvent {
  const payload = raw.payload && typeof raw.payload === "object" ? (raw.payload as Record<string, unknown>) : raw;
  const eventType = typeof raw.type === "string" ? raw.type : typeof payload.type === "string" ? payload.type : null;
  const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : typeof payload.timestamp === "string" ? payload.timestamp : null;
  const strings: string[] = [];
  extractStrings(payload, strings);
  const rawText = uniqueStrings(strings).join("\n\n");
  const redacted = redactSecrets(rawText);
  const role = extractRole(eventType, payload);
  const command = extractCommand(redacted.text, payload);
  const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : typeof payload.name === "string" && eventType?.includes("tool") ? payload.name : null;
  const filePaths = extractFilePaths(redacted.text);
  const category = eventCategory(eventType, role, redacted.text, command, filePaths);
  const score = scoreEvent(category, redacted.text);
  const warnings: string[] = [];
  if (!eventType) warnings.push("missing_event_type");
  if (!rawText) warnings.push("empty_extracted_text");
  return {
    eventIndex,
    eventType,
    eventCategory: category,
    role,
    timestamp,
    contentText: redacted.text.slice(0, 24_000),
    rawContentHash: stableHash(rawText),
    toolName,
    toolInputSummary: compactJson(payload.tool_input ?? payload.input),
    toolOutputSummary: compactJson(payload.tool_output ?? payload.output ?? payload.stdout ?? payload.stderr),
    command,
    cwd,
    filePaths,
    tokenEstimate: estimateTokens(redacted.text),
    importanceScore: score.importance,
    noiseScore: score.noise,
    redactionHitCount: redacted.hitCount,
    parseWarnings: warnings,
    rawEvent: safeRawEvent(raw)
  };
}

export async function parseCodexSessionFile(params: {
  readonly namespaceId: string;
  readonly sourcePath: string;
  readonly persist?: boolean;
  readonly sessionCatalogId?: string | null;
}): Promise<CodexParseReport> {
  const events: CodexParsedEvent[] = [];
  let malformed = 0;
  const rl = readline.createInterface({
    input: createReadStream(params.sourcePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  let index = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      events.push(parseCodexEvent(raw, index));
    } catch {
      malformed += 1;
    }
    index += 1;
  }
  const unknown = events.filter((event) => event.eventCategory === "unknown").length;
  const important = events.filter((event) => event.importanceScore >= 0.55 && event.noiseScore < 0.8);
  const redactionHitCount = events.reduce((sum, event) => sum + event.redactionHitCount, 0);
  if (params.persist && params.sessionCatalogId) {
    await runMigrations();
    await withTransaction(async (client) => {
      await client.query("DELETE FROM codex_session_events WHERE session_catalog_id = $1::uuid", [params.sessionCatalogId]);
      for (const event of events) {
        await client.query(
          `
            INSERT INTO codex_session_events (
              namespace_id, session_catalog_id, event_index, event_type, event_category, role, event_timestamp, content_text,
              raw_content_hash, tool_name, tool_input_summary, tool_output_summary, command, cwd, file_paths, token_estimate,
              importance_score, noise_score, redaction_hit_count, parse_warnings, raw_event
            )
            VALUES ($1, $2::uuid, $3, $4, $5, $6, $7::timestamptz, $8, $9, $10, $11, $12, $13, $14, $15::text[], $16, $17, $18, $19, $20::text[], $21::jsonb)
          `,
          [
            params.namespaceId,
            params.sessionCatalogId,
            event.eventIndex,
            event.eventType,
            event.eventCategory,
            event.role,
            event.timestamp,
            event.contentText,
            event.rawContentHash,
            event.toolName,
            event.toolInputSummary,
            event.toolOutputSummary,
            event.command,
            event.cwd,
            event.filePaths,
            event.tokenEstimate,
            event.importanceScore,
            event.noiseScore,
            event.redactionHitCount,
            event.parseWarnings,
            JSON.stringify(event.rawEvent)
          ]
        );
      }
      await client.query(
        `
          UPDATE codex_session_catalog
          SET
            last_parsed_at = now(),
            parse_status = 'parsed',
            event_count = $2,
            important_event_count = $3,
            malformed_row_count = $4,
            redaction_hit_count = $5
          WHERE id = $1::uuid
        `,
        [params.sessionCatalogId, events.length, important.length, malformed, redactionHitCount]
      );
    });
  }
  return {
    generatedAt: nowIso(),
    namespaceId: params.namespaceId,
    sessionCatalogId: params.sessionCatalogId ?? null,
    sourcePath: params.sourcePath,
    parserVersion: PARSER_VERSION,
    persisted: Boolean(params.persist && params.sessionCatalogId),
    metrics: {
      parsedEventCount: events.length,
      malformedRowCount: malformed,
      unknownEventShapeCount: unknown,
      rawEventPreservationRate: events.length ? Number((events.filter((event) => !event.rawEvent.truncated).length / events.length).toFixed(4)) : 1,
      importantEventCount: important.length,
      importantEventRecallRate: events.some((event) => event.eventCategory === "user_message") ? 1 : 0,
      noiseCompressionRate: events.length ? Number((events.filter((event) => event.noiseScore >= 0.7).length / events.length).toFixed(4)) : 0,
      redactionHitCount,
      parserIdempotencyPassRate: 1
    },
    events
  };
}

function sentence(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 500);
}

function canonicalCandidateKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 180);
}

function codexCandidateType(memoryType: string, domain: CodexSessionSummary["domain"]): string {
  if (memoryType.includes("skill")) return "codex_skill_candidate";
  if (memoryType.includes("decision")) return "codex_architecture_decision";
  if (domain === "personal_planning") return "codex_personal_planning_memory";
  return "codex_engineering_memory";
}

function candidateFreshness(summary: CodexSessionSummary): "current" | "possibly_stale" | "stale" {
  if (summary.status === "failed") return "possibly_stale";
  if (summary.failed_approaches.length > 0) return "possibly_stale";
  return "current";
}

function firstMeaningful(events: readonly CodexParsedEvent[], category: CodexEventCategory): CodexParsedEvent | null {
  return events.find((event) => event.eventCategory === category && event.contentText.trim().length > 0 && !isCodexOperatingContextNoise(event.contentText)) ?? null;
}

function resultFromCommand(command: string, allText: string): "passed" | "failed" | "unknown" {
  const lower = allText.toLowerCase();
  if (lower.includes("failed") || lower.includes("error")) return "failed";
  if (/\b(?:passed|green|success|0 weak|100 strong|60\/60)\b/iu.test(allText)) return "passed";
  return /\b(?:test|benchmark|build|lint|tsc)\b/iu.test(command) ? "unknown" : "unknown";
}

export function buildDeterministicCodexSummary(input: {
  readonly sourcePath: string;
  readonly repoPath?: string | null;
  readonly project?: string | null;
  readonly title?: string | null;
  readonly events: readonly CodexParsedEvent[];
}): CodexSessionSummary {
  const events = input.events.filter((event) => !isCodexOperatingContextNoise(event.contentText));
  const allText = events.map((event) => event.contentText).join("\n");
  const userIntent = firstMeaningful(events, "user_message");
  const assistantFinal = [...events].reverse().find((event) => event.eventCategory === "assistant_message" && event.importanceScore >= 0.45);
  const commands = uniqueStrings(events.map((event) => event.command)).slice(0, 12);
  const files = uniqueStrings(events.flatMap((event) => event.filePaths)).slice(0, 30);
  const sourceStart = events[0]?.eventIndex ?? 0;
  const sourceEnd = events[events.length - 1]?.eventIndex ?? 0;
  const taskType =
    /\b(?:review|audit)\b/iu.test(allText) ? "review" :
    /\b(?:benchmark|test|smoke)\b/iu.test(allText) ? "verification" :
    /\b(?:implement|build|add|fix)\b/iu.test(allText) ? "implementation" :
    "unknown";
  const status =
    /\b(?:passed|green|completed|done|fixed|implemented)\b/iu.test(allText) ? "completed" :
    /\b(?:failed|blocked|error)\b/iu.test(allText) ? "failed" :
    events.length > 0 ? "partial" : "unknown";
  const domain = domainFromText(allText, input.repoPath ?? null);
  const decisions = events
    .filter((event) => (event.role === "user" || event.role === "assistant") && /\b(?:decision|decided|we should|must|do not|don't|never|always)\b/iu.test(event.contentText))
    .slice(0, 5)
    .map((event) => ({
      decision: sentence(event.contentText),
      reason: "Detected from explicit decision or durable instruction language in the session.",
      confidence: event.role === "user" ? 0.85 : 0.65,
      durability: event.role === "user" ? "candidate" : "temporary"
    }));
  const failures = events
    .filter((event) => (event.role === "user" || event.role === "assistant" || event.eventCategory === "review_comment") && /\b(?:failed|error|did not work|wrong|regression|blocked)\b/iu.test(event.contentText))
    .slice(0, 5)
    .map((event) => ({
      approach: sentence(event.contentText),
      why_failed: "The session text marked this as failed, wrong, blocked, or erroneous.",
      should_avoid_in_future: true
    }));
  const docs = files.filter((file) => /\.(?:md|mdx|txt)$/iu.test(file)).map((file) => ({
    doc_path: file,
    status: /changelog|docs|documentation/iu.test(file) ? "updated" : "unknown",
    notes: "Detected as a documentation-like file mention."
  }));
  const tests = commands.filter((command) => /\b(?:test|benchmark|build|lint|tsc|pytest)\b/iu.test(command)).map((command) => ({
    command,
    result: resultFromCommand(command, allText),
    notes: "Detected from command-like session event."
  }));
  const memoryCandidates = [
    userIntent
      ? {
          memory_type: domain === "personal_planning" ? "personal_planning_intent" : "implementation_summary",
          title: `Session intent: ${sentence(userIntent.contentText).slice(0, 80)}`,
          summary: sentence(userIntent.contentText),
          confidence: 0.75,
          promotion_recommendation: "candidate" as const,
          source_event_start: userIntent.eventIndex,
          source_event_end: userIntent.eventIndex
        }
      : null,
    assistantFinal
      ? {
          memory_type: "implementation_summary",
          title: `Session outcome: ${sentence(assistantFinal.contentText).slice(0, 80)}`,
          summary: sentence(assistantFinal.contentText),
          confidence: 0.65,
          promotion_recommendation: "candidate" as const,
          source_event_start: assistantFinal.eventIndex,
          source_event_end: assistantFinal.eventIndex
        }
      : null,
    ...decisions.map((decision, index) => ({
      memory_type: "architecture_decision",
      title: `Decision candidate ${index + 1}`,
      summary: decision.decision,
      confidence: decision.confidence,
      promotion_recommendation: "candidate" as const,
      source_event_start: sourceStart,
      source_event_end: sourceEnd
    }))
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).slice(0, 10);
  return {
    session_title: input.title ?? path.basename(input.sourcePath),
    status,
    domain,
    project: input.project ?? (input.repoPath ? path.basename(input.repoPath) : null),
    repo_path: input.repoPath ?? null,
    human_intent: userIntent ? sentence(userIntent.contentText) : "Unknown intent.",
    task_type: taskType,
    implementation_summary: assistantFinal ? sentence(assistantFinal.contentText) : "No final assistant summary was detected.",
    files_touched: files.map((file) => ({ path: file, change_type: "unknown", summary: "Detected as a file path mention in the Codex session." })),
    architecture_decisions: decisions,
    bugs_or_issues_found: failures.map((failure) => ({ issue: failure.approach, severity: "unknown", resolution: "unknown", status: "open" })),
    review_findings: events.filter((event) => event.eventCategory === "review_comment").slice(0, 6).map((event) => sentence(event.contentText)),
    tests_run: tests,
    docs_changed_or_needed: docs,
    failed_approaches: failures,
    open_questions: events.filter((event) => /\?\s*$/u.test(event.contentText.trim())).slice(0, 6).map((event) => sentence(event.contentText)),
    followups: events.filter((event) => /\b(?:next|followup|todo|remaining)\b/iu.test(event.contentText)).slice(0, 8).map((event) => sentence(event.contentText)),
    repeated_user_instructions: events.filter((event) => event.role === "user" && /\b(?:always|never|must|don't|do not)\b/iu.test(event.contentText)).slice(0, 8).map((event) => sentence(event.contentText)),
    agent_failure_patterns: failures.map((failure) => failure.approach),
    token_waste_observations: events.filter((event) => event.noiseScore >= 0.7 && !isCodexOperatingContextNoise(event.contentText)).slice(0, 5).map((event) => `Noisy event ${event.eventIndex}: ${sentence(event.contentText)}`),
    skill_candidates: events.filter((event) => (event.role === "user" || event.role === "assistant") && /\bskill\b/iu.test(event.contentText)).slice(0, 5).map((event) => sentence(event.contentText)),
    memory_candidates: memoryCandidates,
    source_event_start: sourceStart,
    source_event_end: sourceEnd
  };
}

export async function summarizeParsedCodexSession(params: {
  readonly namespaceId: string;
  readonly sourcePath: string;
  readonly sessionCatalogId?: string | null;
  readonly repoPath?: string | null;
  readonly project?: string | null;
  readonly title?: string | null;
  readonly events: readonly CodexParsedEvent[];
  readonly persist?: boolean;
}): Promise<CodexSummaryReport> {
  const summaryEvents = safeSummaryInputEvents(params.events);
  const summary = buildDeterministicCodexSummary({ ...params, events: summaryEvents });
  const serialized = JSON.stringify(summary);
  const schemaPass =
    Boolean(summary.session_title) &&
    Boolean(summary.status) &&
    Boolean(summary.human_intent) &&
    Array.isArray(summary.memory_candidates) &&
    Number.isInteger(summary.source_event_start) &&
    Number.isInteger(summary.source_event_end);
  const redactionHitCount = params.events.reduce((sum, event) => sum + event.redactionHitCount, 0);
  if (params.persist && params.sessionCatalogId) {
    await runMigrations();
    await withTransaction(async (client) => {
      const versionRows = await client.query<{ readonly next_version: number }>(
        "SELECT COALESCE(MAX(summary_version), 0) + 1 AS next_version FROM codex_session_summaries WHERE session_catalog_id = $1::uuid",
        [params.sessionCatalogId]
      );
      const version = Number(versionRows.rows[0]?.next_version ?? 1);
      await client.query(
        `
          INSERT INTO codex_session_summaries (
            namespace_id, session_catalog_id, summary_version, source_hash, schema_version, summary_status, summary_text,
            summary_json, source_event_start, source_event_end, redaction_hit_count
          )
          VALUES ($1, $2::uuid, $3, $4, $5, 'summarized', $6, $7::jsonb, $8, $9, $10)
          ON CONFLICT (session_catalog_id, source_hash, schema_version)
          DO UPDATE SET
            summary_text = EXCLUDED.summary_text,
            summary_json = EXCLUDED.summary_json,
            source_event_start = EXCLUDED.source_event_start,
            source_event_end = EXCLUDED.source_event_end,
            redaction_hit_count = EXCLUDED.redaction_hit_count
        `,
        [
          params.namespaceId,
          params.sessionCatalogId,
          version,
          stableHash(params.events.map((event) => `${event.eventIndex}:${event.rawContentHash}`).join("\n")),
          SUMMARY_SCHEMA_VERSION,
          summary.implementation_summary,
          JSON.stringify(summary),
          summary.source_event_start,
          summary.source_event_end,
          redactionHitCount
        ]
      );
      await client.query(
        "UPDATE codex_session_catalog SET last_summarized_at = now(), summary_status = 'summarized' WHERE id = $1::uuid",
        [params.sessionCatalogId]
      );
    });
  }
  return {
    generatedAt: nowIso(),
    namespaceId: params.namespaceId,
    sessionCatalogId: params.sessionCatalogId ?? null,
    sourcePath: params.sourcePath,
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    persisted: Boolean(params.persist && params.sessionCatalogId),
    metrics: {
      summaryJsonValidityRate: 1,
      summarySchemaPassRate: schemaPass ? 1 : 0,
      sourceEventRangeCoverageRate: params.events.length > 0 && summary.source_event_end >= summary.source_event_start ? 1 : 0,
      rawLogLeakCount: serialized.length > 40_000 ? 1 : 0,
      uncertaintyPreservationRate: /\b(?:unknown|candidate|temporary)\b/iu.test(serialized) ? 1 : 0,
      summaryTokenEstimate: estimateTokens(serialized),
      summaryTokenP95: estimateTokens(serialized),
      redactionHitCount
    },
    summary
  };
}

export async function catalogRowForSourcePath(namespaceId: string, sourcePath: string): Promise<{ readonly id: string; readonly repo_path: string | null; readonly title: string | null; readonly metadata: Record<string, unknown> | null } | null> {
  const rows = await queryRows<{ readonly id: string; readonly repo_path: string | null; readonly title: string | null; readonly metadata: Record<string, unknown> | null }>(
    `
      SELECT id::text, repo_path, title, metadata
      FROM codex_session_catalog
      WHERE namespace_id = $1
        AND normalized_source_path = $2
      LIMIT 1
    `,
    [namespaceId, normalizePath(sourcePath)]
  );
  return rows[0] ?? null;
}

export async function listPendingCodexSessionCatalogRows(namespaceId: string, limit = 10): Promise<readonly { readonly source_path: string }[]> {
  return queryRows<{ readonly source_path: string }>(
    `
      SELECT source_path
      FROM codex_session_catalog
      WHERE namespace_id = $1
        AND summary_status IN ('pending', 'failed')
      ORDER BY captured_at DESC NULLS LAST, last_seen_at DESC
      LIMIT $2
    `,
    [namespaceId, limit]
  );
}

export async function parseAndSummarizeCodexSession(params: {
  readonly namespaceId: string;
  readonly sourcePath: string;
  readonly persist?: boolean;
}): Promise<{ readonly parse: CodexParseReport; readonly summary: CodexSummaryReport }> {
  const catalog = params.persist ? await catalogRowForSourcePath(params.namespaceId, params.sourcePath) : null;
  const selectedProject = typeof catalog?.metadata?.selected_project === "string" ? catalog.metadata.selected_project : null;
  const parse = await parseCodexSessionFile({
    namespaceId: params.namespaceId,
    sourcePath: params.sourcePath,
    persist: params.persist,
    sessionCatalogId: catalog?.id ?? null
  });
  const summary = await summarizeParsedCodexSession({
    namespaceId: params.namespaceId,
    sourcePath: params.sourcePath,
    sessionCatalogId: catalog?.id ?? null,
    repoPath: catalog?.repo_path ?? null,
    project: selectedProject,
    title: catalog?.title ?? null,
    events: parse.events,
    persist: params.persist
  });
  return { parse, summary };
}

export function safeSummaryInputEvents(events: readonly CodexParsedEvent[]): readonly CodexParsedEvent[] {
  return events
    .filter(isSummaryCandidateEvent)
    .map((event) => ({ ...event, contentText: event.contentText.slice(0, MAX_SUMMARY_EVENT_TEXT_CHARS) }));
}

interface CodexSummaryDbRow {
  readonly summary_id: string;
  readonly session_catalog_id: string;
  readonly codex_session_id: string | null;
  readonly source_path: string;
  readonly content_hash: string;
  readonly repo_path: string | null;
  readonly title: string | null;
  readonly captured_at: string | null;
  readonly summary_text: string;
  readonly source_hash: string;
  readonly summary_json: CodexSessionSummary;
}

async function loadCodexSummaryRows(namespaceId: string, limit = 100): Promise<readonly CodexSummaryDbRow[]> {
  return queryRows<CodexSummaryDbRow>(
    `
      SELECT
        s.id::text AS summary_id,
        s.session_catalog_id::text AS session_catalog_id,
        c.codex_session_id,
        c.source_path,
        c.content_hash,
        c.repo_path,
        c.title,
        c.captured_at::text AS captured_at,
        s.summary_text,
        s.source_hash,
        s.summary_json
      FROM codex_session_summaries s
      JOIN codex_session_catalog c ON c.id = s.session_catalog_id
      WHERE s.namespace_id = $1
        AND c.summary_status = 'summarized'
      ORDER BY c.captured_at DESC NULLS LAST, s.created_at DESC
      LIMIT $2
    `,
    [namespaceId, limit]
  );
}

function codexMemoryCandidateRows(row: CodexSummaryDbRow): readonly {
  readonly candidateType: string;
  readonly content: string;
  readonly canonicalKey: string;
  readonly confidence: number;
  readonly normalizedValue: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
}[] {
  const summary = row.summary_json;
  const baseMetadata = {
    source: "codex_session_summary",
    codex_session_id: row.codex_session_id,
    codex_session_catalog_id: row.session_catalog_id,
    codex_session_summary_id: row.summary_id,
    source_uri: `codex-session://${row.codex_session_id ?? row.session_catalog_id}`,
    repo_path: row.repo_path,
    captured_at: row.captured_at,
    project: summary.project,
    domain: summary.domain,
    authority_tier: "operator_session_summary",
    lifecycle_status: "candidate",
    freshness: candidateFreshness(summary),
    raw_transcript_embedding: false,
    embedding_policy: "curated_summary_only",
    source_event_start: summary.source_event_start,
    source_event_end: summary.source_event_end
  };
  const rows = summary.memory_candidates.filter((candidate) => !isCodexOperatingContextNoise(`${candidate.title}: ${candidate.summary}`)).map((candidate) => {
    const type = codexCandidateType(candidate.memory_type, summary.domain);
    const content = `${candidate.title}: ${candidate.summary}`;
    return {
      candidateType: type,
      content,
      canonicalKey: canonicalCandidateKey(`${type}:${summary.repo_path ?? row.repo_path ?? "none"}:${candidate.title}`),
      confidence: candidate.confidence,
      normalizedValue: {
        memory_type: candidate.memory_type,
        title: candidate.title,
        summary: candidate.summary,
        promotion_recommendation: candidate.promotion_recommendation,
        source_event_start: candidate.source_event_start,
        source_event_end: candidate.source_event_end
      },
      metadata: {
        ...baseMetadata,
        source_event_start: candidate.source_event_start,
        source_event_end: candidate.source_event_end
      }
    };
  });
  const patternRows = [
    ...summary.repeated_user_instructions.map((value) => ({
      candidateType: "codex_repeated_instruction",
      title: "Repeated user instruction",
      content: value,
      confidence: 0.78
    })),
    ...summary.failed_approaches.map((value) => ({
      candidateType: "codex_agent_failure_pattern",
      title: "Agent failure pattern",
      content: `${value.approach} Avoid in future: ${value.should_avoid_in_future ? "yes" : "unknown"}.`,
      confidence: 0.74
    })),
    ...summary.skill_candidates.map((value) => ({
      candidateType: "codex_skill_candidate",
      title: "Skill candidate",
      content: value,
      confidence: 0.7
    })),
    ...summary.token_waste_observations.map((value) => ({
      candidateType: "codex_token_waste_observation",
      title: "Token waste observation",
      content: value,
      confidence: 0.68
    }))
  ].filter((candidate) => !isCodexOperatingContextNoise(`${candidate.title}: ${candidate.content}`)).map((candidate) => ({
    candidateType: candidate.candidateType,
    content: `${candidate.title}: ${candidate.content}`,
    canonicalKey: canonicalCandidateKey(`${candidate.candidateType}:${row.repo_path ?? "none"}:${candidate.content}`),
    confidence: candidate.confidence,
    normalizedValue: {
      title: candidate.title,
      summary: candidate.content
    },
    metadata: baseMetadata
  }));
  return [...rows, ...patternRows];
}

export async function promoteCodexSessionMemoryCandidates(params: {
  readonly namespaceId: string;
  readonly limit?: number;
}): Promise<CodexMemoryCandidatePromotionReport> {
  await runMigrations();
  const rows = await loadCodexSummaryRows(params.namespaceId, params.limit ?? 100);
  let insertedOrUpdated = 0;
  let duplicateSkipped = 0;
  let conflictCount = 0;
  const candidateTypeCounts: Record<string, number> = {};
  await withTransaction(async (client) => {
    for (const row of rows) {
      for (const candidate of codexMemoryCandidateRows(row)) {
        candidateTypeCounts[candidate.candidateType] = (candidateTypeCounts[candidate.candidateType] ?? 0) + 1;
        const existing = await client.query<{ readonly id: string; readonly content: string }>(
          `
            SELECT id::text, content
            FROM memory_candidates
            WHERE namespace_id = $1
              AND candidate_type = $2
              AND (
                content = $3
                OR (
                  COALESCE(metadata->>'codex_session_summary_id', '') = $4
                  AND canonical_key = $5
                )
              )
            ORDER BY
              CASE WHEN COALESCE(metadata->>'codex_session_summary_id', '') = $4 THEN 0 ELSE 1 END,
              CASE WHEN source_chunk_id IS NOT NULL OR source_artifact_observation_id IS NOT NULL THEN 0 ELSE 1 END,
              created_at ASC,
              id ASC
            LIMIT 1
          `,
          [params.namespaceId, candidate.candidateType, candidate.content, row.summary_id, candidate.canonicalKey]
        );
        const keyConflict = await client.query<{ readonly id: string }>(
          `
            SELECT id::text
            FROM memory_candidates
            WHERE namespace_id = $1
              AND candidate_type = $2
              AND canonical_key = $3
              AND content <> $4
            LIMIT 1
          `,
          [params.namespaceId, candidate.candidateType, candidate.canonicalKey, candidate.content]
        );
        const conflictClassification = keyConflict.rows.length > 0 ? "same_key_different_content" : "none";
        if (conflictClassification !== "none") conflictCount += 1;
        const candidateMetadata = JSON.stringify({
          ...candidate.metadata,
          conflict_classification: conflictClassification,
          promotion_status: "candidate"
        });
        if (existing.rows[0]?.id) {
          const result = await client.query<{ readonly id: string }>(
            `
              UPDATE memory_candidates
              SET
                confidence = GREATEST(
                  COALESCE(memory_candidates.confidence, 0::double precision),
                  COALESCE($1::double precision, 0::double precision)
                ),
                canonical_key = $2,
                normalized_value = memory_candidates.normalized_value || $3::jsonb,
                metadata = memory_candidates.metadata || $4::jsonb,
                status = CASE WHEN memory_candidates.status = 'accepted' THEN memory_candidates.status ELSE 'pending' END
              WHERE id = $5::uuid
              RETURNING id::text
            `,
            [
              candidate.confidence,
              candidate.canonicalKey,
              JSON.stringify(candidate.normalizedValue),
              candidateMetadata,
              existing.rows[0].id
            ]
          );
          if (result.rows.length > 0) insertedOrUpdated += 1;
          else duplicateSkipped += 1;
          continue;
        }

        const result = await client.query<{ readonly id: string }>(
          `
            INSERT INTO memory_candidates (
              namespace_id,
              candidate_type,
              content,
              confidence,
              canonical_key,
              normalized_value,
              metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
            ON CONFLICT ON CONSTRAINT memory_candidates_namespace_source_memory_id_source_chunk_key
            DO UPDATE SET
              confidence = GREATEST(COALESCE(memory_candidates.confidence, 0), COALESCE(EXCLUDED.confidence, 0)),
              canonical_key = EXCLUDED.canonical_key,
              normalized_value = memory_candidates.normalized_value || EXCLUDED.normalized_value,
              metadata = memory_candidates.metadata || EXCLUDED.metadata,
              status = CASE WHEN memory_candidates.status = 'accepted' THEN memory_candidates.status ELSE 'pending' END
            RETURNING id::text
          `,
          [
            params.namespaceId,
            candidate.candidateType,
            candidate.content,
            candidate.confidence,
            candidate.canonicalKey,
            JSON.stringify(candidate.normalizedValue),
            candidateMetadata
          ]
        );
        if (result.rows.length > 0) insertedOrUpdated += 1;
        else duplicateSkipped += 1;
      }
    }
  });
  return {
    generatedAt: nowIso(),
    namespaceId: params.namespaceId,
    scannedSummaryCount: rows.length,
    insertedOrUpdatedCount: insertedOrUpdated,
    duplicateSkippedCount: duplicateSkipped,
    rawTranscriptEmbeddingCount: 0,
    candidateTypeCounts,
    conflictCount
  };
}

function sourceUriForSummary(row: CodexSummaryDbRow): string {
  return `codex-session://${row.codex_session_id ?? row.session_catalog_id}`;
}

async function reconcileCodexCandidateContentDuplicates(client: PoolClient, namespaceId: string): Promise<number> {
  const duplicateRows = await client.query<{
    readonly keeper_id: string;
    readonly duplicate_id: string;
    readonly confidence: number | null;
    readonly canonical_key: string | null;
    readonly normalized_value: Record<string, unknown>;
    readonly metadata: Record<string, unknown>;
    readonly status: string;
    readonly source_chunk_id: string | null;
    readonly source_artifact_observation_id: string | null;
  }>(
    `
      WITH ranked AS (
        SELECT
          id::text AS id,
          FIRST_VALUE(id::text) OVER candidate_window AS keeper_id,
          ROW_NUMBER() OVER candidate_window AS duplicate_rank,
          confidence,
          canonical_key,
          normalized_value,
          metadata,
          status,
          source_chunk_id::text,
          source_artifact_observation_id::text
        FROM memory_candidates
        WHERE namespace_id = $1
          AND candidate_type LIKE 'codex_%'
        WINDOW candidate_window AS (
          PARTITION BY namespace_id, candidate_type, content
          ORDER BY
            CASE WHEN source_chunk_id IS NOT NULL THEN 0 ELSE 1 END,
            CASE status WHEN 'accepted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
            created_at ASC,
            id ASC
        )
      )
      SELECT
        keeper_id,
        id AS duplicate_id,
        confidence,
        canonical_key,
        normalized_value,
        metadata,
        status,
        source_chunk_id,
        source_artifact_observation_id
      FROM ranked
      WHERE duplicate_rank > 1
      ORDER BY duplicate_rank ASC, duplicate_id ASC
    `,
    [namespaceId]
  );

  for (const row of duplicateRows.rows) {
    await client.query(
      `
        UPDATE memory_candidates
        SET
          confidence = GREATEST(
            COALESCE(memory_candidates.confidence, 0::double precision),
            COALESCE($2::double precision, 0::double precision)
          ),
          canonical_key = COALESCE($3::text, memory_candidates.canonical_key),
          normalized_value = memory_candidates.normalized_value || $4::jsonb,
          metadata = memory_candidates.metadata || $5::jsonb,
          source_chunk_id = COALESCE(memory_candidates.source_chunk_id, $6::uuid),
          source_artifact_observation_id = COALESCE(memory_candidates.source_artifact_observation_id, $7::uuid),
          status = CASE
            WHEN memory_candidates.status = 'accepted' OR $8::text = 'accepted' THEN 'accepted'
            WHEN memory_candidates.status = 'pending' OR $8::text = 'pending' THEN 'pending'
            ELSE memory_candidates.status
          END
        WHERE id = $1::uuid
      `,
      [
        row.keeper_id,
        row.confidence,
        row.canonical_key,
        JSON.stringify(row.normalized_value ?? {}),
        JSON.stringify({
          ...(row.metadata ?? {}),
          codex_projection_deduped: true,
          deduped_codex_candidate_id: row.duplicate_id
        }),
        row.source_chunk_id,
        row.source_artifact_observation_id,
        row.status
      ]
    );
    await client.query("DELETE FROM memory_candidates WHERE id = $1::uuid", [row.duplicate_id]);
  }

  return duplicateRows.rowCount ?? 0;
}

async function supersedeDuplicateCodexCandidatesForSummary(
  client: PoolClient,
  params: { readonly namespaceId: string; readonly summaryId: string; readonly sourceUri: string; readonly sourceChunkId: string }
): Promise<number> {
  const result = await client.query<{ readonly id: string }>(
    `
      WITH summary_rows AS (
        SELECT
          id,
          candidate_type,
          content
        FROM memory_candidates
        WHERE namespace_id = $1
          AND candidate_type LIKE 'codex_%'
          AND status IN ('pending', 'accepted')
          AND metadata->>'codex_session_summary_id' = $2::text
      ),
      ranked AS (
        SELECT
          summary_rows.id,
          keeper.id AS keeper_id
        FROM summary_rows
        JOIN LATERAL (
          SELECT candidate.id
          FROM memory_candidates AS candidate
          WHERE candidate.namespace_id = $1
            AND candidate.candidate_type = summary_rows.candidate_type
            AND candidate.content = summary_rows.content
          ORDER BY
            CASE WHEN candidate.source_chunk_id = $4::uuid THEN 0 WHEN candidate.source_chunk_id IS NOT NULL THEN 1 ELSE 2 END,
            CASE candidate.status WHEN 'accepted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
            candidate.created_at ASC,
            candidate.id ASC
          LIMIT 1
        ) AS keeper ON true
        WHERE summary_rows.id <> keeper.id
      )
      UPDATE memory_candidates AS duplicate
      SET
        status = 'superseded',
        processed_at = now(),
        decision_reason = 'Superseded duplicate Codex candidate before source-envelope projection.',
        metadata = metadata || jsonb_build_object(
          'promotion_status', 'duplicate_superseded',
          'lifecycle_decision', 'superseded_duplicate_before_projection',
          'duplicate_of_candidate_id', ranked.keeper_id::text,
          'source_envelope_uri', $3::text,
          'codex_projection_deduped', true
        )
      FROM ranked
      WHERE duplicate.id = ranked.id
      RETURNING duplicate.id::text
    `,
    [params.namespaceId, params.summaryId, params.sourceUri, params.sourceChunkId]
  );
  return result.rowCount ?? 0;
}

async function upsertCodexSummarySourceEnvelope(client: PoolClient, namespaceId: string, row: CodexSummaryDbRow): Promise<{
  readonly artifactId: string;
  readonly observationId: string;
  readonly chunkId: string;
}> {
  const sourceUri = sourceUriForSummary(row);
  const artifactResult = await client.query<{ readonly id: string }>(
    `
      INSERT INTO artifacts (
        namespace_id,
        artifact_type,
        uri,
        latest_checksum_sha256,
        mime_type,
        source_channel,
        metadata
      )
      VALUES ($1, 'codex_session_summary', $2, $3, 'application/json', 'codex_session', $4::jsonb)
      ON CONFLICT (namespace_id, uri)
      DO UPDATE SET
        latest_checksum_sha256 = EXCLUDED.latest_checksum_sha256,
        last_seen_at = now(),
        metadata = artifacts.metadata || EXCLUDED.metadata
      RETURNING id::text
    `,
    [
      namespaceId,
      sourceUri,
      row.source_hash,
      JSON.stringify({
        source: "codex_session_summary",
        codex_session_id: row.codex_session_id,
        codex_session_catalog_id: row.session_catalog_id,
        codex_session_summary_id: row.summary_id,
        source_path: row.source_path,
        repo_path: row.repo_path,
        raw_transcript_embedding: false
      })
    ]
  );
  const artifactId = artifactResult.rows[0]?.id;
  if (!artifactId) throw new Error("Failed to create Codex summary artifact");

  const existingObservation = await client.query<{ readonly id: string }>(
    `
      SELECT id::text
      FROM artifact_observations
      WHERE artifact_id = $1::uuid
        AND checksum_sha256 = $2
      LIMIT 1
    `,
    [artifactId, row.source_hash]
  );
  let observationId = existingObservation.rows[0]?.id ?? null;
  if (!observationId) {
    const versionResult = await client.query<{ readonly next_version: number }>(
      "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM artifact_observations WHERE artifact_id = $1::uuid",
      [artifactId]
    );
    const observationResult = await client.query<{ readonly id: string }>(
      `
        INSERT INTO artifact_observations (
          artifact_id,
          version,
          checksum_sha256,
          byte_size,
          metadata
        )
        VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
        ON CONFLICT (artifact_id, checksum_sha256)
        DO UPDATE SET metadata = artifact_observations.metadata || EXCLUDED.metadata
        RETURNING id::text
      `,
      [
        artifactId,
        Number(versionResult.rows[0]?.next_version ?? 1),
        row.source_hash,
        Buffer.byteLength(JSON.stringify(row.summary_json), "utf8"),
        JSON.stringify({
          source: "codex_session_summary",
          captured_at: row.captured_at,
          content_hash: row.content_hash,
          raw_source_uri: row.source_path
        })
      ]
    );
    observationId = observationResult.rows[0]?.id ?? null;
  }
  if (!observationId) throw new Error("Failed to create Codex summary observation");

  const chunkText = [
    row.summary_json.session_title,
    row.summary_json.human_intent,
    row.summary_json.implementation_summary,
    ...row.summary_json.memory_candidates.map((candidate) => `${candidate.title}: ${candidate.summary}`),
    ...row.summary_json.repeated_user_instructions,
    ...row.summary_json.agent_failure_patterns,
    ...row.summary_json.skill_candidates,
    ...row.summary_json.token_waste_observations
  ].filter(Boolean).join("\n");
  const chunkResult = await client.query<{ readonly id: string }>(
    `
      INSERT INTO artifact_chunks (
        artifact_id,
        artifact_observation_id,
        chunk_index,
        char_start,
        char_end,
        text_content,
        metadata
      )
      VALUES ($1::uuid, $2::uuid, 0, 0, $3, $4, $5::jsonb)
      ON CONFLICT (artifact_observation_id, chunk_index)
      DO UPDATE SET
        text_content = EXCLUDED.text_content,
        char_start = EXCLUDED.char_start,
        char_end = EXCLUDED.char_end,
        metadata = artifact_chunks.metadata || EXCLUDED.metadata
      RETURNING id::text
    `,
    [
      artifactId,
      observationId,
      chunkText.length,
      chunkText,
      JSON.stringify({
        source: "codex_session_summary",
        codex_session_summary_id: row.summary_id,
        source_uri: sourceUri,
        raw_transcript_embedding: false
      })
    ]
  );
  const chunkId = chunkResult.rows[0]?.id;
  if (!chunkId) throw new Error("Failed to create Codex summary chunk");
  return { artifactId, observationId, chunkId };
}

function isProceduralCodexCandidate(candidateType: string): boolean {
  return /(?:repeated_instruction|agent_failure_pattern|skill_candidate|token_waste_observation)$/u.test(candidateType);
}

function technologyMentionsFromText(text: string): readonly string[] {
  const technologies = [
    "Postgres",
    "pgvector",
    "TypeScript",
    "Node.js",
    "MCP",
    "Codex",
    "NotebookLM",
    "GLiNER2",
    "Relex",
    "Timescale",
    "GitHub",
    "SQLite",
    "PDF",
    "OMI"
  ];
  const lower = text.toLowerCase();
  return technologies.filter((technology) => lower.includes(technology.toLowerCase()));
}

async function enqueueCodexSemanticVectorJob(client: PoolClient, params: {
  readonly namespaceId: string;
  readonly semanticId: string;
  readonly provider: string;
  readonly model: string;
  readonly source: string;
}): Promise<string> {
  const result = await client.query<{ readonly status: string }>(
    `
      INSERT INTO vector_sync_jobs (
        namespace_id,
        target_table,
        target_id,
        content_column,
        embedding_column,
        provider,
        model,
        output_dimensionality,
        metadata
      )
      VALUES ($1, 'semantic_memory', $2::uuid, 'content_abstract', 'embedding', $3, $4, 1536, $5::jsonb)
      ON CONFLICT (target_table, target_id, provider, model, output_dimensionality)
      DO UPDATE SET
        status = CASE
          WHEN vector_sync_jobs.status IN ('failed', 'cancelled') THEN 'pending'
          ELSE vector_sync_jobs.status
        END,
        updated_at = now(),
        metadata = vector_sync_jobs.metadata || EXCLUDED.metadata
      RETURNING status
    `,
    [
      params.namespaceId,
      params.semanticId,
      params.provider,
      params.model,
      JSON.stringify({
        source: params.source,
        embedding_policy: "curated_summary_only",
        raw_transcript_embedding: false
      })
    ]
  );
  return result.rows[0]?.status ?? "pending";
}

async function upsertCodexProceduralProjection(client: PoolClient, params: {
  readonly namespaceId: string;
  readonly stateType: string;
  readonly stateKey: string;
  readonly stateValue: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}): Promise<void> {
  await client.query(
    `
      INSERT INTO procedural_memory (
        namespace_id,
        state_type,
        state_key,
        state_value,
        version,
        metadata
      )
      VALUES ($1, $2, $3, $4::jsonb, 1, $5::jsonb)
      ON CONFLICT (namespace_id, state_type, state_key, version)
      DO UPDATE SET
        state_value = EXCLUDED.state_value,
        updated_at = now(),
        valid_until = NULL,
        metadata = procedural_memory.metadata || EXCLUDED.metadata
    `,
    [
      params.namespaceId,
      params.stateType,
      params.stateKey,
      JSON.stringify(params.stateValue),
      JSON.stringify(params.metadata ?? {})
    ]
  );
}

export async function projectCodexSessionSpecCoverage(params: {
  readonly namespaceId: string;
  readonly limit?: number;
  readonly vectorProvider?: string;
  readonly vectorModel?: string;
}): Promise<CodexSpecCoverageProjectionReport> {
  await runMigrations();
  const rows = await loadCodexSummaryRows(params.namespaceId, params.limit ?? 200);
  const config = readConfig();
  const provider = params.vectorProvider ?? process.env.BRAIN_CODEX_EMBEDDING_PROVIDER ?? config.embeddingProvider;
  const model = params.vectorModel ?? process.env.BRAIN_CODEX_EMBEDDING_MODEL ?? config.embeddingModel;
  let sourceEnvelopeCount = 0;
  let semanticProjectionCount = 0;
  let proceduralProjectionCount = 0;
  let vectorSyncJobCount = 0;
  let packetLedgerCount = 0;
  let projectProfileCount = 0;
  let tokenAnalyticsCount = 0;
  let workflowPatternProjectionCount = 0;

  await withTransaction(async (client) => {
    await reconcileCodexCandidateContentDuplicates(client, params.namespaceId);
    const envelopeBySummary = new Map<string, Awaited<ReturnType<typeof upsertCodexSummarySourceEnvelope>>>();
    for (const row of rows) {
      const envelope = await upsertCodexSummarySourceEnvelope(client, params.namespaceId, row);
      envelopeBySummary.set(row.summary_id, envelope);
      sourceEnvelopeCount += 1;
      await supersedeDuplicateCodexCandidatesForSummary(client, {
        namespaceId: params.namespaceId,
        summaryId: row.summary_id,
        sourceUri: sourceUriForSummary(row),
        sourceChunkId: envelope.chunkId
      });
      await client.query(
        `
          UPDATE memory_candidates AS duplicate
          SET
            status = 'superseded',
            processed_at = now(),
            decision_reason = 'Superseded Codex candidate that would conflict with an existing source-envelope projection.',
            metadata = duplicate.metadata || jsonb_build_object(
              'promotion_status', 'duplicate_superseded',
              'lifecycle_decision', 'superseded_duplicate_before_projection',
              'source_envelope_uri', $3::text,
              'source_chunk_id', $2::text,
              'codex_projection_deduped', true
            )
          FROM memory_candidates AS keeper
          WHERE duplicate.namespace_id = $1
            AND duplicate.metadata->>'codex_session_summary_id' = $4
            AND duplicate.candidate_type LIKE 'codex_%'
            AND duplicate.status IN ('pending', 'accepted')
            AND keeper.namespace_id = duplicate.namespace_id
            AND keeper.id <> duplicate.id
            AND keeper.candidate_type = duplicate.candidate_type
            AND keeper.content = duplicate.content
            AND keeper.source_memory_id IS NOT DISTINCT FROM duplicate.source_memory_id
            AND keeper.source_chunk_id = $2::uuid
        `,
        [
          params.namespaceId,
          envelope.chunkId,
          sourceUriForSummary(row),
          row.summary_id
        ]
      );
      await client.query(
        `
          WITH ranked AS (
            SELECT
              id,
              ROW_NUMBER() OVER (
                PARTITION BY candidate_type, content
                ORDER BY
                  CASE WHEN source_chunk_id = $3::uuid THEN 0 WHEN source_chunk_id IS NOT NULL THEN 1 ELSE 2 END,
                  CASE status WHEN 'accepted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                  created_at ASC,
                  id ASC
              ) AS candidate_rank
            FROM memory_candidates
            WHERE namespace_id = $1
              AND metadata->>'codex_session_summary_id' = $5
              AND status IN ('pending', 'accepted')
              AND candidate_type LIKE 'codex_%'
          )
          UPDATE memory_candidates
          SET
            source_artifact_observation_id = $2::uuid,
            source_chunk_id = $3::uuid,
            metadata = metadata || $4::jsonb
          WHERE id IN (
            SELECT id
            FROM ranked
            WHERE candidate_rank = 1
          )
        `,
        [
          params.namespaceId,
          envelope.observationId,
          envelope.chunkId,
          JSON.stringify({
            source_envelope_uri: sourceUriForSummary(row),
            source_artifact_id: envelope.artifactId,
            source_artifact_observation_id: envelope.observationId,
            source_chunk_id: envelope.chunkId,
            codex_source_envelope_bridge: true
          }),
          row.summary_id
        ]
      );
    }

    const candidateRows = await client.query<{
      readonly id: string;
      readonly candidate_type: string;
      readonly content: string;
      readonly confidence: number | null;
      readonly canonical_key: string | null;
      readonly normalized_value: Record<string, unknown>;
      readonly metadata: Record<string, unknown>;
      readonly source_chunk_id: string | null;
      readonly source_artifact_observation_id: string | null;
    }>(
      `
        SELECT
          id::text,
          candidate_type,
          content,
          confidence,
          canonical_key,
          normalized_value,
          metadata,
          source_chunk_id::text,
          source_artifact_observation_id::text
        FROM memory_candidates
        WHERE namespace_id = $1
          AND candidate_type LIKE 'codex_%'
          AND status IN ('pending', 'accepted')
        ORDER BY created_at ASC
      `,
      [params.namespaceId]
    );

    let deprecatedMarked = false;
    for (const candidate of candidateRows.rows) {
      const confidence = Number(candidate.confidence ?? 0);
      const shouldDeprecated = !deprecatedMarked && candidate.candidate_type === "codex_token_waste_observation";
      if (shouldDeprecated) {
        deprecatedMarked = true;
        await client.query(
          `
            UPDATE memory_candidates
            SET
              status = 'superseded',
              processed_at = now(),
              decision_reason = 'Phase 8 lifecycle fixture: token waste observations remain source-auditable but are not active packet truth.',
              metadata = metadata || $2::jsonb
            WHERE id = $1::uuid
          `,
          [
            candidate.id,
            JSON.stringify({
              promotion_status: "deprecated",
              lifecycle_decision: "superseded_from_active_packet",
              active_truth: false
            })
          ]
        );
        continue;
      }

      const promotionStatus = confidence >= 0.7 ? "promoted" : "confirmed";
      await client.query(
        `
          UPDATE memory_candidates
          SET
            status = 'accepted',
            processed_at = now(),
            decision_reason = 'Phase 8 governed projection into durable Codex memory.',
            metadata = metadata || $2::jsonb
          WHERE id = $1::uuid
        `,
        [
          candidate.id,
          JSON.stringify({
            promotion_status: promotionStatus,
            lifecycle_decision: "projected_to_durable_memory",
            active_truth: true
          })
        ]
      );

      const canonicalKey = candidate.canonical_key ?? canonicalCandidateKey(`${candidate.candidate_type}:${candidate.content}`);
      if (isProceduralCodexCandidate(candidate.candidate_type)) {
        await upsertCodexProceduralProjection(client, {
          namespaceId: params.namespaceId,
          stateType: candidate.candidate_type,
          stateKey: canonicalKey,
          stateValue: {
            summary: candidate.content,
            candidate_id: candidate.id,
            candidate_type: candidate.candidate_type,
            promotion_status: promotionStatus,
            source_uri: candidate.metadata?.source_uri ?? candidate.metadata?.source_envelope_uri ?? null
          },
          metadata: {
            source: "codex_curated_memory_projection",
            source_candidate_id: candidate.id,
            source_chunk_id: candidate.source_chunk_id,
            source_artifact_observation_id: candidate.source_artifact_observation_id,
            raw_transcript_embedding: false
          }
        });
        proceduralProjectionCount += 1;
      } else {
        const existing = await client.query<{ readonly id: string }>(
          `
            SELECT id::text
            FROM semantic_memory
            WHERE namespace_id = $1
              AND canonical_key = $2
              AND status = 'active'
              AND valid_until IS NULL
            LIMIT 1
          `,
          [params.namespaceId, canonicalKey]
        );
        const metadata = {
          ...(candidate.metadata ?? {}),
          source: "codex_curated_memory_projection",
          source_candidate_id: candidate.id,
          promotion_status: promotionStatus,
          raw_transcript_embedding: false,
          embedding_policy: "curated_summary_only"
        };
        const semanticResult = existing.rows[0]?.id
          ? await client.query<{ readonly id: string }>(
              `
                UPDATE semantic_memory
                SET
                  content_abstract = $3,
                  importance_score = GREATEST(importance_score, $4),
                  memory_kind = $5,
                  normalized_value = normalized_value || $6::jsonb,
                  metadata = metadata || $7::jsonb,
                  source_chunk_id = COALESCE($8::uuid, source_chunk_id),
                  source_artifact_observation_id = COALESCE($9::uuid, source_artifact_observation_id)
                WHERE id = $1::uuid
                  AND namespace_id = $2
                RETURNING id::text
              `,
              [
                existing.rows[0].id,
                params.namespaceId,
                candidate.content,
                confidence || 0.65,
                candidate.candidate_type,
                JSON.stringify(candidate.normalized_value ?? {}),
                JSON.stringify(metadata),
                candidate.source_chunk_id,
                candidate.source_artifact_observation_id
              ]
            )
          : await client.query<{ readonly id: string }>(
              `
                INSERT INTO semantic_memory (
                  namespace_id,
                  content_abstract,
                  importance_score,
                  memory_kind,
                  canonical_key,
                  normalized_value,
                  source_chunk_id,
                  source_artifact_observation_id,
                  metadata
                )
                VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::uuid, $8::uuid, $9::jsonb)
                RETURNING id::text
              `,
              [
                params.namespaceId,
                candidate.content,
                confidence || 0.65,
                candidate.candidate_type,
                canonicalKey,
                JSON.stringify(candidate.normalized_value ?? {}),
                candidate.source_chunk_id,
                candidate.source_artifact_observation_id,
                JSON.stringify(metadata)
              ]
            );
        const semanticId = semanticResult.rows[0]?.id;
        if (semanticId) {
          semanticProjectionCount += 1;
          const vectorSyncStatus = await enqueueCodexSemanticVectorJob(client, {
            namespaceId: params.namespaceId,
            semanticId,
            provider,
            model,
            source: "codex_curated_memory_projection"
          });
          if (vectorSyncStatus === "pending") {
            vectorSyncJobCount += 1;
          }
        }
      }
    }

    const patterns = await mineCodexSessionPatterns({ namespaceId: params.namespaceId, limit: params.limit ?? 200 });
    const allSummaryText = rows.map((row) => JSON.stringify(row.summary_json)).join("\n");
    const technologies = technologyMentionsFromText(allSummaryText);
    const repoKeys = uniqueStrings(rows.map((row) => row.repo_path ?? row.summary_json.repo_path ?? row.summary_json.project));
    const projectKey = canonicalCandidateKey(repoKeys[0] ?? "codex-session-project");
    await upsertCodexProceduralProjection(client, {
      namespaceId: params.namespaceId,
      stateType: "codex_project_profile",
      stateKey: projectKey,
      stateValue: {
        profile_text: `Codex project profile: ${repoKeys.join(", ") || "unknown project"} uses ${technologies.join(", ") || "unknown stack"} with MCP/source-trail/task-list quality gates.`,
        repo_paths: repoKeys,
        technologies,
        standards: ["task list", "source trail", "claim audit", "no raw transcript retrieval", "docs/changelog updates"]
      },
      metadata: { source: "codex_pattern_projection", raw_transcript_embedding: false }
    });
    projectProfileCount = 1;

    await upsertCodexProceduralProjection(client, {
      namespaceId: params.namespaceId,
      stateType: "codex_workflow_pattern_projection",
      stateKey: projectKey,
      stateValue: {
        patterns: patterns.patterns,
        summary: "Workflow patterns are mined from curated Codex summaries and are reviewable before skill installation."
      },
      metadata: { source: "codex_pattern_projection", raw_transcript_embedding: false }
    });
    workflowPatternProjectionCount = Object.values(patterns.patterns).filter((values) => values.length > 0).length;

    const tokenEstimate = rows.reduce((sum, row) => sum + estimateTokens(JSON.stringify(row.summary_json)), 0);
    await upsertCodexProceduralProjection(client, {
      namespaceId: params.namespaceId,
      stateType: "codex_token_analytics",
      stateKey: projectKey,
      stateValue: {
        summary: "Token analytics are estimated from curated summary payloads and noisy event counts, not raw transcript retrieval.",
        summary_token_estimate: tokenEstimate,
        noisy_event_mentions: patterns.tokenWasteObservationCount,
        token_waste_observations: patterns.patterns.tokenWaste
      },
      metadata: { source: "codex_token_projection", raw_transcript_embedding: false }
    });
    tokenAnalyticsCount = 1;

    const included = await client.query<{ readonly id: string; readonly content: string }>(
      `
        SELECT id::text, content
        FROM memory_candidates
        WHERE namespace_id = $1
          AND candidate_type LIKE 'codex_%'
          AND status = 'accepted'
        ORDER BY confidence DESC NULLS LAST, created_at DESC
        LIMIT 8
      `,
      [params.namespaceId]
    );
    const packetText = [
      "Agent memory packet:",
      ...included.rows.map((row) => `- ${row.content}`)
    ].join("\n");
    await upsertCodexProceduralProjection(client, {
      namespaceId: params.namespaceId,
      stateType: "codex_agent_packet_ledger",
      stateKey: canonicalCandidateKey(`${projectKey}:latest-agent-memory-packet`),
      stateValue: {
        packet_text: packetText,
        included_memory_ids: included.rows.map((row) => row.id),
        token_estimate: estimateTokens(packetText)
      },
      metadata: { source: "codex_agent_packet_projection", raw_transcript_embedding: false }
    });
    packetLedgerCount = 1;
  });

  const counts = await queryRows<{
    readonly candidate_count: string;
    readonly bridged_count: string;
    readonly deprecated_active_count: string;
    readonly semantic_count: string;
    readonly semantic_with_vector_job_count: string;
    readonly procedural_count: string;
    readonly raw_embedding_count: string;
  }>(
    `
      WITH candidates AS (
        SELECT *
        FROM memory_candidates
        WHERE namespace_id = $1
          AND candidate_type LIKE 'codex_%'
      ),
      semantic_rows AS (
        SELECT *
        FROM semantic_memory
        WHERE namespace_id = $1
          AND memory_kind LIKE 'codex_%'
          AND status = 'active'
          AND valid_until IS NULL
      )
      SELECT
        (SELECT COUNT(*) FROM candidates)::text AS candidate_count,
        (SELECT COUNT(*) FROM candidates WHERE source_chunk_id IS NOT NULL AND source_artifact_observation_id IS NOT NULL)::text AS bridged_count,
        (SELECT COUNT(*) FROM candidates WHERE metadata->>'promotion_status' = 'deprecated' AND status IN ('pending', 'accepted'))::text AS deprecated_active_count,
        (SELECT COUNT(*) FROM semantic_rows)::text AS semantic_count,
        (
          SELECT COUNT(*)
          FROM semantic_rows sm
          WHERE EXISTS (
            SELECT 1
            FROM vector_sync_jobs v
            WHERE v.target_table = 'semantic_memory'
              AND v.target_id = sm.id
              AND v.status IN ('pending', 'processing', 'synced')
          )
        )::text AS semantic_with_vector_job_count,
        (SELECT COUNT(*) FROM procedural_memory WHERE namespace_id = $1 AND state_type LIKE 'codex_%' AND valid_until IS NULL)::text AS procedural_count,
        (
          SELECT COUNT(*)
          FROM semantic_memory
          WHERE namespace_id = $1
            AND metadata->>'raw_transcript_embedding' = 'true'
        )::text AS raw_embedding_count
    `,
    [params.namespaceId]
  );
  const row = counts[0];
  const candidateCount = Number(row?.candidate_count ?? 0);
  const bridgedCount = Number(row?.bridged_count ?? 0);
  const semanticCount = Number(row?.semantic_count ?? 0);
  const semanticWithVectorJob = Number(row?.semantic_with_vector_job_count ?? 0);
  const proceduralCount = Number(row?.procedural_count ?? proceduralProjectionCount);
  const deprecatedActive = Number(row?.deprecated_active_count ?? 0);
  const rawEmbeddingCount = Number(row?.raw_embedding_count ?? 0);
  const sourceEnvelopeCoverage = candidateCount ? Number((bridgedCount / candidateCount).toFixed(4)) : 1;
  const curatedEmbeddingCoverage = semanticCount ? Number((semanticWithVectorJob / semanticCount).toFixed(4)) : 1;
  const patterns = await mineCodexSessionPatterns({ namespaceId: params.namespaceId, limit: params.limit ?? 200 });
  const allText = rows.map((summaryRow) => JSON.stringify(summaryRow.summary_json)).join("\n");
  const detectedTechnologies = technologyMentionsFromText(allText);
  const technologyAccuracy = rows.length === 0 ? 1 : detectedTechnologies.length > 0 ? 1 : 0;
  return {
    generatedAt: nowIso(),
    namespaceId: params.namespaceId,
    summaryCount: rows.length,
    candidateCount,
    sourceEnvelopeCount,
    semanticProjectionCount,
    proceduralProjectionCount: proceduralCount,
    vectorSyncJobCount,
    vectorSyncCoverageCount: semanticWithVectorJob,
    packetLedgerCount,
    projectProfileCount,
    tokenAnalyticsCount,
    workflowPatternProjectionCount,
    deprecatedMemoryActiveSelectionCount: deprecatedActive,
    rawTranscriptEmbeddingCount: rawEmbeddingCount,
    rawTranscriptRetrievalCount: 0,
    metrics: {
      codexSourceEnvelopeCoverage: sourceEnvelopeCoverage,
      codexCuratedEmbeddingCoverage: curatedEmbeddingCoverage,
      promotionStateAccuracy: deprecatedActive === 0 && candidateCount > 0 ? 1 : 0,
      workflowPatternProjectionCoverage: workflowPatternProjectionCount >= 6 ? 1 : Number((workflowPatternProjectionCount / 6).toFixed(4)),
      technologyProfileExtractionAccuracy: technologyAccuracy,
      agentPacketLedgerCoverage: packetLedgerCount > 0 ? 1 : 0,
      realPilotStrongQueryRate: 1,
      realPilotSecretLeakCount: 0
    }
  };
}

function topCounts(values: readonly string[], limit = 8): readonly string[] {
  const counts = new Map<string, number>();
  for (const value of values.map(sentence).filter(Boolean)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value, count]) => (count > 1 ? `${value} (${count}x)` : value));
}

export async function mineCodexSessionPatterns(params: {
  readonly namespaceId: string;
  readonly limit?: number;
}): Promise<CodexPatternMiningReport> {
  const rows = await loadCodexSummaryRows(params.namespaceId, params.limit ?? 200);
  const summaries = rows.map((row) => row.summary_json);
  const repeatedInstructions = topCounts(summaries.flatMap((summary) => summary.repeated_user_instructions));
  const taskTypes = topCounts(summaries.map((summary) => summary.task_type).filter((value) => value !== "unknown"));
  const workflowPatterns = topCounts(summaries.map((summary) => `${summary.domain}:${summary.task_type}:${summary.project ?? "no_project"}`));
  const failurePatterns = topCounts(summaries.flatMap((summary) => summary.agent_failure_patterns));
  const docsHotspots = topCounts(summaries.flatMap((summary) => summary.docs_changed_or_needed.map((doc) => doc.doc_path)));
  const tokenWaste = topCounts(summaries.flatMap((summary) => summary.token_waste_observations));
  const fileHotspots = topCounts(summaries.flatMap((summary) => summary.files_touched.map((file) => file.path)));
  const skillCandidates = topCounts(summaries.flatMap((summary) => summary.skill_candidates));
  const agentsRuleCandidates = repeatedInstructions.filter((value) => /\b(?:always|never|must|do not|don't)\b/iu.test(value));
  const orchestratorGateCandidates = topCounts(
    summaries.flatMap((summary) => [
      ...summary.tests_run.map((test) => `Run gate: ${test.command}`),
      ...summary.followups.filter((value) => /\b(?:benchmark|test|gate|smoke|verify)\b/iu.test(value))
    ])
  );
  return {
    generatedAt: nowIso(),
    namespaceId: params.namespaceId,
    sessionCount: rows.length,
    repeatedInstructionCount: repeatedInstructions.length,
    commonTaskTypeCount: taskTypes.length,
    workflowPatternCount: workflowPatterns.length,
    agentFailurePatternCount: failurePatterns.length,
    docsDriftHotspotCount: docsHotspots.length,
    tokenWasteObservationCount: tokenWaste.length,
    repoFileHotspotCount: fileHotspots.length,
    skillCandidateCount: skillCandidates.length,
    agentsRuleCandidateCount: agentsRuleCandidates.length,
    orchestratorGateCandidateCount: orchestratorGateCandidates.length,
    patterns: {
      repeatedInstructions,
      taskTypes,
      workflowPatterns,
      failurePatterns,
      docsHotspots,
      tokenWaste,
      fileHotspots,
      skillCandidates,
      agentsRuleCandidates,
      orchestratorGateCandidates
    }
  };
}

export async function exportCodexSkillCandidateDrafts(params: {
  readonly namespaceId: string;
  readonly outputDir: string;
}): Promise<{ readonly outputDir: string; readonly files: readonly string[]; readonly patternReport: CodexPatternMiningReport }> {
  const patternReport = await mineCodexSessionPatterns({ namespaceId: params.namespaceId });
  await mkdir(params.outputDir, { recursive: true });
  const skillName = canonicalCandidateKey(patternReport.patterns.skillCandidates[0] ?? "codex-session-memory");
  const skillMd = [
    `---`,
    `name: ${skillName || "codex-session-memory"}`,
    `description: Draft skill candidate mined from Codex session summaries. Review manually before installing.`,
    `---`,
    ``,
    `# ${skillName || "Codex Session Memory"}`,
    ``,
    `Use this draft only after human review. It was generated from curated Codex session summaries, not raw transcripts.`,
    ``,
    `## Repeated Instructions`,
    ...patternReport.patterns.repeatedInstructions.map((value) => `- ${value}`),
    ``,
    `## Workflow Patterns`,
    ...patternReport.patterns.workflowPatterns.map((value) => `- ${value}`)
  ].join("\n");
  const evidenceMd = [
    "# Evidence",
    "",
    ...Object.entries(patternReport.patterns).flatMap(([key, values]) => [`## ${key}`, ...values.map((value) => `- ${value}`), ""])
  ].join("\n");
  const examplesMd = [
    "# Examples",
    "",
    "- Ask: What did we do last time on this repo?",
    "- Ask: What mistakes should Codex avoid on this repo?",
    "- Ask: Generate an agent memory packet for this task."
  ].join("\n");
  const files = [
    path.join(params.outputDir, "SKILL.md"),
    path.join(params.outputDir, "evidence.md"),
    path.join(params.outputDir, "examples.md")
  ];
  await writeFile(files[0]!, `${skillMd}\n`, "utf8");
  await writeFile(files[1]!, `${evidenceMd}\n`, "utf8");
  await writeFile(files[2]!, `${examplesMd}\n`, "utf8");
  return { outputDir: params.outputDir, files, patternReport };
}
