import Link from "next/link";
import { OperatorShell } from "@/components/operator-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getBootstrapState, getRuntimeHealth, getWorkbenchWorkerStatus, resolveBootstrapEmbeddingSettings } from "@/lib/operator-workbench";
import { SetupStepGuide } from "@/components/setup-step-guide";

function checklistTone(completed: boolean, current: boolean): string {
  if (completed) {
    return "border-emerald-300/25 bg-emerald-300/12";
  }
  if (current) {
    return "border-cyan-300/30 bg-cyan-300/10";
  }
  return "border-white/8 bg-white/5";
}

function checklistBadge(completed: boolean, current: boolean): string {
  if (completed) {
    return "complete";
  }
  if (current) {
    return "current";
  }
  return "pending";
}

function searchValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

function formatDateTime(value?: string | null): string {
  if (!value) {
    return "not yet";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export default async function SetupPage({
  searchParams
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const params = await searchParams;
  const [bootstrap, health, workerStatus] = await Promise.all([
    getBootstrapState().catch(() => null),
    getRuntimeHealth().catch(() => ({ ok: false })),
    getWorkbenchWorkerStatus().catch(() => ({ checkedAt: new Date(0).toISOString(), namespaceId: "personal", workers: [] }))
  ]);
  const defaultNamespaceId = bootstrap?.metadata.defaultNamespaceId ?? "personal";
  const embeddingSettings = bootstrap ? resolveBootstrapEmbeddingSettings(bootstrap.metadata) : {
    provider: "external" as const,
    model: null,
    dimensions: null
  };

  const purposeDone = Boolean(bootstrap?.metadata.brainPurposeMode);
  const intelligenceDone = Boolean(bootstrap?.metadata.intelligenceSetupCompletedAt || bootstrap?.metadata.intelligenceMode);
  const ownerDone = Boolean(bootstrap?.ownerProfileCompleted);
  const importDone = Boolean(bootstrap?.sourceImportCompleted);
  const verifyDone = Boolean(bootstrap?.metadata.verificationSmokePackRunAt);
  const embeddingsConfigured = Boolean(bootstrap?.metadata.intelligenceSetupCompletedAt) || Boolean(embeddingSettings.provider);
  const embeddingTestDone = Boolean(bootstrap?.metadata.lastEmbeddingTest?.success);
  const embeddingRebuildDone = Boolean(bootstrap?.metadata.lastEmbeddingRebuild?.success);

  const requiredSteps = [
    {
      key: "runtime",
      title: "Runtime reachable",
      description: "Make sure the brain runtime is online before onboarding or testing provider paths.",
      completed: health.ok,
      href: "/",
      hrefLabel: "Open dashboard"
    },
    {
      key: "purpose",
      title: "Set brain purpose",
      description: "Pick the lane first so the brain knows whether this is mostly personal, business, creative, or mixed.",
      completed: purposeDone,
      href: "/bootstrap/purpose",
      hrefLabel: "Set purpose"
    },
    {
      key: "intelligence",
      title: "Connect intelligence",
      description: "Choose local runtime, OpenRouter, or a calm skip-for-now mode, then decide how summaries should work.",
      completed: intelligenceDone,
      href: "/bootstrap/intelligence",
      hrefLabel: "Connect intelligence"
    },
    {
      key: "owner",
      title: "Tell the brain who you are",
      description: "Create the self anchor, then type, speak, or upload the first owner evidence and let the brain classify it if available.",
      completed: ownerDone,
      href: "/bootstrap/owner",
      hrefLabel: "Open owner step"
    },
    {
      key: "import",
      title: "Import trusted sources",
      description: "Add watched folders or skip this for now if you only want to start with owner evidence.",
      completed: importDone,
      href: "/bootstrap/import",
      hrefLabel: "Open source import"
    },
    {
      key: "verify",
      title: "Run verification smoke pack",
      description: "Confirm the brain can answer basic questions with evidence from the loaded namespace.",
      completed: verifyDone,
      href: "/bootstrap/verify",
      hrefLabel: "Open verification"
    }
  ] as const;

  const optionalSteps = [
    {
      key: "embeddings",
      title: "Test retrieval route",
      description: "Optional but smart: test the embeddings path before assuming hybrid retrieval is active.",
      completed: embeddingsConfigured && embeddingTestDone,
      href: "/settings",
      hrefLabel: "Open settings"
    },
    {
      key: "test",
      title: "Test embeddings",
      description: "Run the provider test before assuming vector retrieval is active.",
      completed: embeddingTestDone,
      href: "/settings",
      hrefLabel: "Run test"
    },
    {
      key: "rebuild",
      title: "Rebuild namespace vectors",
      description: "Queue a re-embed after changing provider or model so hybrid retrieval can actually run.",
      completed: embeddingRebuildDone,
      href: "/settings",
      hrefLabel: "Queue re-embed"
    }
  ] as const;

  const firstPendingIndex = requiredSteps.findIndex((step) => !step.completed);

  return (
    <OperatorShell
      currentPath="/setup"
      title="Start Here"
      subtitle="Welcome. This is the easiest path from a blank install to a brain that actually knows something and can prove where it learned it."
    >
      <div className="space-y-6 lg:space-y-8">
        {searchValue(params.blocked_from) ? (
          <div className="rounded-[22px] border border-cyan-300/25 bg-cyan-300/10 px-4 py-3 text-sm text-cyan-50">
            You were redirected here from <span className="font-medium text-white">{searchValue(params.blocked_from)}</span> because setup is not finished yet.
          </div>
        ) : null}
        <SetupStepGuide
          step="Start Here"
          title="Follow the setup flow in order"
          statusLabel={firstPendingIndex === -1 ? "ready to use" : `next step ${firstPendingIndex + 1}`}
          whatToDo="Work through the checklist from top to bottom. Each step is intentionally narrow so you only have one real decision to make at a time."
          whyItMatters="This app depends on having purpose, intelligence routing, self identity, evidence, and verification in place. Skipping ahead makes the brain feel spooky in the bad way."
          nextHref={firstPendingIndex === -1 ? "/settings" : requiredSteps[firstPendingIndex]?.href}
          nextLabel={firstPendingIndex === -1 ? "Review optional settings" : requiredSteps[firstPendingIndex]?.hrefLabel}
        />
        <section className="overflow-hidden rounded-[34px] border border-white/8 bg-[radial-gradient(circle_at_top_right,_rgba(103,232,249,0.11),_transparent_24%),linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_28px_100px_rgba(0,0,0,0.28)]">
          <div className="grid gap-6 px-5 py-6 sm:px-6 lg:grid-cols-[minmax(0,1.15fr)_340px] lg:px-8 lg:py-8">
            <div className="space-y-4">
              <div className="inline-flex rounded-full border border-white/10 bg-white/6 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-100">
                First-time journey
              </div>
              <div className="space-y-3">
                <h2 className="max-w-3xl text-[1.85rem] font-semibold tracking-[-0.03em] text-white sm:text-[2.25rem]">
                  Give the brain a name, a lane, a little intelligence, and a few trusted facts.
                </h2>
                <p className="max-w-2xl text-[15px] leading-8 text-slate-200">
                  Everything here is ordered on purpose. Pick the brain mode, choose where intelligence runs, tell it who you are, add trusted evidence, then verify it before you trust it with your digital life.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  {
                    label: "Identity",
                    detail: "Tell the brain what it is for and who it belongs to."
                  },
                  {
                    label: "Intelligence",
                    detail: "Choose local, OpenRouter, or a skip-for-now route without getting buried in settings."
                  },
                  {
                    label: "Evidence",
                    detail: "Ground the system in real owner context and trusted sources, then verify the answers."
                  }
                ].map((item) => (
                  <div
                    key={item.label}
                    className="rounded-[22px] border border-white/10 bg-[linear-gradient(180deg,_rgba(255,255,255,0.07)_0%,_rgba(255,255,255,0.04)_100%)] p-4"
                  >
                    <p className="text-sm font-semibold tracking-tight text-white">{item.label}</p>
                    <p className="mt-2 text-sm leading-7 text-slate-300">{item.detail}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              {[
                { label: "Runtime", value: health.ok ? "reachable" : "offline", detail: "brain connection" },
                { label: "Namespace", value: defaultNamespaceId, detail: "default lane" },
                { label: "Embeddings", value: embeddingSettings.provider, detail: "active provider" },
                { label: "Model", value: embeddingSettings.model ?? "provider default", detail: "saved default" }
              ].map((item) => (
                <div key={item.label} className="rounded-[24px] border border-white/10 bg-white/6 p-5 backdrop-blur">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-slate-300">{item.label}</p>
                  <p className="mt-3 text-[1.35rem] font-semibold tracking-tight text-white">{item.value}</p>
                  <p className="mt-1 text-sm text-slate-400">{item.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="grid gap-5 xl:grid-cols-[1.08fr_0.92fr]">
          <section className="space-y-4">
            <div className="px-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-slate-400">Journey</p>
              <h2 className="mt-2 text-[1.55rem] font-semibold tracking-tight text-white">What to do first</h2>
              <p className="mt-2 max-w-2xl text-[15px] leading-8 text-slate-300">
                Move from top to bottom. The highlighted step is the next recommended action. Finished steps stay visible so you can audit what has already been grounded.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Link
                  href="/help"
                  className="inline-flex min-h-10 items-center rounded-2xl border border-white/10 bg-white/6 px-4 py-2 text-sm text-white hover:bg-white/10"
                >
                  Open setup help
                </Link>
                <Link
                  href="/settings"
                  className="inline-flex min-h-10 items-center rounded-2xl border border-white/10 bg-white/6 px-4 py-2 text-sm text-white hover:bg-white/10"
                >
                  Open settings
                </Link>
              </div>
            </div>
            <div className="space-y-4">
              {requiredSteps.map((step, index) => {
                const current = !step.completed && index === firstPendingIndex;
                return (
                  <div
                    key={step.key}
                    className={`rounded-[28px] border p-5 sm:p-6 transition-all ${checklistTone(step.completed, current)}`}
                  >
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-3">
                          <div className="inline-flex h-8 min-w-8 items-center justify-center rounded-full border border-white/10 bg-white/6 px-2 text-[11px] font-semibold text-slate-100">
                            {index + 1}
                          </div>
                          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-300">
                            {step.completed ? "Completed" : current ? "Do this next" : "Coming up"}
                          </p>
                        </div>
                        <div>
                          <h3 className="text-[1.18rem] font-semibold tracking-tight text-white">{step.title}</h3>
                          <p className="mt-3 max-w-2xl text-[15px] leading-8 text-slate-300">{step.description}</p>
                        </div>
                      </div>
                      <Badge
                        variant="outline"
                        className={
                          step.completed
                            ? "border-emerald-300/25 bg-emerald-300/12 text-emerald-50"
                            : current
                              ? "border-cyan-300/25 bg-cyan-300/12 text-cyan-50"
                              : "border-white/10 bg-white/5 text-stone-200"
                        }
                      >
                        {checklistBadge(step.completed, current)}
                      </Badge>
                    </div>
                    <div className="mt-5">
                      <Link
                        href={step.href}
                        className="inline-flex min-h-11 items-center rounded-2xl border border-white/10 bg-white/6 px-5 py-3 text-sm text-white hover:bg-white/10"
                      >
                        {step.hrefLabel}
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="space-y-4 pt-2">
              <div className="px-1">
                <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-slate-400">Optional but smart</p>
                <h3 className="mt-2 text-[1.2rem] font-semibold tracking-tight text-white">Checks worth doing next</h3>
              </div>
              {optionalSteps.map((step) => (
                <div key={step.key} className={`rounded-[24px] border p-5 ${checklistTone(step.completed, false)}`}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h4 className="text-[1.05rem] font-semibold tracking-tight text-white">{step.title}</h4>
                      <p className="mt-2 text-[15px] leading-8 text-slate-300">{step.description}</p>
                    </div>
                    <Badge
                      variant="outline"
                      className={step.completed ? "border-emerald-300/25 bg-emerald-300/12 text-emerald-50" : "border-white/10 bg-white/5 text-stone-200"}
                    >
                      {step.completed ? "complete" : "optional"}
                    </Badge>
                  </div>
                  <div className="mt-5">
                    <Link
                      href={step.href}
                      className="inline-flex min-h-11 items-center rounded-2xl border border-white/10 bg-white/6 px-5 py-3 text-sm text-white hover:bg-white/10"
                    >
                      {step.hrefLabel}
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="space-y-5">
            <Card className="overflow-hidden border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_20px_70px_rgba(0,0,0,0.22)]">
              <CardHeader className="pb-3">
                <CardDescription>Background health</CardDescription>
                <CardTitle className="text-[1.35rem] tracking-tight">Workers keeping the brain current</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 pt-0 text-[15px] leading-8 text-slate-300">
                <p>Checked {formatDateTime(workerStatus.checkedAt)}. These loops monitor folders, propagate inbox fixes, and rebuild temporal summaries.</p>
                {workerStatus.workers.map((worker) => (
                  <div key={worker.workerKey} className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-white">{worker.workerKey.replace(/_/g, " ")}</p>
                      <Badge variant="outline" className="border-white/10 bg-white/5 text-stone-200">{worker.state}</Badge>
                    </div>
                    <p className="mt-2 text-sm leading-7 text-slate-300">
                      Last run {formatDateTime(worker.latestRun?.finishedAt ?? worker.latestRun?.startedAt)}. Next due {formatDateTime(worker.nextDueAt)}.
                    </p>
                    {typeof worker.latestRun?.summary?.retry_guidance === "string" ? (
                      <p className="mt-2 text-xs leading-6 text-amber-100">Retry guidance: {worker.latestRun.summary.retry_guidance}</p>
                    ) : null}
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="overflow-hidden border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_20px_70px_rgba(0,0,0,0.22)]">
              <CardHeader className="pb-3">
                <CardDescription>Provider options</CardDescription>
                <CardTitle className="text-[1.35rem] tracking-tight">Choose where intelligence runs</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 pt-0 text-[15px] leading-8 text-slate-300">
                <p><span className="font-medium text-white">external</span> uses your own local or private runtime endpoint.</p>
                <p><span className="font-medium text-white">openrouter</span> uses hosted models and embeddings through your OpenRouter key.</p>
                <p><span className="font-medium text-white">none</span> keeps retrieval lexical-only until you are ready to enable vectors.</p>
                <p>Today, OpenRouter is the fully working <span className="font-medium text-white">1536-dimension</span> re-embed path. Local <span className="font-medium text-white">Qwen/Qwen3-Embedding-4B</span> can be tested now, but still needs a vector-schema upgrade before full namespace sync.</p>
              </CardContent>
            </Card>

            <Card className="overflow-hidden border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_20px_70px_rgba(0,0,0,0.22)]">
              <CardHeader className="pb-3">
                <CardDescription>Recent embedding state</CardDescription>
                <CardTitle className="text-[1.35rem] tracking-tight">Latest checks</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 pt-0 text-[15px] leading-8 text-slate-300">
                <p>Last test: <span className="font-medium text-white">{bootstrap?.metadata.lastEmbeddingTest?.success ? "success" : "not completed"}</span></p>
                <p>Last rebuild: <span className="font-medium text-white">{bootstrap?.metadata.lastEmbeddingRebuild?.success ? "queued" : "not completed"}</span></p>
                {bootstrap?.metadata.lastEmbeddingTest?.reason ? (
                  <p>Last test note: <span className="font-medium text-white">{bootstrap.metadata.lastEmbeddingTest.reason}</span></p>
                ) : null}
                {bootstrap?.metadata.lastEmbeddingRebuild?.reason ? (
                  <p>Last rebuild note: <span className="font-medium text-white">{bootstrap.metadata.lastEmbeddingRebuild.reason}</span></p>
                ) : null}
              </CardContent>
            </Card>

            <Card className="overflow-hidden border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_20px_70px_rgba(0,0,0,0.22)]">
              <CardHeader className="pb-3">
                <CardDescription>How to move through setup</CardDescription>
                <CardTitle className="text-[1.35rem] tracking-tight">A simple rule of thumb</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 pt-0 text-[15px] leading-8 text-slate-300">
                <p>Do the highlighted step first. If you hit a provider or retrieval issue, stay inside setup until the smoke checks pass.</p>
                <p>Once setup is complete, the rest of the app opens up and the session workflow becomes the primary way to use the system.</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </OperatorShell>
  );
}
