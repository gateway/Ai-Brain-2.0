import Link from "next/link";
import {
  deleteSourceAction,
  importSourceAction,
  saveSourceAction,
  scanSourceAction,
  toggleSourceMonitoringAction
} from "@/app/bootstrap/actions";
import { OperatorShell } from "@/components/operator-shell";
import { SetupStepGuide } from "@/components/setup-step-guide";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getBootstrapState, getNamespaceCatalog, getWorkbenchSourcePreview, getWorkbenchWorkerStatus, listWorkbenchSources } from "@/lib/operator-workbench";

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function statusTone(status: string): string {
  switch (status) {
    case "new":
      return "border-cyan-300/25 bg-cyan-300/12 text-cyan-50";
    case "changed":
      return "border-amber-300/25 bg-amber-300/12 text-amber-50";
    case "imported":
      return "border-emerald-300/25 bg-emerald-300/12 text-emerald-50";
    case "error":
      return "border-rose-300/25 bg-rose-300/12 text-rose-50";
    case "deleted":
      return "border-white/10 bg-white/5 text-stone-200";
    default:
      return "border-white/10 bg-white/5 text-stone-200";
  }
}

function formatDateTime(value?: string | null): string {
  if (!value) {
    return "not yet";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export default async function BootstrapImportPage({
  searchParams
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const params = await searchParams;
  const requestedSourceId = typeof params.source === "string" ? params.source : Array.isArray(params.source) ? params.source[0] : undefined;
  const [sources, namespaces, bootstrap, workerStatus] = await Promise.all([
    listWorkbenchSources(),
    getNamespaceCatalog(),
    getBootstrapState(),
    getWorkbenchWorkerStatus().catch(() => ({ checkedAt: new Date(0).toISOString(), namespaceId: "personal", workers: [] }))
  ]);
  const selectedSourceId = requestedSourceId ?? sources[0]?.id;
  const preview = selectedSourceId ? await getWorkbenchSourcePreview(selectedSourceId).catch(() => undefined) : undefined;
  const ownerBootstrapSessionId =
    typeof bootstrap.metadata.ownerBootstrapSessionId === "string" ? bootstrap.metadata.ownerBootstrapSessionId : undefined;
  const defaultNamespaceId = bootstrap.metadata.defaultNamespaceId ?? namespaces.defaultNamespaceId;
  const defaultSourceIntent = bootstrap.metadata.sourceDefaults?.intent ?? "ongoing_folder_monitor";
  const sourceMonitorWorker = workerStatus.workers.find((worker) => worker.workerKey === "source_monitor");

  return (
    <OperatorShell
      currentPath="/bootstrap"
      title="Trusted Source Import"
      subtitle="Add the folders this brain should start from, preview what is in them, and import them through the normal ingest path."
      actions={
        <Link
          href="/bootstrap/verify"
          className="inline-flex items-center rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-4 py-2.5 text-sm font-medium text-cyan-50 hover:border-cyan-300/35 hover:bg-cyan-300/16"
        >
          Verification
        </Link>
      }
    >
      <div className="space-y-6">
        <SetupStepGuide
          step="Step 3"
          title="Add trusted folders and import them carefully"
          statusLabel={bootstrap.sourceImportCompleted ? "complete" : "in progress"}
          whatToDo="Register a source, scan it, review the preview, then import it. Use owner setup for a few highly reviewed files and this page for larger trusted folders or archives."
          whyItMatters="This brings more evidence into the brain without losing provenance. It is the clean way to seed notes, archives, and project folders before normal daily use."
          nextHref="/bootstrap/verify"
          nextLabel="Next: verify the brain"
        />
        <div className="grid gap-4 xl:grid-cols-2">
          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] xl:col-span-2">
            <CardHeader>
              <CardDescription>Monitor health</CardDescription>
              <CardTitle>Watched-folder status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
              <p>Checked {formatDateTime(workerStatus.checkedAt)}. Source monitoring runs in the local runtime worker, not the browser.</p>
              <p>
                Current state:
                {" "}
                <span className="font-medium text-white">{sourceMonitorWorker?.state ?? "unknown"}</span>.
                {" "}Last run {formatDateTime(sourceMonitorWorker?.latestRun?.finishedAt ?? sourceMonitorWorker?.latestRun?.startedAt)}.
                {" "}Next due {formatDateTime(sourceMonitorWorker?.nextDueAt)}.
              </p>
              {typeof sourceMonitorWorker?.latestRun?.summary?.retry_guidance === "string" ? (
                <p>Retry guidance: <span className="font-medium text-white">{sourceMonitorWorker.latestRun.summary.retry_guidance}</span></p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border-cyan-300/18 bg-[linear-gradient(180deg,_rgba(12,28,39,0.94)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Bootstrap document paths</CardDescription>
              <CardTitle>Use the right lane for markdown files</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm leading-7 text-slate-200">
              <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">Owner bootstrap docs</p>
                <p className="mt-2">
                  Upload a few personal markdown or text documents in Step 2 when you want them classified immediately and reviewed as part of the owner profile.
                </p>
                <div className="mt-4">
                  <Link
                    href="/bootstrap/owner"
                    className="inline-flex items-center rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-4 py-2.5 text-sm font-medium text-cyan-50 hover:border-cyan-300/35 hover:bg-cyan-300/16"
                  >
                    {ownerBootstrapSessionId ? "Open owner bootstrap docs" : "Create owner bootstrap first"}
                  </Link>
                </div>
              </div>
              <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">Trusted folder import</p>
                <p className="mt-2">
                  Use this page for larger markdown and text folders that should be seeded through the normal ingest path. This is best for bulk notes and archives that you want retrievable quickly.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>What import does today</CardDescription>
              <CardTitle>Current boundary for bulk markdown folders</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
              <p><strong className="text-white">Markdown and text folders</strong> are scanned, previewed, and ingested through the normal brain pipeline with provenance back to the original file path.</p>
              <p><strong className="text-white">Bulk import</strong> is meant for trusted-folder seeding, not the step-by-step owner review lane. For highly operator-reviewed bootstrap facts, use the owner page and upload a smaller set of bootstrap docs there.</p>
              <p><strong className="text-white">Classification visibility</strong> now lives in the owner bootstrap flow where markdown, text, and audio files can be explicitly reviewed as part of the initial profile build.</p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Quick add</CardDescription>
              <CardTitle>OpenClaw memory folder</CardTitle>
            </CardHeader>
            <CardContent>
              <form action={saveSourceAction} className="grid gap-4">
                <input type="hidden" name="source_type" value="openclaw" />
                <input type="hidden" name="next_url" value="/bootstrap/import" />
                <div className="grid gap-4 lg:grid-cols-2">
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Source label</span>
                    <Input name="label" placeholder="OpenClaw personal memory" />
                  </label>
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Namespace</span>
                    <Input name="namespace_id" list="namespace-options" defaultValue={defaultNamespaceId} />
                  </label>
                </div>
                <label className="grid gap-2 md:max-w-sm">
                  <span className="text-sm font-medium text-slate-100">Source intent</span>
                  <select name="source_intent" defaultValue={defaultSourceIntent} className="h-11 rounded-[18px] border border-white/12 bg-white/6 px-4 text-sm text-white outline-none ring-0">
                    <option value="owner_bootstrap">Owner bootstrap</option>
                    <option value="ongoing_folder_monitor">Ongoing folder monitor</option>
                    <option value="historical_archive">Historical archive</option>
                    <option value="project_source">Project source</option>
                  </select>
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-medium text-slate-100">Folder path</span>
                  <Input name="root_path" required placeholder="/Users/you/OpenClaw/memory" />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-medium text-slate-100">Notes</span>
                  <Textarea name="notes" placeholder="Optional operator note about this source." />
                </label>
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="flex items-center gap-3 rounded-[18px] border border-white/10 bg-white/4 px-4 py-3 text-sm text-slate-200">
                    <input type="checkbox" name="include_subfolders" defaultChecked className="size-4" />
                    Include subfolders
                  </label>
                  <label className="flex items-center gap-3 rounded-[18px] border border-white/10 bg-white/4 px-4 py-3 text-sm text-slate-200">
                    <input type="checkbox" name="monitor_enabled" className="size-4" />
                    Monitor after import
                  </label>
                  <div className="rounded-[18px] border border-white/10 bg-white/4 px-4 py-3 text-sm text-slate-300">v1 file types: <code>.md</code>, <code>.txt</code></div>
                </div>
                <div className="flex flex-wrap gap-3">
                  <Button type="submit" name="intent" value="save" className="rounded-2xl bg-white text-stone-950 hover:bg-stone-200">
                    Save source
                  </Button>
                  <Button type="submit" name="intent" value="save-scan" variant="outline" className="rounded-2xl border-white/10 bg-white/5 text-white hover:bg-white/10">
                    Save + scan
                  </Button>
                  <Button type="submit" name="intent" value="save-import" className="rounded-2xl bg-amber-300 text-stone-950 hover:bg-amber-200">
                    Save + import
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Generic source</CardDescription>
              <CardTitle>Add local markdown or text folder</CardTitle>
            </CardHeader>
            <CardContent>
              <form action={saveSourceAction} className="grid gap-4">
                <input type="hidden" name="source_type" value="folder" />
                <input type="hidden" name="next_url" value="/bootstrap/import" />
                <div className="grid gap-4 lg:grid-cols-2">
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Source label</span>
                    <Input name="label" placeholder="Knowledge vault" />
                  </label>
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Namespace</span>
                    <Input name="namespace_id" list="namespace-options" defaultValue={defaultNamespaceId} />
                  </label>
                </div>
                <label className="grid gap-2 md:max-w-sm">
                  <span className="text-sm font-medium text-slate-100">Source intent</span>
                  <select name="source_intent" defaultValue={defaultSourceIntent} className="h-11 rounded-[18px] border border-white/12 bg-white/6 px-4 text-sm text-white outline-none ring-0">
                    <option value="owner_bootstrap">Owner bootstrap</option>
                    <option value="ongoing_folder_monitor">Ongoing folder monitor</option>
                    <option value="historical_archive">Historical archive</option>
                    <option value="project_source">Project source</option>
                  </select>
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-medium text-slate-100">Folder path</span>
                  <Input name="root_path" required placeholder="/Users/you/Documents/memory-notes" />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-medium text-slate-100">Notes</span>
                  <Textarea name="notes" placeholder="Optional operator note about this folder." />
                </label>
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="flex items-center gap-3 rounded-[18px] border border-white/10 bg-white/4 px-4 py-3 text-sm text-slate-200">
                    <input type="checkbox" name="include_subfolders" defaultChecked className="size-4" />
                    Include subfolders
                  </label>
                  <label className="flex items-center gap-3 rounded-[18px] border border-white/10 bg-white/4 px-4 py-3 text-sm text-slate-200">
                    <input type="checkbox" name="monitor_enabled" className="size-4" />
                    Monitor after import
                  </label>
                  <div className="rounded-[18px] border border-white/10 bg-white/4 px-4 py-3 text-sm text-slate-300">Extensions locked in v1</div>
                </div>
                <div className="flex flex-wrap gap-3">
                  <Button type="submit" name="intent" value="save" className="rounded-2xl bg-white text-stone-950 hover:bg-stone-200">
                    Save source
                  </Button>
                  <Button type="submit" name="intent" value="save-scan" variant="outline" className="rounded-2xl border-white/10 bg-white/5 text-white hover:bg-white/10">
                    Save + scan
                  </Button>
                  <Button type="submit" name="intent" value="save-import" className="rounded-2xl bg-amber-300 text-stone-950 hover:bg-amber-200">
                    Save + import
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>

        <datalist id="namespace-options">
          {namespaces.namespaces.map((namespace) => (
            <option key={namespace.namespaceId} value={namespace.namespaceId}>
              {namespace.namespaceId}
            </option>
          ))}
        </datalist>

        <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Configured sources</CardDescription>
              <CardTitle>Trusted folders</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {sources.length === 0 ? (
                <p className="rounded-[22px] border border-dashed border-white/12 bg-white/5 p-5 text-sm leading-7 text-slate-300">
                  Add an OpenClaw or folder source to start scanning markdown and text files.
                </p>
              ) : (
                sources.map((source) => (
                  <div key={source.id} className="rounded-[22px] border border-white/8 bg-white/5 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-base font-semibold text-white">{source.label}</p>
                          <Badge variant="outline" className="border-white/10 bg-white/5 text-stone-200">
                            {source.sourceType}
                          </Badge>
                          {typeof source.metadata?.source_intent === "string" ? (
                            <Badge variant="outline" className="border-cyan-300/20 bg-cyan-300/10 text-cyan-50">
                              {String(source.metadata.source_intent).replace(/_/g, " ")}
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs leading-6 text-slate-400">{source.rootPath}</p>
                      </div>
                      <Badge variant="outline" className={statusTone(source.status)}>
                        {source.monitorEnabled ? "monitoring on" : "manual only"}
                      </Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-400">
                      <span>namespace {source.namespaceId}</span>
                      <span>{source.counts.filesDiscovered} discovered</span>
                      <span>{source.counts.filesImported} imported</span>
                      <span>{source.counts.filesPending} pending</span>
                      <span>last scan {formatDateTime(source.lastScanAt)}</span>
                      <span>last import {formatDateTime(source.lastImportAt)}</span>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Link
                        href={`/bootstrap/import?source=${source.id}`}
                        className="inline-flex items-center rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white hover:bg-white/10"
                      >
                        Preview
                      </Link>
                      <form action={scanSourceAction}>
                        <input type="hidden" name="source_id" value={source.id} />
                        <input type="hidden" name="next_url" value="/bootstrap/import" />
                        <Button type="submit" variant="outline" className="rounded-2xl border-white/10 bg-white/5 text-white hover:bg-white/10">
                          Scan
                        </Button>
                      </form>
                      <form action={importSourceAction}>
                        <input type="hidden" name="source_id" value={source.id} />
                        <input type="hidden" name="next_url" value="/bootstrap/import" />
                        <Button type="submit" className="rounded-2xl bg-amber-300 text-stone-950 hover:bg-amber-200">
                          Import now
                        </Button>
                      </form>
                      <form action={toggleSourceMonitoringAction}>
                        <input type="hidden" name="source_id" value={source.id} />
                        <input type="hidden" name="next_url" value="/bootstrap/import" />
                        <input type="hidden" name="enabled" value={source.monitorEnabled ? "false" : "true"} />
                        <Button type="submit" variant="outline" className="rounded-2xl border-white/10 bg-white/5 text-white hover:bg-white/10">
                          {source.monitorEnabled ? "Disable monitoring" : "Enable monitoring"}
                        </Button>
                      </form>
                      <form action={deleteSourceAction}>
                        <input type="hidden" name="source_id" value={source.id} />
                        <input type="hidden" name="next_url" value="/bootstrap/import" />
                        <Button type="submit" variant="outline" className="rounded-2xl border-rose-300/20 bg-rose-300/10 text-rose-100 hover:bg-rose-300/16">
                          Remove
                        </Button>
                      </form>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Import preview</CardDescription>
              <CardTitle>{preview ? preview.source.label : "Select a source"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {!preview ? (
                <p className="text-sm leading-7 text-slate-300">Choose a configured source to inspect the current scan state and file statuses.</p>
              ) : (
                <>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-200">Discovery</p>
                      <div className="mt-3 grid gap-1 text-sm text-slate-300">
                        <span>{preview.preview.totalFiles} supported files</span>
                        <span>{preview.preview.markdownFiles} markdown</span>
                        <span>{preview.preview.textFiles} plain text</span>
                        <span>{formatBytes(preview.preview.estimatedTotalSizeBytes)} estimated size</span>
                      </div>
                    </div>
                    <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-200">Delta</p>
                      <div className="mt-3 grid gap-1 text-sm text-slate-300">
                        <span>{preview.preview.newFiles} new</span>
                        <span>{preview.preview.changedFiles} changed</span>
                        <span>{preview.preview.unchangedFiles} unchanged</span>
                        <span>{preview.preview.erroredFiles} errors</span>
                      </div>
                    </div>
                  </div>

                  {preview.preview.latestModifiedFile ? (
                    <div className="rounded-[20px] border border-white/8 bg-white/5 p-4 text-sm leading-7 text-slate-300">
                      Latest modified file: <span className="text-white">{preview.preview.latestModifiedFile.relativePath}</span>
                    </div>
                  ) : null}

                  {preview.preview.exampleMatchedPaths.length > 0 ? (
                    <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-200">Matched examples</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {preview.preview.exampleMatchedPaths.map((example) => (
                          <Badge key={example} variant="outline" className="border-white/10 bg-white/5 text-stone-200">
                            {example}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {preview.preview.ignoredFiles.length > 0 ? (
                    <div className="rounded-[20px] border border-amber-300/20 bg-amber-300/10 p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-50">Ignored files</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {preview.preview.ignoredFiles.map((ignoredPath) => (
                          <Badge key={ignoredPath} variant="outline" className="border-amber-200/15 bg-black/10 text-amber-50">
                            {ignoredPath}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="space-y-2">
                    {preview.files.slice(0, 24).map((file) => (
                      <div key={file.id} className="grid gap-2 rounded-[18px] border border-white/8 bg-black/15 p-3 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-white">{file.relativePath}</p>
                          <p className="mt-1 text-xs text-slate-400">
                            {file.extension} {file.sizeBytes ? `• ${formatBytes(file.sizeBytes)}` : ""}
                          </p>
                        </div>
                        <Badge variant="outline" className={statusTone(file.lastStatus)}>
                          {file.lastStatus}
                        </Badge>
                        <span className="text-xs text-slate-400">{file.modifiedAt ? new Date(file.modifiedAt).toLocaleString() : "n/a"}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </OperatorShell>
  );
}
