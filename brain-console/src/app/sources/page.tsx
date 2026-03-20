import Link from "next/link";
import {
  deleteSourceAction,
  importSourceAction,
  processSourceMonitorNowAction,
  retrySourceFileAction,
  saveSourceAction,
  scanSourceAction,
  toggleSourceMonitoringAction
} from "@/app/bootstrap/actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { SourceMonitorIntentFields } from "@/components/source-monitor-intent-fields";
import { OperatorShell } from "@/components/operator-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  getBootstrapState,
  getWorkbenchSourcePreview,
  type WorkbenchMonitoredSource,
  type WorkbenchMonitoredSourceFile,
  type WorkbenchWorkerHealth,
  getWorkbenchWorkerStatus,
  listWorkbenchSourceFiles,
  listWorkbenchSources
} from "@/lib/operator-workbench";
import { requireSetupComplete } from "@/lib/setup-gating";

function formatDateTime(value?: string | null): string {
  if (!value) {
    return "not yet";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function sourceIntentLabel(value: unknown): string {
  if (typeof value !== "string" || !value) {
    return "unspecified";
  }
  return value.replace(/_/g, " ");
}

function searchValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

function scheduleIntervalMs(schedule: string): number {
  switch (schedule) {
    case "every_30_minutes":
      return 30 * 60 * 1000;
    case "hourly":
      return 60 * 60 * 1000;
    case "daily":
      return 24 * 60 * 60 * 1000;
    default:
      return 60 * 60 * 1000;
  }
}

function formatBytes(value?: number): string {
  if (!value || value <= 0) {
    return "0 B";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function fileDeltaLabel(status: string): string {
  switch (status) {
    case "new":
      return "new file";
    case "changed":
      return "changed";
    case "deleted":
      return "deleted";
    case "imported":
      return "imported";
    case "error":
      return "failed";
    default:
      return status;
  }
}

function fileDeltaTone(status: string): string {
  switch (status) {
    case "new":
      return "border-cyan-300/20 bg-cyan-300/10 text-cyan-100";
    case "changed":
      return "border-amber-300/20 bg-amber-300/10 text-amber-100";
    case "deleted":
      return "border-white/10 bg-white/5 text-slate-200";
    case "imported":
      return "border-emerald-300/20 bg-emerald-300/10 text-emerald-100";
    case "error":
      return "border-rose-300/20 bg-rose-300/10 text-rose-100";
    default:
      return "border-white/10 bg-white/5 text-slate-100";
  }
}

function importOutcome(file: WorkbenchMonitoredSourceFile): {
  readonly label: string;
  readonly tone: string;
  readonly detail: string;
  readonly retryable: boolean;
} {
  if (file.lastStatus === "error") {
    return {
      label: "last import failed",
      tone: "border-rose-300/20 bg-rose-300/10 text-rose-100",
      detail: file.errorMessage ?? "The latest import attempt failed for this file.",
      retryable: file.existsNow
    };
  }
  if (file.lastStatus === "imported") {
    return {
      label: "imported",
      tone: "border-emerald-300/20 bg-emerald-300/10 text-emerald-100",
      detail: `Imported ${formatDateTime(file.lastImportedAt)}.`,
      retryable: false
    };
  }
  if (file.lastStatus === "deleted") {
    return {
      label: "missing on disk",
      tone: "border-white/10 bg-white/5 text-slate-100",
      detail: "The file disappeared after the last scan. Re-scan the source to settle the lane.",
      retryable: false
    };
  }
  if (file.lastStatus === "new" || file.lastStatus === "changed") {
    return {
      label: "waiting to import",
      tone: "border-amber-300/20 bg-amber-300/10 text-amber-100",
      detail: file.lastStatus === "new" ? "New evidence found and waiting for import." : "Content changed and needs a fresh import.",
      retryable: file.existsNow
    };
  }
  return {
    label: "up to date",
    tone: "border-white/10 bg-white/5 text-slate-100",
    detail: "No pending import work for this file right now.",
    retryable: false
  };
}

function sourceHealth(source: WorkbenchMonitoredSource, worker?: WorkbenchWorkerHealth): {
  readonly label: string;
  readonly tone: string;
  readonly detail: string;
} {
  if (!source.monitorEnabled) {
    return {
      label: "manual lane",
      tone: "border-white/10 bg-white/5 text-slate-100",
      detail: "This source is intentionally not being watched."
    };
  }

  if (worker?.state === "failed" || worker?.state === "stale" || worker?.state === "degraded") {
    return {
      label: worker.state,
      tone:
        worker.state === "failed"
          ? "border-rose-300/20 bg-rose-300/10 text-rose-100"
          : "border-amber-300/20 bg-amber-300/10 text-amber-100",
      detail: "The shared source monitor needs attention before this watched lane is trustworthy."
    };
  }

  const lastScanMs = source.lastScanAt ? Date.parse(source.lastScanAt) : Number.NaN;
  if (!Number.isFinite(lastScanMs)) {
    return {
      label: "never scanned",
      tone: "border-amber-300/20 bg-amber-300/10 text-amber-100",
      detail: "Monitoring is enabled, but this source has not been scanned yet."
    };
  }

  const overdueMs = Date.now() - lastScanMs - scheduleIntervalMs(source.scanSchedule);
  if (overdueMs > 0) {
    return {
      label: "overdue",
      tone: "border-amber-300/20 bg-amber-300/10 text-amber-100",
      detail: `Last scan is behind the ${source.scanSchedule.replace(/_/g, " ")} schedule.`
    };
  }

  if (source.counts.filesPending > 0) {
    return {
      label: "changes waiting",
      tone: "border-cyan-300/20 bg-cyan-300/10 text-cyan-100",
      detail: `${source.counts.filesPending} file changes are staged for import.`
    };
  }

  return {
    label: "healthy",
    tone: "border-emerald-300/20 bg-emerald-300/10 text-emerald-100",
    detail: "The watched lane looks current."
  };
}

export default async function SourcesPage({
  searchParams
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  await requireSetupComplete("/sources");
  const params = await searchParams;
  const selectedSourceId = searchValue(params.source);
  const [bootstrap, sources, workerStatus] = await Promise.all([
    getBootstrapState(),
    listWorkbenchSources().catch(() => []),
    getWorkbenchWorkerStatus().catch(() => ({
      checkedAt: new Date(0).toISOString(),
      namespaceId: "personal",
      workers: []
    }))
  ]);

  const defaultNamespaceId = bootstrap.metadata.defaultNamespaceId ?? "personal";
  const selectedSource = selectedSourceId ? sources.find((source) => source.id === selectedSourceId) ?? sources[0] : sources[0];
  const [selectedPreview, selectedFiles] = selectedSource
    ? await Promise.all([
        getWorkbenchSourcePreview(selectedSource.id).catch(() => null),
        listWorkbenchSourceFiles(selectedSource.id).catch(() => [])
      ])
    : [null, []];
  const sourceWorker = workerStatus.workers.find((worker) => worker.workerKey === "source_monitor");
  const monitoredCount = sources.filter((source) => source.monitorEnabled).length;
  const importedCount = sources.filter((source) => source.lastImportAt).length;
  const pendingCount = sources.reduce((sum, source) => sum + source.counts.filesPending, 0);

  return (
    <OperatorShell
      currentPath="/sources"
      title="Sources"
      subtitle="This is where you see what the brain is watching, what it already imported, and what is still waiting to be pulled through the evidence pipeline."
    >
      <div className="space-y-6">
        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <Card className="border-white/8 bg-[radial-gradient(circle_at_top_right,_rgba(103,232,249,0.08),_transparent_28%),linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Source manager</CardDescription>
              <CardTitle>Trusted folders and import lanes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
              <p>Use this page for folders that should be scanned once, watched forever, or kept as a historical archive. The intent decides whether monitoring should default on or stay politely off.</p>
              <p>Changes still go through the normal ingestion pipeline. The watcher is a finder, not a rogue database editor with a caffeine problem.</p>
            </CardContent>
          </Card>

          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-1">
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader className="pb-2">
                <CardDescription>Tracked sources</CardDescription>
                <CardTitle className="text-[1.6rem] text-white">{sources.length}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-300">{importedCount} imported, {pendingCount} pending files.</CardContent>
            </Card>
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader className="pb-2">
                <CardDescription>Watching now</CardDescription>
                <CardTitle className="text-lg text-white">{monitoredCount}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-300">Sources with monitoring enabled.</CardContent>
            </Card>
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader className="pb-2">
                <CardDescription>Monitor worker</CardDescription>
                <CardTitle className="text-lg text-white">{sourceWorker?.state ?? "unknown"}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-300">Last run {formatDateTime(sourceWorker?.latestRun?.finishedAt ?? sourceWorker?.latestRun?.startedAt)}.</CardContent>
            </Card>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="space-y-6">
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Create source</CardDescription>
                <CardTitle>Add a trusted folder</CardTitle>
              </CardHeader>
              <CardContent>
                <form action={saveSourceAction} className="grid gap-4">
                  <input type="hidden" name="next_url" value="/sources" />
                  <input type="hidden" name="namespace_id" value={defaultNamespaceId} />
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="grid gap-2">
                      <span className="text-sm font-medium text-slate-100">Label</span>
                      <Input name="label" placeholder="OpenClaw memory folder" required />
                    </label>
                    <label className="grid gap-2">
                      <span className="text-sm font-medium text-slate-100">Source type</span>
                      <select name="source_type" defaultValue="folder" className="h-11 rounded-[18px] border border-white/12 bg-white/6 px-4 text-sm text-white outline-none ring-0">
                        <option value="folder">Folder</option>
                        <option value="openclaw">OpenClaw</option>
                      </select>
                    </label>
                  </div>
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Root path</span>
                    <Input name="root_path" placeholder="/Users/you/Notes/OpenClaw" required />
                  </label>
                  <SourceMonitorIntentFields defaultIntent="ongoing_folder_monitor" defaultMonitorEnabled={true} />
                  <label className="grid gap-2 md:max-w-sm">
                    <span className="text-sm font-medium text-slate-100">Monitor cadence</span>
                    <select name="monitor_schedule" defaultValue="every_30_minutes" className="h-11 rounded-[18px] border border-white/12 bg-white/6 px-4 text-sm text-white outline-none ring-0">
                      <option value="every_30_minutes">Every 30 minutes</option>
                      <option value="hourly">Hourly</option>
                      <option value="daily">Daily</option>
                    </select>
                  </label>
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Notes</span>
                    <Input name="notes" placeholder="what lives in this folder and why it matters" />
                  </label>
                  <div className="flex flex-wrap gap-3">
                    <button type="submit" name="intent" value="save" className="inline-flex min-h-11 items-center rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-white hover:bg-white/10">
                      Save source
                    </button>
                    <button type="submit" name="intent" value="save-scan" className="inline-flex min-h-11 items-center rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-4 py-2.5 text-sm font-medium text-cyan-50 hover:bg-cyan-300/16">
                      Save and scan
                    </button>
                    <button type="submit" name="intent" value="save-import" className="inline-flex min-h-11 items-center rounded-2xl bg-amber-300 px-4 py-2.5 text-sm font-medium text-stone-950 hover:bg-amber-200">
                      Save and import
                    </button>
                  </div>
                </form>
              </CardContent>
            </Card>

            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Tracked sources</CardDescription>
                <CardTitle>Current lanes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {sources.length === 0 ? (
                  <div className="rounded-[20px] border border-dashed border-white/12 bg-white/5 p-5 text-sm leading-7 text-slate-300">
                    No sources yet. Add one above, or start with the owner step if you want the soft landing.
                  </div>
                ) : (
                  sources.map((source) => (
                    <section key={source.id} className="rounded-[24px] border border-white/8 bg-white/5 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          {(() => {
                            const monitorHealth = sourceHealth(source, sourceWorker);
                            return (
                              <div className="mb-3">
                                <Badge variant="outline" className={monitorHealth.tone}>
                                  {monitorHealth.label}
                                </Badge>
                                <p className="mt-2 text-xs leading-6 text-slate-400">{monitorHealth.detail}</p>
                              </div>
                            );
                          })()}
                          <div className="flex flex-wrap gap-2">
                            <Link href={`/sources?source=${encodeURIComponent(source.id)}`} className="text-lg font-semibold text-white hover:text-cyan-100">
                              {source.label}
                            </Link>
                            <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                              {source.sourceType}
                            </Badge>
                            <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                              {sourceIntentLabel(source.metadata.source_intent)}
                            </Badge>
                            <Badge variant="outline" className={source.monitorEnabled ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-100" : "border-white/10 bg-white/5 text-slate-100"}>
                              {source.monitorEnabled ? "monitoring on" : "monitoring off"}
                            </Badge>
                          </div>
                          <p className="mt-2 text-sm leading-7 text-slate-300">{source.rootPath}</p>
                          <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-400">
                            <span>Last scan {formatDateTime(source.lastScanAt)}</span>
                            <span>Last import {formatDateTime(source.lastImportAt)}</span>
                            <span>Pending {source.counts.filesPending}</span>
                            <span>Schedule {source.scanSchedule.replace(/_/g, " ")}</span>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <form action={scanSourceAction}>
                            <input type="hidden" name="source_id" value={source.id} />
                            <input type="hidden" name="next_url" value="/sources" />
                            <PendingSubmitButton idleLabel="Scan" pendingLabel="Scanning..." variant="outline" className="rounded-2xl border border-white/10 bg-white/5 text-white hover:bg-white/10" />
                          </form>
                          <form action={importSourceAction}>
                            <input type="hidden" name="source_id" value={source.id} />
                            <input type="hidden" name="next_url" value="/sources" />
                            <PendingSubmitButton idleLabel="Import" pendingLabel="Importing..." className="rounded-2xl bg-slate-950 text-white hover:bg-slate-800" />
                          </form>
                        </div>
                      </div>

                      <div className="mt-4 flex flex-wrap gap-2">
                        <form action={toggleSourceMonitoringAction}>
                          <input type="hidden" name="source_id" value={source.id} />
                          <input type="hidden" name="enabled" value={source.monitorEnabled ? "false" : "true"} />
                          <input type="hidden" name="next_url" value="/sources" />
                          <PendingSubmitButton
                            idleLabel={source.monitorEnabled ? "Pause monitor" : "Enable monitor"}
                            pendingLabel="Saving..."
                            variant="outline"
                            className="rounded-2xl border border-white/10 bg-white/5 text-white hover:bg-white/10"
                          />
                        </form>
                        <form action={deleteSourceAction}>
                          <input type="hidden" name="source_id" value={source.id} />
                          <input type="hidden" name="next_url" value="/sources" />
                          <PendingSubmitButton idleLabel="Remove" pendingLabel="Removing..." variant="outline" className="rounded-2xl border border-rose-300/20 bg-rose-300/10 text-rose-100 hover:bg-rose-300/16" />
                        </form>
                      </div>
                    </section>
                  ))
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Monitor worker</CardDescription>
                <CardTitle>Watch-folder health</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
                <p>Checked {formatDateTime(workerStatus.checkedAt)}. Next due {formatDateTime(sourceWorker?.nextDueAt)}.</p>
                <p>State: <span className="font-medium text-white">{sourceWorker?.state ?? "unknown"}</span></p>
                {sourceWorker?.recentFailures[0]?.errorMessage ? (
                  <div className="rounded-[18px] border border-rose-300/16 bg-rose-300/10 p-3 text-rose-50">
                    <p className="font-medium text-white">Latest failure</p>
                    <p className="mt-1">{sourceWorker.recentFailures[0].errorMessage}</p>
                  </div>
                ) : null}
                <form action={processSourceMonitorNowAction}>
                  <PendingSubmitButton idleLabel="Run monitor now" pendingLabel="Running monitor..." className="rounded-2xl bg-cyan-300 text-slate-950 hover:bg-cyan-200" />
                </form>
              </CardContent>
            </Card>

            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Selected source</CardDescription>
                <CardTitle>{selectedSource?.label ?? "Pick a source"}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {!selectedSource ? (
                  <p className="text-sm leading-7 text-slate-300">Choose a source from the list to inspect the latest scan and the files the watcher knows about.</p>
                ) : (
                  <>
                    <div className="rounded-[18px] border border-white/8 bg-white/5 p-4 text-sm leading-7 text-slate-300">
                      <p>Root path: <span className="font-medium text-white">{selectedSource.rootPath}</span></p>
                      <p>Last scan: <span className="font-medium text-white">{formatDateTime(selectedSource.lastScanAt)}</span></p>
                      <p>Last import: <span className="font-medium text-white">{formatDateTime(selectedSource.lastImportAt)}</span></p>
                      <p>Files discovered/imported/pending: <span className="font-medium text-white">{selectedSource.counts.filesDiscovered} / {selectedSource.counts.filesImported} / {selectedSource.counts.filesPending}</span></p>
                    </div>
                    {selectedPreview?.latestScan ? (
                      <div className="rounded-[18px] border border-white/8 bg-white/5 p-4 text-sm leading-7 text-slate-300">
                        <p>Latest scan saw <span className="font-medium text-white">{selectedPreview.latestScan.filesSeen}</span> files.</p>
                        <p>New {selectedPreview.latestScan.newFiles}, changed {selectedPreview.latestScan.changedFiles}, deleted {selectedPreview.latestScan.deletedFiles}, errored {selectedPreview.latestScan.erroredFiles}.</p>
                      </div>
                    ) : null}
                    {selectedPreview?.latestImport ? (
                      <div className="rounded-[18px] border border-white/8 bg-white/5 p-4 text-sm leading-7 text-slate-300">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-white">Latest import outcome</p>
                          <Badge variant="outline" className={selectedPreview.latestImport.status === "failed" ? "border-rose-300/20 bg-rose-300/10 text-rose-100" : selectedPreview.latestImport.status === "partial" ? "border-amber-300/20 bg-amber-300/10 text-amber-100" : "border-emerald-300/20 bg-emerald-300/10 text-emerald-100"}>
                            {selectedPreview.latestImport.status}
                          </Badge>
                        </div>
                        <p className="mt-2">Attempted {selectedPreview.latestImport.filesAttempted}, imported {selectedPreview.latestImport.filesImported}, skipped {selectedPreview.latestImport.filesSkipped}, failed {selectedPreview.latestImport.filesFailed}.</p>
                        <p>Finished {formatDateTime(selectedPreview.latestImport.finishedAt ?? selectedPreview.latestImport.startedAt)} via {selectedPreview.latestImport.triggerType} trigger.</p>
                      </div>
                    ) : null}
                    <div className="overflow-hidden rounded-[24px] border border-white/8 bg-black/15">
                      <div className="overflow-x-auto">
                        <table className="min-w-full text-left text-sm">
                          <thead className="bg-white/5 text-xs uppercase tracking-[0.18em] text-slate-400">
                            <tr>
                              <th className="px-4 py-3 font-medium">File</th>
                              <th className="px-4 py-3 font-medium">Delta</th>
                              <th className="px-4 py-3 font-medium">Latest outcome</th>
                              <th className="px-4 py-3 font-medium">Modified</th>
                              <th className="px-4 py-3 font-medium text-right">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedFiles.slice(0, 24).map((file) => {
                              const outcome = importOutcome(file);
                              return (
                                <tr key={file.id} className="border-t border-white/6 align-top">
                                  <td className="px-4 py-4">
                                    <p className="font-medium text-white">{file.relativePath}</p>
                                    <p className="mt-1 text-xs text-slate-400">{file.extension || "file"} · {formatBytes(file.sizeBytes)} · last seen {formatDateTime(file.lastSeenAt)}</p>
                                  </td>
                                  <td className="px-4 py-4">
                                    <Badge variant="outline" className={fileDeltaTone(file.lastStatus)}>
                                      {fileDeltaLabel(file.lastStatus)}
                                    </Badge>
                                  </td>
                                  <td className="px-4 py-4">
                                    <Badge variant="outline" className={outcome.tone}>
                                      {outcome.label}
                                    </Badge>
                                    <p className="mt-2 max-w-md text-xs leading-6 text-slate-300">{outcome.detail}</p>
                                    {file.artifactId ? <p className="mt-1 text-[11px] leading-5 text-slate-500">artifact {file.artifactId}</p> : null}
                                  </td>
                                  <td className="px-4 py-4 text-xs leading-6 text-slate-400">
                                    <p>{formatDateTime(file.modifiedAt)}</p>
                                    <p>Imported {formatDateTime(file.lastImportedAt)}</p>
                                  </td>
                                  <td className="px-4 py-4 text-right">
                                    {outcome.retryable ? (
                                      <form action={retrySourceFileAction} className="inline-flex">
                                        <input type="hidden" name="source_id" value={selectedSource.id} />
                                        <input type="hidden" name="file_id" value={file.id} />
                                        <input type="hidden" name="next_url" value="/sources" />
                                        <PendingSubmitButton idleLabel="Retry" pendingLabel="Retrying..." variant="outline" className="rounded-2xl border border-white/10 bg-white/5 text-white hover:bg-white/10" />
                                      </form>
                                    ) : (
                                      <span className="text-xs text-slate-500">no action</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    {selectedFiles.length > 24 ? (
                      <p className="text-xs leading-6 text-slate-500">Showing the first 24 files in this lane. The watcher still knows about {selectedFiles.length - 24} more.</p>
                    ) : null}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </OperatorShell>
  );
}
