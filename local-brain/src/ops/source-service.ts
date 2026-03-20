import { createHash } from "node:crypto";
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { queryRows, withTransaction } from "../db/client.js";
import { readConfig } from "../config.js";
import { ingestArtifact } from "../ingest/worker.js";
import type { SourceType } from "../types.js";

type MonitoredSourceType = "openclaw" | "folder";
type MonitoredSourceStatus = "ready" | "disabled" | "error";
type FileStatus = "new" | "changed" | "unchanged" | "deleted" | "imported" | "error";
type RunStatus = "running" | "succeeded" | "partial" | "failed";
type ImportTriggerType = "manual" | "scheduled" | "onboarding";

const SUPPORTED_FILE_EXTENSIONS = [".md", ".txt"] as const;
const DEFAULT_SCAN_SCHEDULE = "every_30_minutes";

interface MonitoredSourceRow {
  readonly id: string;
  readonly source_type: MonitoredSourceType;
  readonly namespace_id: string;
  readonly label: string;
  readonly root_path: string;
  readonly include_subfolders: boolean;
  readonly file_extensions_json: unknown;
  readonly monitor_enabled: boolean;
  readonly scan_schedule: string;
  readonly status: MonitoredSourceStatus;
  readonly created_by: string | null;
  readonly notes: string | null;
  readonly metadata: Record<string, unknown>;
  readonly last_scan_at: string | null;
  readonly last_import_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface MonitoredSourceListRow extends MonitoredSourceRow {
  readonly files_discovered: number;
  readonly files_imported: number;
  readonly files_pending: number;
}

interface MonitoredSourceFileRow {
  readonly id: string;
  readonly source_id: string;
  readonly absolute_path: string;
  readonly relative_path: string;
  readonly file_name: string;
  readonly extension: string;
  readonly size_bytes: string | number | null;
  readonly modified_at: string | null;
  readonly content_hash: string | null;
  readonly last_seen_at: string;
  readonly exists_now: boolean;
  readonly artifact_id: string | null;
  readonly last_import_run_id: string | null;
  readonly last_imported_hash: string | null;
  readonly last_imported_at: string | null;
  readonly last_status: FileStatus;
  readonly error_message: string | null;
  readonly metadata: Record<string, unknown>;
  readonly created_at: string;
  readonly updated_at: string;
}

interface CountRow {
  readonly total: number;
}

interface ScanRunRow {
  readonly id: string;
  readonly source_id: string;
  readonly scan_started_at: string;
  readonly scan_finished_at: string | null;
  readonly status: RunStatus;
  readonly files_seen: number;
  readonly new_files: number;
  readonly changed_files: number;
  readonly deleted_files: number;
  readonly errored_files: number;
  readonly notes: string | null;
  readonly result_json: Record<string, unknown>;
}

interface ImportRunRow {
  readonly id: string;
  readonly source_id: string;
  readonly trigger_type: ImportTriggerType;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly status: RunStatus;
  readonly files_attempted: number;
  readonly files_imported: number;
  readonly files_skipped: number;
  readonly files_failed: number;
  readonly brain_job_ids_json: unknown;
  readonly notes: string | null;
  readonly result_json: Record<string, unknown>;
}

interface BootstrapStateRow {
  readonly id: boolean;
  readonly owner_profile_completed: boolean;
  readonly source_import_completed: boolean;
  readonly verification_completed: boolean;
  readonly onboarding_completed_at: string | null;
  readonly metadata: Record<string, unknown>;
  readonly updated_at: string;
}

interface ScannedFileCandidate {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly fileName: string;
  readonly extension: string;
  readonly sizeBytes?: number;
  readonly modifiedAt?: string;
  readonly contentHash?: string;
  readonly lastStatus: Exclude<FileStatus, "deleted" | "imported">;
  readonly errorMessage?: string;
}

export interface OpsBootstrapState {
  readonly ownerProfileCompleted: boolean;
  readonly sourceImportCompleted: boolean;
  readonly verificationCompleted: boolean;
  readonly onboardingCompletedAt?: string;
  readonly metadata: Record<string, unknown>;
  readonly updatedAt: string;
  readonly progress: {
    readonly completedSteps: number;
    readonly totalSteps: number;
    readonly onboardingComplete: boolean;
  };
}

export interface OpsMonitoredSource {
  readonly id: string;
  readonly sourceType: MonitoredSourceType;
  readonly namespaceId: string;
  readonly label: string;
  readonly rootPath: string;
  readonly includeSubfolders: boolean;
  readonly fileExtensions: readonly string[];
  readonly monitorEnabled: boolean;
  readonly scanSchedule: string;
  readonly status: MonitoredSourceStatus;
  readonly createdBy?: string;
  readonly notes?: string;
  readonly metadata: Record<string, unknown>;
  readonly lastScanAt?: string;
  readonly lastImportAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OpsMonitoredSourceSummary extends OpsMonitoredSource {
  readonly counts: {
    readonly filesDiscovered: number;
    readonly filesImported: number;
    readonly filesPending: number;
  };
}

export interface OpsMonitoredSourceFile {
  readonly id: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly fileName: string;
  readonly extension: string;
  readonly sizeBytes?: number;
  readonly modifiedAt?: string;
  readonly contentHash?: string;
  readonly lastSeenAt: string;
  readonly existsNow: boolean;
  readonly artifactId?: string;
  readonly lastImportRunId?: string;
  readonly lastImportedHash?: string;
  readonly lastImportedAt?: string;
  readonly lastStatus: FileStatus;
  readonly errorMessage?: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OpsSourceScanRun {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly status: RunStatus;
  readonly filesSeen: number;
  readonly newFiles: number;
  readonly changedFiles: number;
  readonly deletedFiles: number;
  readonly erroredFiles: number;
  readonly notes?: string;
  readonly result: Record<string, unknown>;
}

export interface OpsSourceImportRun {
  readonly id: string;
  readonly triggerType: ImportTriggerType;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly status: RunStatus;
  readonly filesAttempted: number;
  readonly filesImported: number;
  readonly filesSkipped: number;
  readonly filesFailed: number;
  readonly brainJobIds: readonly string[];
  readonly notes?: string;
  readonly result: Record<string, unknown>;
}

export interface OpsMonitoredSourcePreview {
  readonly source: OpsMonitoredSourceSummary;
  readonly latestScan?: OpsSourceScanRun;
  readonly latestImport?: OpsSourceImportRun;
  readonly preview: {
    readonly totalFiles: number;
    readonly markdownFiles: number;
    readonly textFiles: number;
    readonly newFiles: number;
    readonly changedFiles: number;
    readonly unchangedFiles: number;
    readonly deletedFiles: number;
    readonly erroredFiles: number;
    readonly estimatedTotalSizeBytes: number;
    readonly latestModifiedFile?: {
      readonly relativePath: string;
      readonly modifiedAt?: string;
    };
    readonly exampleMatchedPaths: readonly string[];
    readonly ignoredFiles: readonly string[];
  };
  readonly files: readonly OpsMonitoredSourceFile[];
}

export interface ProcessScheduledMonitoredSourcesOptions {
  readonly sourceId?: string;
  readonly now?: Date;
  readonly importAfterScan?: boolean;
  readonly limit?: number;
}

export interface ProcessScheduledMonitoredSourcesResult {
  readonly checkedAt: string;
  readonly importAfterScan: boolean;
  readonly dueSourceCount: number;
  readonly processedCount: number;
  readonly skippedCount: number;
  readonly results: ReadonlyArray<{
    readonly sourceId: string;
    readonly label: string;
    readonly scanSchedule: string;
    readonly action: "imported" | "scanned" | "skipped" | "failed";
    readonly reason?: string;
    readonly importRunId?: string;
    readonly preview?: OpsMonitoredSourcePreview["preview"];
    readonly error?: string;
  }>;
}

export interface OpsRuntimeOperationsSettings {
  readonly sourceMonitor: {
    readonly enabled: boolean;
    readonly workerIntervalSeconds: number;
    readonly defaultScanSchedule: string;
    readonly autoImportOnScan: boolean;
  };
  readonly outbox: {
    readonly workerIntervalSeconds: number;
    readonly batchLimit: number;
  };
  readonly temporalSummary: {
    readonly enabled: boolean;
    readonly workerIntervalSeconds: number;
    readonly lookbackDays: number;
    readonly strategy: "deterministic" | "deterministic_plus_llm";
    readonly summarizerProvider: "external" | "openrouter" | "gemini";
    readonly summarizerModel?: string;
    readonly summarizerPreset?: string;
    readonly systemPrompt?: string;
  };
}

export interface CreateMonitoredSourceRequest {
  readonly sourceType: MonitoredSourceType;
  readonly namespaceId?: string;
  readonly label?: string;
  readonly rootPath: string;
  readonly includeSubfolders?: boolean;
  readonly monitorEnabled?: boolean;
  readonly scanSchedule?: string;
  readonly notes?: string;
  readonly createdBy?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface UpdateMonitoredSourceRequest {
  readonly namespaceId?: string;
  readonly label?: string;
  readonly rootPath?: string;
  readonly includeSubfolders?: boolean;
  readonly monitorEnabled?: boolean;
  readonly scanSchedule?: string;
  readonly status?: MonitoredSourceStatus;
  readonly notes?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface UpdateBootstrapStateRequest {
  readonly ownerProfileCompleted?: boolean;
  readonly sourceImportCompleted?: boolean;
  readonly verificationCompleted?: boolean;
  readonly metadata?: Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function requireNonEmpty(value: string, name: string): string {
  if (!value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function toNumber(value: string | number | null): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sanitizeExtensions(input?: readonly string[]): string[] {
  const normalized = [...new Set((input ?? SUPPORTED_FILE_EXTENSIONS).map((value) => value.trim().toLowerCase()))];
  const allowed = normalized.filter((value) => SUPPORTED_FILE_EXTENSIONS.includes(value as (typeof SUPPORTED_FILE_EXTENSIONS)[number]));
  return allowed.length > 0 ? allowed : [...SUPPORTED_FILE_EXTENSIONS];
}

async function validateDirectoryPath(inputPath: string): Promise<string> {
  const resolvedPath = path.resolve(requireNonEmpty(inputPath, "root_path"));
  await access(resolvedPath, fsConstants.R_OK);
  const info = await stat(resolvedPath);
  if (!info.isDirectory()) {
    throw new Error(`Source path must be a directory: ${resolvedPath}`);
  }
  return resolvedPath;
}

function defaultNamespaceId(): string {
  return readConfig().namespaceDefault;
}

function mapBootstrapState(row: BootstrapStateRow): OpsBootstrapState {
  const metadata = row.metadata ?? {};
  const purposeCompleted = typeof metadata.brainPurposeMode === "string" && metadata.brainPurposeMode.trim().length > 0;
  const intelligenceCompleted =
    typeof metadata.intelligenceSetupCompletedAt === "string" || typeof metadata.intelligenceMode === "string";
  const completedSteps = [
    purposeCompleted,
    intelligenceCompleted,
    row.owner_profile_completed,
    row.source_import_completed,
    row.verification_completed
  ].filter(Boolean).length;
  return {
    ownerProfileCompleted: row.owner_profile_completed,
    sourceImportCompleted: row.source_import_completed,
    verificationCompleted: row.verification_completed,
    onboardingCompletedAt: row.onboarding_completed_at ?? undefined,
    metadata,
    updatedAt: row.updated_at,
    progress: {
      completedSteps,
      totalSteps: 5,
      onboardingComplete: Boolean(row.onboarding_completed_at)
    }
  };
}

function mapSource(row: MonitoredSourceRow): OpsMonitoredSource {
  return {
    id: row.id,
    sourceType: row.source_type,
    namespaceId: row.namespace_id,
    label: row.label,
    rootPath: row.root_path,
    includeSubfolders: row.include_subfolders,
    fileExtensions: sanitizeExtensions(asStringArray(row.file_extensions_json)),
    monitorEnabled: row.monitor_enabled,
    scanSchedule: row.scan_schedule,
    status: row.status,
    createdBy: row.created_by ?? undefined,
    notes: row.notes ?? undefined,
    metadata: row.metadata ?? {},
    lastScanAt: row.last_scan_at ?? undefined,
    lastImportAt: row.last_import_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSourceSummary(row: MonitoredSourceListRow): OpsMonitoredSourceSummary {
  return {
    ...mapSource(row),
    counts: {
      filesDiscovered: row.files_discovered ?? 0,
      filesImported: row.files_imported ?? 0,
      filesPending: row.files_pending ?? 0
    }
  };
}

function mapSourceFile(row: MonitoredSourceFileRow): OpsMonitoredSourceFile {
  return {
    id: row.id,
    absolutePath: row.absolute_path,
    relativePath: row.relative_path,
    fileName: row.file_name,
    extension: row.extension,
    sizeBytes: toNumber(row.size_bytes),
    modifiedAt: row.modified_at ?? undefined,
    contentHash: row.content_hash ?? undefined,
    lastSeenAt: row.last_seen_at,
    existsNow: row.exists_now,
    artifactId: row.artifact_id ?? undefined,
    lastImportRunId: row.last_import_run_id ?? undefined,
    lastImportedHash: row.last_imported_hash ?? undefined,
    lastImportedAt: row.last_imported_at ?? undefined,
    lastStatus: row.last_status,
    errorMessage: row.error_message ?? undefined,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapScanRun(row: ScanRunRow): OpsSourceScanRun {
  return {
    id: row.id,
    startedAt: row.scan_started_at,
    finishedAt: row.scan_finished_at ?? undefined,
    status: row.status,
    filesSeen: row.files_seen,
    newFiles: row.new_files,
    changedFiles: row.changed_files,
    deletedFiles: row.deleted_files,
    erroredFiles: row.errored_files,
    notes: row.notes ?? undefined,
    result: row.result_json ?? {}
  };
}

function mapImportRun(row: ImportRunRow): OpsSourceImportRun {
  return {
    id: row.id,
    triggerType: row.trigger_type,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    status: row.status,
    filesAttempted: row.files_attempted,
    filesImported: row.files_imported,
    filesSkipped: row.files_skipped,
    filesFailed: row.files_failed,
    brainJobIds: asStringArray(row.brain_job_ids_json),
    notes: row.notes ?? undefined,
    result: row.result_json ?? {}
  };
}

async function getBootstrapStateRow(): Promise<BootstrapStateRow> {
  const rows = await queryRows<BootstrapStateRow>(
    `
      INSERT INTO ops.bootstrap_state (id)
      VALUES (true)
      ON CONFLICT (id) DO NOTHING
      RETURNING
        id,
        owner_profile_completed,
        source_import_completed,
        verification_completed,
        onboarding_completed_at,
        metadata,
        updated_at
    `
  );

  if (rows[0]) {
    return rows[0];
  }

  const existing = await queryRows<BootstrapStateRow>(
    `
      SELECT
        id,
        owner_profile_completed,
        source_import_completed,
        verification_completed,
        onboarding_completed_at,
        metadata,
        updated_at
      FROM ops.bootstrap_state
      WHERE id = true
      LIMIT 1
    `
  );

  if (!existing[0]) {
    throw new Error("Bootstrap state not found.");
  }

  return existing[0];
}

async function getSourceRow(sourceId: string): Promise<MonitoredSourceRow> {
  const rows = await queryRows<MonitoredSourceRow>(
    `
      SELECT
        id::text,
        source_type,
        namespace_id,
        label,
        root_path,
        include_subfolders,
        file_extensions_json,
        monitor_enabled,
        scan_schedule,
        status,
        created_by,
        notes,
        metadata,
        last_scan_at,
        last_import_at,
        created_at,
        updated_at
      FROM ops.monitored_sources
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [sourceId]
  );

  if (!rows[0]) {
    throw new Error(`Monitored source ${sourceId} not found.`);
  }

  return rows[0];
}

async function listMonitorEnabledSourceRows(limit = 100): Promise<MonitoredSourceRow[]> {
  return queryRows<MonitoredSourceRow>(
    `
      SELECT
        id::text,
        source_type,
        namespace_id,
        label,
        root_path,
        include_subfolders,
        file_extensions_json,
        monitor_enabled,
        scan_schedule,
        status,
        created_by,
        notes,
        metadata,
        last_scan_at,
        last_import_at,
        created_at,
        updated_at
      FROM ops.monitored_sources
      WHERE monitor_enabled = true
        AND status <> 'disabled'
      ORDER BY
        COALESCE(last_scan_at, created_at) ASC,
        updated_at ASC
      LIMIT $1
    `,
    [limit]
  );
}

async function listSourceFilesRows(sourceId: string, limit = 200): Promise<MonitoredSourceFileRow[]> {
  return queryRows<MonitoredSourceFileRow>(
    `
      SELECT
        id::text,
        source_id::text,
        absolute_path,
        relative_path,
        file_name,
        extension,
        size_bytes,
        modified_at,
        content_hash,
        last_seen_at,
        exists_now,
        artifact_id::text,
        last_import_run_id::text,
        last_imported_hash,
        last_imported_at,
        last_status,
        error_message,
        metadata,
        created_at,
        updated_at
      FROM ops.monitored_source_files
      WHERE source_id = $1::uuid
      ORDER BY
        CASE last_status
          WHEN 'new' THEN 0
          WHEN 'changed' THEN 1
          WHEN 'error' THEN 2
          WHEN 'unchanged' THEN 3
          WHEN 'imported' THEN 4
          WHEN 'deleted' THEN 5
          ELSE 6
        END,
        relative_path ASC
      LIMIT $2
    `,
    [sourceId, limit]
  );
}

async function getLatestScanRunRow(sourceId: string): Promise<ScanRunRow | undefined> {
  const rows = await queryRows<ScanRunRow>(
    `
      SELECT
        id::text,
        source_id::text,
        scan_started_at,
        scan_finished_at,
        status,
        files_seen,
        new_files,
        changed_files,
        deleted_files,
        errored_files,
        notes,
        result_json
      FROM ops.source_scan_runs
      WHERE source_id = $1::uuid
      ORDER BY scan_started_at DESC
      LIMIT 1
    `,
    [sourceId]
  );

  return rows[0];
}

async function getLatestImportRunRow(sourceId: string): Promise<ImportRunRow | undefined> {
  const rows = await queryRows<ImportRunRow>(
    `
      SELECT
        id::text,
        source_id::text,
        trigger_type,
        started_at,
        finished_at,
        status,
        files_attempted,
        files_imported,
        files_skipped,
        files_failed,
        brain_job_ids_json,
        notes,
        result_json
      FROM ops.source_import_runs
      WHERE source_id = $1::uuid
      ORDER BY started_at DESC
      LIMIT 1
    `,
    [sourceId]
  );

  return rows[0];
}

async function loadExistingFileState(sourceId: string): Promise<Map<string, MonitoredSourceFileRow>> {
  const rows = await queryRows<MonitoredSourceFileRow>(
    `
      SELECT
        id::text,
        source_id::text,
        absolute_path,
        relative_path,
        file_name,
        extension,
        size_bytes,
        modified_at,
        content_hash,
        last_seen_at,
        exists_now,
        artifact_id::text,
        last_import_run_id::text,
        last_imported_hash,
        last_imported_at,
        last_status,
        error_message,
        metadata,
        created_at,
        updated_at
      FROM ops.monitored_source_files
      WHERE source_id = $1::uuid
    `,
    [sourceId]
  );

  return new Map(rows.map((row) => [row.absolute_path, row]));
}

async function walkCandidateFiles(rootPath: string, includeSubfolders: boolean): Promise<{
  readonly matched: readonly string[];
  readonly ignored: readonly string[];
}> {
  const matched: string[] = [];
  const ignored: string[] = [];

  async function visitDirectory(dirPath: string): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (includeSubfolders) {
          await visitDirectory(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_FILE_EXTENSIONS.includes(extension as (typeof SUPPORTED_FILE_EXTENSIONS)[number])) {
        matched.push(fullPath);
      } else {
        ignored.push(fullPath);
      }
    }
  }

  await visitDirectory(rootPath);
  matched.sort((left, right) => left.localeCompare(right));
  ignored.sort((left, right) => left.localeCompare(right));
  return { matched, ignored };
}

function scheduleToIntervalMs(scanSchedule: string): number | null {
  const normalized = scanSchedule.trim().toLowerCase();
  if (!normalized || normalized === "disabled") {
    return null;
  }
  if (normalized === "hourly") {
    return 60 * 60 * 1000;
  }
  if (normalized === "daily") {
    return 24 * 60 * 60 * 1000;
  }
  const everyMinutes = normalized.match(/^every_(\d+)_minutes$/);
  if (everyMinutes) {
    const minutes = Number(everyMinutes[1]);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : null;
  }
  return null;
}

function isSourceDue(row: MonitoredSourceRow, now: Date): boolean {
  if (!row.monitor_enabled || row.status === "disabled") {
    return false;
  }
  const intervalMs = scheduleToIntervalMs(row.scan_schedule);
  if (intervalMs === null) {
    return false;
  }
  const lastTouchedAt = row.last_scan_at ?? row.created_at;
  const lastTouchedMs = Date.parse(lastTouchedAt);
  if (!Number.isFinite(lastTouchedMs)) {
    return true;
  }
  return now.getTime() - lastTouchedMs >= intervalMs;
}

async function fingerprintFile(rootPath: string, absolutePath: string, existing?: MonitoredSourceFileRow): Promise<ScannedFileCandidate> {
  const relativePath = path.relative(rootPath, absolutePath) || path.basename(absolutePath);
  const fileName = path.basename(absolutePath);
  const extension = path.extname(fileName).toLowerCase();

  try {
    const fileStat = await stat(absolutePath);
    const buffer = await readFile(absolutePath);
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const modifiedAt = fileStat.mtime.toISOString();
    const unchanged = existing?.content_hash === contentHash && existing.exists_now;

    return {
      absolutePath,
      relativePath,
      fileName,
      extension,
      sizeBytes: fileStat.size,
      modifiedAt,
      contentHash,
      lastStatus: unchanged ? "unchanged" : existing ? "changed" : "new"
    };
  } catch (error) {
    return {
      absolutePath,
      relativePath,
      fileName,
      extension,
      lastStatus: "error",
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }
}

function resultSourceTypeFor(extension: string): SourceType {
  return extension === ".md" ? "markdown" : "text";
}

export async function getBootstrapState(): Promise<OpsBootstrapState> {
  const row = await getBootstrapStateRow();
  return mapBootstrapState(row);
}

export function resolveRuntimeOperationsSettings(metadata: Record<string, unknown>): OpsRuntimeOperationsSettings {
  const operations = metadata.operationsSettings;
  const typed =
    operations && typeof operations === "object" && !Array.isArray(operations)
      ? (operations as Record<string, unknown>)
      : {};
  const sourceMonitor =
    typed.sourceMonitor && typeof typed.sourceMonitor === "object" && !Array.isArray(typed.sourceMonitor)
      ? (typed.sourceMonitor as Record<string, unknown>)
      : {};
  const outbox =
    typed.outbox && typeof typed.outbox === "object" && !Array.isArray(typed.outbox)
      ? (typed.outbox as Record<string, unknown>)
      : {};
  const temporalSummary =
    typed.temporalSummary && typeof typed.temporalSummary === "object" && !Array.isArray(typed.temporalSummary)
      ? (typed.temporalSummary as Record<string, unknown>)
      : {};

  return {
    sourceMonitor: {
      enabled: Boolean(sourceMonitor.enabled ?? false),
      workerIntervalSeconds:
        typeof sourceMonitor.workerIntervalSeconds === "number" && Number.isFinite(sourceMonitor.workerIntervalSeconds)
          ? Math.max(5, sourceMonitor.workerIntervalSeconds)
          : 60,
      defaultScanSchedule:
        typeof sourceMonitor.defaultScanSchedule === "string" && sourceMonitor.defaultScanSchedule.trim()
          ? sourceMonitor.defaultScanSchedule
          : DEFAULT_SCAN_SCHEDULE,
      autoImportOnScan: sourceMonitor.autoImportOnScan === undefined ? true : Boolean(sourceMonitor.autoImportOnScan)
    },
    outbox: {
      workerIntervalSeconds:
        typeof outbox.workerIntervalSeconds === "number" && Number.isFinite(outbox.workerIntervalSeconds)
          ? Math.max(5, outbox.workerIntervalSeconds)
          : 30,
      batchLimit:
        typeof outbox.batchLimit === "number" && Number.isFinite(outbox.batchLimit)
          ? Math.max(1, outbox.batchLimit)
          : 25
    },
    temporalSummary: {
      enabled: temporalSummary.enabled === undefined ? true : Boolean(temporalSummary.enabled),
      workerIntervalSeconds:
        typeof temporalSummary.workerIntervalSeconds === "number" && Number.isFinite(temporalSummary.workerIntervalSeconds)
          ? Math.max(30, temporalSummary.workerIntervalSeconds)
          : 300,
      lookbackDays:
        typeof temporalSummary.lookbackDays === "number" && Number.isFinite(temporalSummary.lookbackDays)
          ? Math.max(1, temporalSummary.lookbackDays)
          : 30,
      strategy:
        temporalSummary.strategy === "deterministic_plus_llm"
          ? "deterministic_plus_llm"
          : "deterministic",
      summarizerProvider:
        temporalSummary.summarizerProvider === "openrouter" || temporalSummary.summarizerProvider === "gemini"
          ? temporalSummary.summarizerProvider
          : "external",
      summarizerModel:
        typeof temporalSummary.summarizerModel === "string" && temporalSummary.summarizerModel.trim()
          ? temporalSummary.summarizerModel
          : undefined,
      summarizerPreset:
        typeof temporalSummary.summarizerPreset === "string" && temporalSummary.summarizerPreset.trim()
          ? temporalSummary.summarizerPreset
          : undefined,
      systemPrompt:
        typeof temporalSummary.systemPrompt === "string" && temporalSummary.systemPrompt.trim()
          ? temporalSummary.systemPrompt
          : undefined
    }
  };
}

export async function updateBootstrapState(input: UpdateBootstrapStateRequest): Promise<OpsBootstrapState> {
  const existing = await getBootstrapStateRow();
  const nextOwnerProfileCompleted = input.ownerProfileCompleted ?? existing.owner_profile_completed;
  const nextSourceImportCompleted = input.sourceImportCompleted ?? existing.source_import_completed;
  const nextVerificationCompleted = input.verificationCompleted ?? existing.verification_completed;
  const nextMetadata = {
    ...(existing.metadata ?? {}),
    ...(input.metadata ?? {})
  };
  const nextPurposeCompleted = typeof nextMetadata.brainPurposeMode === "string" && nextMetadata.brainPurposeMode.trim().length > 0;
  const nextIntelligenceCompleted =
    typeof nextMetadata.intelligenceSetupCompletedAt === "string" || typeof nextMetadata.intelligenceMode === "string";
  const nextOnboardingCompletedAt =
    nextPurposeCompleted && nextIntelligenceCompleted && nextOwnerProfileCompleted && nextSourceImportCompleted && nextVerificationCompleted
      ? existing.onboarding_completed_at ?? new Date().toISOString()
      : null;

  const rows = await queryRows<BootstrapStateRow>(
    `
      UPDATE ops.bootstrap_state
      SET
        owner_profile_completed = $1,
        source_import_completed = $2,
        verification_completed = $3,
        onboarding_completed_at = $4::timestamptz,
        metadata = $5::jsonb,
        updated_at = now()
      WHERE id = true
      RETURNING
        id,
        owner_profile_completed,
        source_import_completed,
        verification_completed,
        onboarding_completed_at,
        metadata,
        updated_at
    `,
    [
      nextOwnerProfileCompleted,
      nextSourceImportCompleted,
      nextVerificationCompleted,
      nextOnboardingCompletedAt,
      JSON.stringify(nextMetadata)
    ]
  );

  return mapBootstrapState(rows[0]!);
}

export async function listMonitoredSources(limit = 100): Promise<OpsMonitoredSourceSummary[]> {
  const rows = await queryRows<MonitoredSourceListRow>(
    `
      SELECT
        s.id::text,
        s.source_type,
        s.namespace_id,
        s.label,
        s.root_path,
        s.include_subfolders,
        s.file_extensions_json,
        s.monitor_enabled,
        s.scan_schedule,
        s.status,
        s.created_by,
        s.notes,
        s.metadata,
        s.last_scan_at,
        s.last_import_at,
        s.created_at,
        s.updated_at,
        COALESCE((
          SELECT COUNT(*)::int
          FROM ops.monitored_source_files f
          WHERE f.source_id = s.id
            AND f.exists_now = true
        ), 0) AS files_discovered,
        COALESCE((
          SELECT COUNT(*)::int
          FROM ops.monitored_source_files f
          WHERE f.source_id = s.id
            AND f.last_imported_at IS NOT NULL
        ), 0) AS files_imported,
        COALESCE((
          SELECT COUNT(*)::int
          FROM ops.monitored_source_files f
          WHERE f.source_id = s.id
            AND f.exists_now = true
            AND (f.last_imported_hash IS DISTINCT FROM f.content_hash OR f.last_imported_hash IS NULL)
        ), 0) AS files_pending
      FROM ops.monitored_sources s
      ORDER BY s.updated_at DESC, s.created_at DESC
      LIMIT $1
    `,
    [limit]
  );

  return rows.map(mapSourceSummary);
}

export async function createMonitoredSource(input: CreateMonitoredSourceRequest): Promise<OpsMonitoredSourceSummary> {
  const rootPath = await validateDirectoryPath(input.rootPath);
  const sourceType = input.sourceType;
  const namespaceId = input.namespaceId?.trim() || defaultNamespaceId();
  const label =
    input.label?.trim() ||
    (sourceType === "openclaw" ? `OpenClaw ${path.basename(rootPath)}` : path.basename(rootPath) || "Memory folder");
  const fileExtensions = sanitizeExtensions();
  const monitorEnabled = Boolean(input.monitorEnabled);
  const scanSchedule = monitorEnabled ? input.scanSchedule?.trim() || DEFAULT_SCAN_SCHEDULE : "disabled";

  const rows = await queryRows<MonitoredSourceListRow>(
    `
      INSERT INTO ops.monitored_sources (
        source_type,
        namespace_id,
        label,
        root_path,
        include_subfolders,
        file_extensions_json,
        monitor_enabled,
        scan_schedule,
        status,
        created_by,
        notes,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'ready', $9, $10, $11::jsonb)
      RETURNING
        id::text,
        source_type,
        namespace_id,
        label,
        root_path,
        include_subfolders,
        file_extensions_json,
        monitor_enabled,
        scan_schedule,
        status,
        created_by,
        notes,
        metadata,
        last_scan_at,
        last_import_at,
        created_at,
        updated_at,
        0::int AS files_discovered,
        0::int AS files_imported,
        0::int AS files_pending
    `,
    [
      sourceType,
      namespaceId,
      label,
      rootPath,
      input.includeSubfolders ?? true,
      JSON.stringify(fileExtensions),
      monitorEnabled,
      scanSchedule,
      input.createdBy ?? "operator",
      input.notes?.trim() || null,
      JSON.stringify(input.metadata ?? {})
    ]
  );

  return mapSourceSummary(rows[0]!);
}

export async function updateMonitoredSource(sourceId: string, input: UpdateMonitoredSourceRequest): Promise<OpsMonitoredSourceSummary> {
  const existing = await getSourceRow(sourceId);
  const rootPath = input.rootPath === undefined ? existing.root_path : await validateDirectoryPath(input.rootPath);
  const nextMetadata = {
    ...(existing.metadata ?? {}),
    ...(input.metadata ?? {})
  };
  const monitorEnabled = input.monitorEnabled ?? existing.monitor_enabled;
  const scanSchedule = monitorEnabled ? input.scanSchedule?.trim() || existing.scan_schedule || DEFAULT_SCAN_SCHEDULE : "disabled";

  const rows = await queryRows<MonitoredSourceListRow>(
    `
      UPDATE ops.monitored_sources
      SET
        namespace_id = $2,
        label = $3,
        root_path = $4,
        include_subfolders = $5,
        monitor_enabled = $6,
        scan_schedule = $7,
        status = $8,
        notes = $9,
        metadata = $10::jsonb,
        updated_at = now()
      WHERE id = $1::uuid
      RETURNING
        id::text,
        source_type,
        namespace_id,
        label,
        root_path,
        include_subfolders,
        file_extensions_json,
        monitor_enabled,
        scan_schedule,
        status,
        created_by,
        notes,
        metadata,
        last_scan_at,
        last_import_at,
        created_at,
        updated_at,
        COALESCE((
          SELECT COUNT(*)::int
          FROM ops.monitored_source_files f
          WHERE f.source_id = ops.monitored_sources.id
            AND f.exists_now = true
        ), 0) AS files_discovered,
        COALESCE((
          SELECT COUNT(*)::int
          FROM ops.monitored_source_files f
          WHERE f.source_id = ops.monitored_sources.id
            AND f.last_imported_at IS NOT NULL
        ), 0) AS files_imported,
        COALESCE((
          SELECT COUNT(*)::int
          FROM ops.monitored_source_files f
          WHERE f.source_id = ops.monitored_sources.id
            AND f.exists_now = true
            AND (f.last_imported_hash IS DISTINCT FROM f.content_hash OR f.last_imported_hash IS NULL)
        ), 0) AS files_pending
    `,
    [
      sourceId,
      input.namespaceId?.trim() || existing.namespace_id,
      input.label?.trim() || existing.label,
      rootPath,
      input.includeSubfolders ?? existing.include_subfolders,
      monitorEnabled,
      scanSchedule,
      input.status ?? existing.status,
      input.notes === undefined ? existing.notes : input.notes?.trim() || null,
      JSON.stringify(nextMetadata)
    ]
  );

  return mapSourceSummary(rows[0]!);
}

export async function deleteMonitoredSource(sourceId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query("DELETE FROM ops.monitored_sources WHERE id = $1::uuid", [sourceId]);
  });
}

export async function listMonitoredSourceFiles(sourceId: string, limit = 200): Promise<readonly OpsMonitoredSourceFile[]> {
  await getSourceRow(sourceId);
  const rows = await listSourceFilesRows(sourceId, limit);
  return rows.map(mapSourceFile);
}

export async function scanMonitoredSource(sourceId: string): Promise<OpsMonitoredSourcePreview> {
  const existingSource = await getSourceRow(sourceId);
  const rootPath = await validateDirectoryPath(existingSource.root_path);
  const { matched, ignored } = await walkCandidateFiles(rootPath, existingSource.include_subfolders);
  const existingFiles = await loadExistingFileState(sourceId);
  const scannedAt = new Date().toISOString();
  const candidates: ScannedFileCandidate[] = [];

  for (const filePath of matched) {
    candidates.push(await fingerprintFile(rootPath, filePath, existingFiles.get(filePath)));
  }

  const seenPaths = new Set(candidates.map((candidate) => candidate.absolutePath));
  const deletedPaths = [...existingFiles.values()]
    .filter((row) => row.exists_now && !seenPaths.has(row.absolute_path))
    .map((row) => row.absolute_path);

  const newFiles = candidates.filter((candidate) => candidate.lastStatus === "new").length;
  const changedFiles = candidates.filter((candidate) => candidate.lastStatus === "changed").length;
  const unchangedFiles = candidates.filter((candidate) => candidate.lastStatus === "unchanged").length;
  const erroredFiles = candidates.filter((candidate) => candidate.lastStatus === "error").length;
  const latestModifiedCandidate = [...candidates]
    .filter((candidate) => candidate.modifiedAt)
    .sort((left, right) => (right.modifiedAt ?? "").localeCompare(left.modifiedAt ?? ""))[0];
  const estimatedTotalSizeBytes = candidates.reduce((sum, candidate) => sum + (candidate.sizeBytes ?? 0), 0);
  const previewSummary = {
    totalFiles: candidates.length,
    markdownFiles: candidates.filter((candidate) => candidate.extension === ".md").length,
    textFiles: candidates.filter((candidate) => candidate.extension === ".txt").length,
    newFiles,
    changedFiles,
    unchangedFiles,
    deletedFiles: deletedPaths.length,
    erroredFiles,
    estimatedTotalSizeBytes,
    latestModifiedFile: latestModifiedCandidate
      ? {
          relativePath: latestModifiedCandidate.relativePath,
          modifiedAt: latestModifiedCandidate.modifiedAt
        }
      : undefined,
    exampleMatchedPaths: candidates.slice(0, 8).map((candidate) => candidate.relativePath),
    ignoredFiles: ignored.slice(0, 12).map((ignoredPath) => path.relative(rootPath, ignoredPath) || path.basename(ignoredPath))
  };

  const scanStatus: RunStatus = erroredFiles > 0 ? (candidates.length > erroredFiles ? "partial" : "failed") : "succeeded";

  await withTransaction(async (client) => {
    for (const candidate of candidates) {
      await client.query(
        `
          INSERT INTO ops.monitored_source_files (
            source_id,
            absolute_path,
            relative_path,
            file_name,
            extension,
            size_bytes,
            modified_at,
            content_hash,
            last_seen_at,
            exists_now,
            last_status,
            error_message,
            metadata
          )
          VALUES (
            $1::uuid,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7::timestamptz,
            $8,
            $9::timestamptz,
            true,
            $10,
            $11,
            $12::jsonb
          )
          ON CONFLICT (source_id, absolute_path)
          DO UPDATE SET
            relative_path = EXCLUDED.relative_path,
            file_name = EXCLUDED.file_name,
            extension = EXCLUDED.extension,
            size_bytes = EXCLUDED.size_bytes,
            modified_at = EXCLUDED.modified_at,
            content_hash = EXCLUDED.content_hash,
            last_seen_at = EXCLUDED.last_seen_at,
            exists_now = EXCLUDED.exists_now,
            last_status = EXCLUDED.last_status,
            error_message = EXCLUDED.error_message,
            metadata = EXCLUDED.metadata,
            updated_at = now()
        `,
        [
          sourceId,
          candidate.absolutePath,
          candidate.relativePath,
          candidate.fileName,
          candidate.extension,
          candidate.sizeBytes ?? null,
          candidate.modifiedAt ?? null,
          candidate.contentHash ?? null,
          scannedAt,
          candidate.lastStatus,
          candidate.errorMessage ?? null,
          JSON.stringify({
            source_type: existingSource.source_type,
            scan_marker: scannedAt
          })
        ]
      );
    }

    if (deletedPaths.length > 0) {
      await client.query(
        `
          UPDATE ops.monitored_source_files
          SET
            exists_now = false,
            last_seen_at = $2::timestamptz,
            last_status = 'deleted',
            updated_at = now()
          WHERE source_id = $1::uuid
            AND absolute_path = ANY($3::text[])
        `,
        [sourceId, scannedAt, deletedPaths]
      );
    }

    await client.query(
      `
        INSERT INTO ops.source_scan_runs (
          source_id,
          scan_started_at,
          scan_finished_at,
          status,
          files_seen,
          new_files,
          changed_files,
          deleted_files,
          errored_files,
          result_json
        )
        VALUES ($1::uuid, $2::timestamptz, now(), $3, $4, $5, $6, $7, $8, $9::jsonb)
      `,
      [
        sourceId,
        scannedAt,
        scanStatus,
        candidates.length,
        newFiles,
        changedFiles,
        deletedPaths.length,
        erroredFiles,
        JSON.stringify(previewSummary)
      ]
    );

    await client.query(
      `
        UPDATE ops.monitored_sources
        SET
          last_scan_at = now(),
          status = $2,
          updated_at = now()
        WHERE id = $1::uuid
      `,
      [sourceId, scanStatus === "failed" ? "error" : existingSource.status === "disabled" ? "disabled" : "ready"]
    );
  });

  return getMonitoredSourcePreview(sourceId);
}

export async function importMonitoredSource(
  sourceId: string,
  triggerType: ImportTriggerType = "manual"
): Promise<{
  readonly source: OpsMonitoredSourceSummary;
  readonly importRun: OpsSourceImportRun;
  readonly preview: OpsMonitoredSourcePreview;
}> {
  await scanMonitoredSource(sourceId);
  const sourceRow = await getSourceRow(sourceId);
  const pendingRows = await queryRows<MonitoredSourceFileRow>(
    `
      SELECT
        id::text,
        source_id::text,
        absolute_path,
        relative_path,
        file_name,
        extension,
        size_bytes,
        modified_at,
        content_hash,
        last_seen_at,
        exists_now,
        artifact_id::text,
        last_import_run_id::text,
        last_imported_hash,
        last_imported_at,
        last_status,
        error_message,
        metadata,
        created_at,
        updated_at
      FROM ops.monitored_source_files
      WHERE source_id = $1::uuid
        AND exists_now = true
        AND content_hash IS NOT NULL
        AND (last_imported_hash IS DISTINCT FROM content_hash OR last_imported_hash IS NULL)
      ORDER BY relative_path ASC
    `,
    [sourceId]
  );

  const importRunRows = await queryRows<ImportRunRow>(
    `
      INSERT INTO ops.source_import_runs (
        source_id,
        trigger_type,
        started_at,
        status,
        files_attempted,
        files_imported,
        files_skipped,
        files_failed,
        brain_job_ids_json,
        result_json
      )
      VALUES ($1::uuid, $2, now(), 'running', 0, 0, 0, 0, '[]'::jsonb, '{}'::jsonb)
      RETURNING
        id::text,
        source_id::text,
        trigger_type,
        started_at,
        finished_at,
        status,
        files_attempted,
        files_imported,
        files_skipped,
        files_failed,
        brain_job_ids_json,
        notes,
        result_json
    `,
    [sourceId, triggerType]
  );

  const importRunId = importRunRows[0]!.id;
  const importedArtifactIds: string[] = [];
  let filesImported = 0;
  let filesFailed = 0;

  for (const row of pendingRows) {
    try {
      const ingestResult = await ingestArtifact({
        inputUri: row.absolute_path,
        namespaceId: sourceRow.namespace_id,
        sourceType: resultSourceTypeFor(row.extension),
        sourceChannel: `bootstrap:${sourceRow.source_type}`,
        capturedAt: row.modified_at ?? new Date().toISOString(),
        metadata: {
          bootstrap_import: true,
          monitored_source: true,
          monitored_source_id: sourceId,
          monitored_source_file_id: row.id,
          monitored_source_type: sourceRow.source_type,
          monitored_source_root_path: sourceRow.root_path,
          monitored_import_run_id: importRunId,
          relative_path: row.relative_path
        }
      });

      importedArtifactIds.push(ingestResult.artifact.artifactId);
      filesImported += 1;

      await withTransaction(async (client) => {
        await client.query(
          `
            UPDATE ops.monitored_source_files
            SET
              artifact_id = $2::uuid,
              last_import_run_id = $3::uuid,
              last_imported_hash = content_hash,
              last_imported_at = now(),
              last_status = 'imported',
              error_message = NULL,
              updated_at = now()
            WHERE id = $1::uuid
          `,
          [row.id, ingestResult.artifact.artifactId, importRunId]
        );
      });
    } catch (error) {
      filesFailed += 1;
      await withTransaction(async (client) => {
        await client.query(
          `
            UPDATE ops.monitored_source_files
            SET
              last_status = 'error',
              error_message = $2,
              updated_at = now()
            WHERE id = $1::uuid
          `,
          [row.id, error instanceof Error ? error.message : String(error)]
        );
      });
    }
  }

  const filesAttempted = pendingRows.length;
  const filesSkipped = Math.max(0, (await countSourceFiles(sourceId)) - filesAttempted);
  const finalStatus: RunStatus =
    filesFailed > 0 ? (filesImported > 0 ? "partial" : "failed") : "succeeded";

  const importRun = (
    await queryRows<ImportRunRow>(
      `
        UPDATE ops.source_import_runs
        SET
          finished_at = now(),
          status = $2,
          files_attempted = $3,
          files_imported = $4,
          files_skipped = $5,
          files_failed = $6,
          brain_job_ids_json = $7::jsonb,
          result_json = $8::jsonb
        WHERE id = $1::uuid
        RETURNING
          id::text,
          source_id::text,
          trigger_type,
          started_at,
          finished_at,
          status,
          files_attempted,
          files_imported,
          files_skipped,
          files_failed,
          brain_job_ids_json,
          notes,
          result_json
      `,
      [
        importRunId,
        finalStatus,
        filesAttempted,
        filesImported,
        filesSkipped,
        filesFailed,
        JSON.stringify(importedArtifactIds),
        JSON.stringify({
          imported_artifact_ids: importedArtifactIds,
          source_label: sourceRow.label
        })
      ]
    )
  )[0]!;

  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE ops.monitored_sources
        SET
          last_import_at = now(),
          updated_at = now(),
          status = $2
        WHERE id = $1::uuid
      `,
      [sourceId, finalStatus === "failed" ? "error" : sourceRow.status === "disabled" ? "disabled" : "ready"]
    );
  });

  const source = (await listMonitoredSources()).find((item) => item.id === sourceId);
  if (!source) {
    throw new Error(`Monitored source ${sourceId} not found after import.`);
  }

  return {
    source,
    importRun: mapImportRun(importRun),
    preview: await getMonitoredSourcePreview(sourceId)
  };
}

async function countSourceFiles(sourceId: string): Promise<number> {
  const rows = await queryRows<CountRow>(
    `
      SELECT COUNT(*)::int AS total
      FROM ops.monitored_source_files
      WHERE source_id = $1::uuid
        AND exists_now = true
    `,
    [sourceId]
  );

  return rows[0]?.total ?? 0;
}

export async function getMonitoredSourcePreview(sourceId: string): Promise<OpsMonitoredSourcePreview> {
  const source = (await listMonitoredSources()).find((item) => item.id === sourceId);
  if (!source) {
    throw new Error(`Monitored source ${sourceId} not found.`);
  }

  const [files, latestScanRow, latestImportRow] = await Promise.all([
    listSourceFilesRows(sourceId, 500),
    getLatestScanRunRow(sourceId),
    getLatestImportRunRow(sourceId)
  ]);

  const latestScan = latestScanRow ? mapScanRun(latestScanRow) : undefined;
  const latestImport = latestImportRow ? mapImportRun(latestImportRow) : undefined;
  const previewFromScan = latestScan?.result ?? {};
  const latestModifiedFile =
    previewFromScan.latestModifiedFile && typeof previewFromScan.latestModifiedFile === "object"
      ? (previewFromScan.latestModifiedFile as { readonly relativePath?: string; readonly modifiedAt?: string })
      : undefined;

  return {
    source,
    latestScan,
    latestImport,
    preview: {
      totalFiles: typeof previewFromScan.totalFiles === "number" ? previewFromScan.totalFiles : files.filter((file) => file.exists_now).length,
      markdownFiles: typeof previewFromScan.markdownFiles === "number" ? previewFromScan.markdownFiles : files.filter((file) => file.extension === ".md" && file.exists_now).length,
      textFiles: typeof previewFromScan.textFiles === "number" ? previewFromScan.textFiles : files.filter((file) => file.extension === ".txt" && file.exists_now).length,
      newFiles: typeof previewFromScan.newFiles === "number" ? previewFromScan.newFiles : files.filter((file) => file.last_status === "new").length,
      changedFiles: typeof previewFromScan.changedFiles === "number" ? previewFromScan.changedFiles : files.filter((file) => file.last_status === "changed").length,
      unchangedFiles: typeof previewFromScan.unchangedFiles === "number" ? previewFromScan.unchangedFiles : files.filter((file) => file.last_status === "unchanged").length,
      deletedFiles: typeof previewFromScan.deletedFiles === "number" ? previewFromScan.deletedFiles : files.filter((file) => file.last_status === "deleted").length,
      erroredFiles: typeof previewFromScan.erroredFiles === "number" ? previewFromScan.erroredFiles : files.filter((file) => file.last_status === "error").length,
      estimatedTotalSizeBytes:
        typeof previewFromScan.estimatedTotalSizeBytes === "number"
          ? previewFromScan.estimatedTotalSizeBytes
          : files.reduce((sum, file) => sum + (toNumber(file.size_bytes) ?? 0), 0),
      latestModifiedFile:
        latestModifiedFile?.relativePath
          ? {
              relativePath: latestModifiedFile.relativePath,
              modifiedAt: latestModifiedFile.modifiedAt
            }
          : undefined,
      exampleMatchedPaths: asStringArray(previewFromScan.exampleMatchedPaths).slice(0, 8),
      ignoredFiles: asStringArray(previewFromScan.ignoredFiles).slice(0, 12)
    },
    files: files.map(mapSourceFile)
  };
}

export async function processScheduledMonitoredSources(
  options: ProcessScheduledMonitoredSourcesOptions = {}
): Promise<ProcessScheduledMonitoredSourcesResult> {
  const now = options.now ?? new Date();
  const importAfterScan = options.importAfterScan ?? true;
  const candidates = options.sourceId
    ? [await getSourceRow(options.sourceId)]
    : await listMonitorEnabledSourceRows(options.limit ?? 50);
  const dueSources = candidates.filter((row) => isSourceDue(row, now));
  const results: Array<ProcessScheduledMonitoredSourcesResult["results"][number]> = [];

  for (const row of dueSources) {
    try {
      if (importAfterScan) {
        const result = await importMonitoredSource(row.id, "scheduled");
        results.push({
          sourceId: row.id,
          label: row.label,
          scanSchedule: row.scan_schedule,
          action: "imported",
          importRunId: result.importRun.id,
          preview: result.preview.preview
        });
        continue;
      }

      const preview = await scanMonitoredSource(row.id);
      results.push({
        sourceId: row.id,
        label: row.label,
        scanSchedule: row.scan_schedule,
        action: "scanned",
        preview: preview.preview
      });
    } catch (error) {
      results.push({
        sourceId: row.id,
        label: row.label,
        scanSchedule: row.scan_schedule,
        action: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const processedCount = results.filter((item) => item.action === "imported" || item.action === "scanned").length;
  return {
    checkedAt: now.toISOString(),
    importAfterScan,
    dueSourceCount: dueSources.length,
    processedCount,
    skippedCount: Math.max(0, candidates.length - dueSources.length),
    results
  };
}
