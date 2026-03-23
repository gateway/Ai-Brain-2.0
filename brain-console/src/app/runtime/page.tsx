import Link from "next/link";
import {
  processOutboxNowAction,
  processSourceMonitorNowAction,
  runTemporalSummariesNowAction
} from "@/app/bootstrap/actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { OperatorShell } from "@/components/operator-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getModelRuntimeOverview } from "@/lib/model-runtime";
import {
  getBootstrapState,
  getRuntimeHealth,
  getWorkbenchWorkerStatus,
  type WorkbenchWorkerHealth,
  listOpenRouterModels,
  resolveBootstrapEmbeddingSettings,
  resolveWorkbenchOperationsSettings
} from "@/lib/operator-workbench";
import { requireSetupComplete } from "@/lib/setup-gating";

function formatDateTime(value?: string | null): string {
  if (!value) {
    return "not yet";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function workerLabel(value: "source_monitor" | "derivation" | "outbox" | "temporal_summary"): string {
  switch (value) {
    case "source_monitor":
      return "Source monitor";
    case "derivation":
      return "Derivations";
    case "outbox":
      return "Inbox propagation";
    case "temporal_summary":
      return "Temporal summaries";
  }
}

function workerTone(value: "disabled" | "never" | "running" | "healthy" | "degraded" | "failed" | "stale"): string {
  switch (value) {
    case "healthy":
      return "border-emerald-300/20 bg-emerald-300/10 text-emerald-100";
    case "running":
      return "border-cyan-300/20 bg-cyan-300/10 text-cyan-100";
    case "degraded":
    case "stale":
      return "border-amber-300/20 bg-amber-300/10 text-amber-100";
    case "failed":
      return "border-rose-300/20 bg-rose-300/10 text-rose-100";
    default:
      return "border-white/10 bg-white/5 text-slate-100";
  }
}

function latestSuccessfulRun(worker?: WorkbenchWorkerHealth) {
  if (!worker?.latestRun) {
    return undefined;
  }
  return worker.latestRun.status === "succeeded" || worker.latestRun.status === "partial" ? worker.latestRun : undefined;
}

async function measureAsync<T>(loader: () => Promise<T>): Promise<{ readonly value: T; readonly latencyMs?: number }> {
  const startedAt = new Date().getTime();
  try {
    const value = await loader();
    return {
      value,
      latencyMs: new Date().getTime() - startedAt
    };
  } catch {
    return {
      value: null as T,
      latencyMs: undefined
    };
  }
}

export default async function RuntimePage() {
  await requireSetupComplete("/runtime");
  const [health, runtimeResult, openRouterResult, workerStatus, bootstrap] = await Promise.all([
    getRuntimeHealth().catch(() => ({ ok: false })),
    measureAsync(() => getModelRuntimeOverview()),
    measureAsync(() => listOpenRouterModels()),
    getWorkbenchWorkerStatus().catch(() => ({
      checkedAt: new Date(0).toISOString(),
      namespaceId: "personal",
      workers: []
    })),
    getBootstrapState()
  ]);

  const runtime = runtimeResult.value;
  const openRouterModels = openRouterResult.value ?? [];
  const embeddings = resolveBootstrapEmbeddingSettings(bootstrap.metadata);
  const operations = resolveWorkbenchOperationsSettings(bootstrap.metadata);
  const openRouterChatCount = openRouterModels.filter((model) => model.supportsChat).length;
  const openRouterEmbeddingCount = openRouterModels.filter((model) => model.supportsEmbeddings).length;
  const lastEmbeddingTest = bootstrap.metadata.lastEmbeddingTest;
  const derivationWorker = workerStatus.workers.find((worker) => worker.workerKey === "derivation");
  const temporalWorker = workerStatus.workers.find((worker) => worker.workerKey === "temporal_summary");
  const derivationSuccess = latestSuccessfulRun(derivationWorker);
  const temporalSuccess = latestSuccessfulRun(temporalWorker);

  return (
    <OperatorShell
      currentPath="/runtime"
      title="Runtime"
      subtitle="Check reachability, worker health, and provider status here. Open the deeper machinery only when you need it."
    >
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader className="pb-2">
                <CardDescription>Brain runtime</CardDescription>
                <CardTitle className="text-lg text-white">{health.ok ? "reachable" : "offline"}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-300">HTTP boundary for sessions, search, graph, and review.</CardContent>
            </Card>
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader className="pb-2">
                <CardDescription>Local model runtime</CardDescription>
                <CardTitle className="text-lg text-white">{runtime?.reachable ? "reachable" : "not reachable"}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-300">{runtime?.families.length ?? 0} families discovered.</CardContent>
            </Card>
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader className="pb-2">
                <CardDescription>OpenRouter catalog</CardDescription>
                <CardTitle className="text-lg text-white">{openRouterModels.length > 0 ? "reachable" : "not configured"}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-300">{openRouterChatCount} chat models, {openRouterEmbeddingCount} embedding models.</CardContent>
            </Card>
        </div>

        <div className="grid gap-6 xl:grid-cols-[0.94fr_1.06fr]">
          <div className="space-y-6">
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Current wiring</CardDescription>
                <CardTitle>What route this brain is using right now</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
                <p>Purpose mode: <span className="font-medium text-white">{bootstrap.metadata.brainPurposeMode ?? "not set"}</span></p>
                <p>Intelligence route: <span className="font-medium text-white">{bootstrap.metadata.intelligenceMode ?? "not set"}</span></p>
                <p>Embeddings route: <span className="font-medium text-white">{embeddings.provider}</span></p>
                <p>Embeddings model: <span className="font-medium text-white">{embeddings.model ?? "provider default"}</span></p>
                <p>Summary strategy: <span className="font-medium text-white">{operations.temporalSummary.strategy}</span></p>
                <p>Summary provider: <span className="font-medium text-white">{operations.temporalSummary.summarizerProvider}</span></p>
                <p>Summary model: <span className="font-medium text-white">{operations.temporalSummary.summarizerModel ?? "provider default"}</span></p>
                <p className="pt-2">
                  Need the deeper knobs? Go to{" "}
                  <Link href="/settings" className="font-medium text-cyan-100 hover:text-white">
                    Settings
                  </Link>
                  .
                </p>
              </CardContent>
            </Card>

            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Provider telemetry</CardDescription>
                <CardTitle>Latency and last verified success</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                <div className="rounded-[18px] border border-white/8 bg-white/5 p-4 text-sm leading-7 text-slate-300">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-white">Local runtime</p>
                    <Badge variant="outline" className={runtime?.reachable ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-100" : "border-white/10 bg-white/5 text-slate-100"}>
                      {runtime?.reachable ? "reachable" : "not reachable"}
                    </Badge>
                  </div>
                  <p className="mt-2">Catalog latency: <span className="font-medium text-white">{runtimeResult.latencyMs ? `${runtimeResult.latencyMs}ms` : "not measured"}</span></p>
                  <p>Last verified embedding check: <span className="font-medium text-white">{lastEmbeddingTest?.provider === "external" && lastEmbeddingTest.success ? formatDateTime(lastEmbeddingTest.testedAt) : "not yet"}</span></p>
                  <p>Verified model: <span className="font-medium text-white">{lastEmbeddingTest?.provider === "external" && lastEmbeddingTest.success ? (lastEmbeddingTest.model ?? "provider default") : (runtime?.families.find((family) => family.family === "llm")?.activeModel ?? "unknown")}</span></p>
                </div>
                <div className="rounded-[18px] border border-white/8 bg-white/5 p-4 text-sm leading-7 text-slate-300">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-white">OpenRouter</p>
                    <Badge variant="outline" className={openRouterModels.length > 0 ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-100" : "border-white/10 bg-white/5 text-slate-100"}>
                      {openRouterModels.length > 0 ? "reachable" : "not configured"}
                    </Badge>
                  </div>
                  <p className="mt-2">Catalog latency: <span className="font-medium text-white">{openRouterResult.latencyMs ? `${openRouterResult.latencyMs}ms` : "not measured"}</span></p>
                  <p>Last verified embedding check: <span className="font-medium text-white">{lastEmbeddingTest?.provider === "openrouter" && lastEmbeddingTest.success ? formatDateTime(lastEmbeddingTest.testedAt) : "not yet"}</span></p>
                  <p>Verified model: <span className="font-medium text-white">{lastEmbeddingTest?.provider === "openrouter" && lastEmbeddingTest.success ? (lastEmbeddingTest.model ?? "provider default") : "not yet"}</span></p>
                </div>
                <div className="rounded-[18px] border border-white/8 bg-white/5 p-4 text-sm leading-7 text-slate-300">
                  <p className="font-medium text-white">Last model-backed jobs</p>
                  <p className="mt-2">Temporal summary success: <span className="font-medium text-white">{temporalSuccess ? formatDateTime(temporalSuccess.finishedAt ?? temporalSuccess.startedAt) : "not yet"}</span></p>
                  <p>Temporal route: <span className="font-medium text-white">{typeof temporalSuccess?.summary.provider === "string" ? temporalSuccess.summary.provider : operations.temporalSummary.summarizerProvider}</span> / <span className="font-medium text-white">{typeof temporalSuccess?.summary.model === "string" && temporalSuccess.summary.model ? temporalSuccess.summary.model : (operations.temporalSummary.summarizerModel ?? "provider default")}</span></p>
                  <p className="mt-2">Derivation success: <span className="font-medium text-white">{derivationSuccess ? formatDateTime(derivationSuccess.finishedAt ?? derivationSuccess.startedAt) : "not yet"}</span></p>
                  <p>Derivation route: <span className="font-medium text-white">{typeof derivationSuccess?.summary.provider === "string" ? derivationSuccess.summary.provider : (operations.derivation.provider ?? "not set")}</span> / <span className="font-medium text-white">{typeof derivationSuccess?.summary.model === "string" && derivationSuccess.summary.model ? derivationSuccess.summary.model : (operations.derivation.model ?? "provider default")}</span></p>
                </div>
              </CardContent>
            </Card>

            <details className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] p-5">
              <summary className="cursor-pointer list-none text-lg font-semibold tracking-tight text-white">Advanced provider inventory</summary>
              <div className="mt-4 space-y-3">
                {runtime?.families.length ? (
                  runtime.families.map((family) => (
                    <div key={family.family} className="rounded-[18px] border border-white/8 bg-white/5 p-4 text-sm leading-7 text-slate-300">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium text-white">{family.family}</p>
                        <Badge variant="outline" className={family.loaded ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-100" : "border-white/10 bg-white/5 text-slate-100"}>
                          {family.loaded ? "loaded" : "not loaded"}
                        </Badge>
                      </div>
                      <p className="mt-2">Supported models: <span className="font-medium text-white">{family.supportedModels.length}</span></p>
                      {family.activeModel ? <p>Active model: <span className="font-medium text-white">{family.activeModel}</span></p> : null}
                    </div>
                  ))
                ) : (
                  <p className="text-sm leading-7 text-slate-300">No local model runtime catalog available right now.</p>
                )}
              </div>
            </details>
          </div>

          <div className="space-y-6">
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Workers</CardDescription>
                <CardTitle>Which loops need you right now</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {workerStatus.workers.map((worker) => (
                  <div key={worker.workerKey} className="rounded-[22px] border border-white/8 bg-white/5 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-sm font-medium text-white">{workerLabel(worker.workerKey)}</p>
                      <Badge variant="outline" className={workerTone(worker.state)}>
                        {worker.state}
                      </Badge>
                    </div>
                    <div className="mt-3 text-sm leading-7 text-slate-300">
                      <p>Last run: <span className="font-medium text-white">{formatDateTime(worker.latestRun?.finishedAt ?? worker.latestRun?.startedAt)}</span></p>
                      <p>Next due: <span className="font-medium text-white">{formatDateTime(worker.nextDueAt)}</span></p>
                      {worker.latestRun ? (
                        <p>Attempted {worker.latestRun.attemptedCount}, processed {worker.latestRun.processedCount}, failed {worker.latestRun.failedCount}.</p>
                      ) : null}
                    </div>
                    {worker.recentFailures.length ? (
                      <details className="mt-3 rounded-[18px] border border-rose-300/16 bg-rose-300/10 p-3 text-xs leading-6 text-rose-50">
                        <summary className="cursor-pointer list-none font-medium text-white">Recent failures</summary>
                        <div className="mt-3 space-y-3">
                          {worker.recentFailures.map((failure) => (
                            <div key={failure.id} className="rounded-[14px] border border-white/10 bg-black/10 p-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="font-medium text-white">
                                  {typeof failure.summary.failure_category === "string" ? failure.summary.failure_category : failure.status}
                                </p>
                                <span>{formatDateTime(failure.finishedAt ?? failure.startedAt)}</span>
                              </div>
                              <p className="mt-1 text-rose-100/90">
                                attempted {failure.attemptedCount}, processed {failure.processedCount}, failed {failure.failedCount}
                              </p>
                              {failure.errorMessage ? <p className="mt-1">{failure.errorMessage}</p> : null}
                              {typeof failure.summary.retry_guidance === "string" ? (
                                <p className="mt-1">Next step: {failure.summary.retry_guidance}</p>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </div>
                ))}
              </CardContent>
            </Card>

            <details className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] p-5">
              <summary className="cursor-pointer list-none text-lg font-semibold tracking-tight text-white">Manual controls</summary>
              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <form action={processSourceMonitorNowAction} className="space-y-3 rounded-[18px] border border-white/10 bg-white/5 p-4">
                  <p className="text-sm leading-6 text-slate-300">Run watched-folder scan/import right now.</p>
                  <PendingSubmitButton idleLabel="Run source monitor" pendingLabel="Running..." className="rounded-2xl bg-cyan-300 text-slate-950 hover:bg-cyan-200" />
                </form>
                <form action={processOutboxNowAction} className="space-y-3 rounded-[18px] border border-white/10 bg-white/5 p-4">
                  <p className="text-sm leading-6 text-slate-300">Push clarification and merge events through the rebuild path.</p>
                  <PendingSubmitButton idleLabel="Run inbox propagation" pendingLabel="Processing..." className="rounded-2xl border border-white/10 bg-white/5 text-white hover:bg-white/10" />
                </form>
                <form action={runTemporalSummariesNowAction} className="space-y-3 rounded-[18px] border border-white/10 bg-white/5 p-4">
                  <p className="text-sm leading-6 text-slate-300">Rebuild deterministic summaries and semantic overlays now.</p>
                  <PendingSubmitButton idleLabel="Run summaries" pendingLabel="Summarizing..." className="rounded-2xl border border-white/10 bg-white/5 text-white hover:bg-white/10" />
                </form>
              </div>
            </details>
          </div>
        </div>
      </div>
    </OperatorShell>
  );
}
