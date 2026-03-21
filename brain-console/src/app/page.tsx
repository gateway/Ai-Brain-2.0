import Link from "next/link";
import { OperatorShell } from "@/components/operator-shell";
import { MetricCard } from "@/components/metric-card";
import { SetupStepGuide } from "@/components/setup-step-guide";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getBootstrapState, getNamespaceCatalog, getRuntimeHealth, getWorkbenchClarifications, getWorkbenchWorkerStatus, listWorkbenchSessions, listWorkbenchSources } from "@/lib/operator-workbench";

function formatDateTime(value?: string | null): string {
  if (!value) {
    return "not yet";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function workerStateTone(value: "disabled" | "never" | "running" | "healthy" | "degraded" | "failed" | "stale"): string {
  switch (value) {
    case "healthy":
      return "text-emerald-200";
    case "running":
      return "text-cyan-200";
    case "degraded":
    case "stale":
      return "text-amber-200";
    case "failed":
      return "text-rose-200";
    default:
      return "text-slate-300";
  }
}

function summarizeWorkerStates(workers: readonly {
  readonly state: "disabled" | "never" | "running" | "healthy" | "degraded" | "failed" | "stale";
}[]): { readonly healthy: number; readonly attention: number; readonly disabled: number } {
  return workers.reduce(
    (summary, worker) => {
      if (worker.state === "healthy" || worker.state === "running") {
        return { ...summary, healthy: summary.healthy + 1 };
      }
      if (worker.state === "disabled") {
        return { ...summary, disabled: summary.disabled + 1 };
      }
      return { ...summary, attention: summary.attention + 1 };
    },
    { healthy: 0, attention: 0, disabled: 0 }
  );
}

export default async function WorkbenchDashboardPage() {
  const [sessions, health, namespaces, bootstrap, sources, workerStatus] = await Promise.all([
    listWorkbenchSessions().catch(() => []),
    getRuntimeHealth().catch(() => ({ ok: false })),
    getNamespaceCatalog(),
    getBootstrapState().catch(() => ({
      ownerProfileCompleted: false,
      sourceImportCompleted: false,
      verificationCompleted: false,
      metadata: {},
      updatedAt: new Date(0).toISOString(),
      progress: {
        completedSteps: 0,
        totalSteps: 3,
        onboardingComplete: false
      }
    })),
    listWorkbenchSources().catch(() => []),
    getWorkbenchWorkerStatus().catch(() => ({
      checkedAt: new Date(0).toISOString(),
      namespaceId: "personal",
      workers: []
    }))
  ]);
  const bootstrapMetadata = bootstrap.metadata as { readonly defaultNamespaceId?: string };
  const defaultNamespaceId = bootstrapMetadata.defaultNamespaceId ?? namespaces.defaultNamespaceId ?? "personal";
  const clarifications = await getWorkbenchClarifications(defaultNamespaceId, 8).catch(() => null);
  const importedSources = sources.filter((source) => source.lastImportAt).length;
  const workerSummary = summarizeWorkerStates(workerStatus.workers);
  const priorityOneClarifications = clarifications?.items.filter((item) => item.priorityLevel === 1).length ?? 0;

  return (
    <OperatorShell
      currentPath="/"
      title="Dashboard"
      subtitle="Operator-facing intake and review surface for AI Brain. Start a session, ingest evidence, inspect what the brain inferred, and keep provenance visible."
      actions={
        <div className="flex flex-wrap gap-2">
          {!bootstrap.progress.onboardingComplete ? (
            <Link
              href="/setup"
              className="inline-flex items-center rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-4 py-2.5 text-sm font-medium text-cyan-50 hover:border-cyan-300/35 hover:bg-cyan-300/16"
            >
              Continue setup
            </Link>
          ) : null}
          {bootstrap.progress.onboardingComplete ? (
            <Link
              href="/sessions/new"
              className="inline-flex items-center rounded-2xl border border-amber-300/25 bg-amber-300/12 px-4 py-2.5 text-sm font-medium text-amber-50 hover:border-amber-300/35 hover:bg-amber-300/16"
            >
              Create session
            </Link>
          ) : null}
        </div>
      }
    >
      <div className="space-y-6 lg:space-y-8">
        {!bootstrap.progress.onboardingComplete ? (
          <section className="overflow-hidden rounded-[36px] border border-cyan-300/16 bg-[radial-gradient(circle_at_top_right,_rgba(103,232,249,0.15),_transparent_24%),radial-gradient(circle_at_15%_15%,_rgba(250,204,21,0.08),_transparent_18%),linear-gradient(180deg,_rgba(13,19,30,0.98)_0%,_rgba(8,11,20,0.99)_100%)] shadow-[0_34px_120px_rgba(0,0,0,0.34)]">
            <div className="grid gap-8 px-5 py-6 sm:px-6 sm:py-7 lg:grid-cols-[minmax(0,1.2fr)_360px] lg:px-8 lg:py-9">
              <div className="space-y-6">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-50">
                    Start Here
                  </div>
                  <div className="inline-flex rounded-full border border-white/10 bg-white/6 px-3 py-1 text-[11px] font-medium text-slate-200">
                    Guided first run
                  </div>
                </div>
                <div className="space-y-4">
                  <h3 className="max-w-4xl text-[2.1rem] font-semibold tracking-[-0.035em] text-white sm:text-[2.8rem] lg:text-[3.35rem]">
                    Turn a fresh install into a grounded, trusted AI brain.
                  </h3>
                  <p className="max-w-2xl text-[15px] leading-8 text-slate-200 sm:text-base">
                    This setup flow walks through purpose, identity, trusted source intake, model connection, and verification in the order that makes the rest of the product feel clear instead of fragile.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    {
                      step: "1",
                      title: "Define the brain",
                      detail: "Choose purpose and default operating lane."
                    },
                    {
                      step: "2",
                      title: "Ground it in evidence",
                      detail: "Add owner context, trusted files, and source truth."
                    },
                    {
                      step: "3",
                      title: "Verify it works",
                      detail: "Test providers, retrieval, and smoke-check results."
                    }
                  ].map((item) => (
                    <div
                      key={item.step}
                      className="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,_rgba(255,255,255,0.07)_0%,_rgba(255,255,255,0.04)_100%)] p-4 backdrop-blur"
                    >
                      <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-cyan-100/70">Step {item.step}</p>
                      <p className="mt-3 text-base font-semibold tracking-tight text-white">{item.title}</p>
                      <p className="mt-2 text-sm leading-7 text-slate-300">{item.detail}</p>
                    </div>
                  ))}
                </div>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Link
                    href="/setup"
                    className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-cyan-300 px-5 py-3 text-sm font-medium text-slate-950 shadow-[0_14px_40px_rgba(34,211,238,0.22)] hover:bg-cyan-200"
                  >
                    Continue setup
                  </Link>
                  <Link
                    href="/bootstrap"
                    className="inline-flex min-h-12 items-center justify-center rounded-2xl border border-white/10 bg-white/6 px-5 py-3 text-sm font-medium text-white hover:bg-white/10"
                  >
                    Open guided setup
                  </Link>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
                {[
                  { label: "Setup progress", value: `${bootstrap.progress.completedSteps}/${bootstrap.progress.totalSteps}`, detail: "required steps completed" },
                  { label: "Trusted sources", value: String(sources.length), detail: `${importedSources} imported so far` },
                  { label: "Brain runtime", value: health.ok ? "ready" : "offline", detail: "reachability and orchestration state" }
                ].map((item) => (
                  <div key={item.label} className="rounded-[24px] border border-white/10 bg-white/7 p-5 backdrop-blur">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-300">{item.label}</p>
                    <p className="mt-3 text-[1.9rem] font-semibold tracking-tight text-white">{item.value}</p>
                    <p className="mt-2 text-sm leading-7 text-slate-400">{item.detail}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        {!bootstrap.progress.onboardingComplete ? (
          <SetupStepGuide
            step="First-Time Setup"
            title="What to do next"
            statusLabel={`${bootstrap.progress.completedSteps}/${bootstrap.progress.totalSteps} complete`}
            whatToDo="Open Start Here, then work through purpose, owner setup, source import, provider setup, and verification in order. This is the recommended first-run path."
            whyItMatters="The brain works best when identity, provider routing, and trusted evidence are set up before normal sessions begin. That keeps later intake and retrieval from feeling random."
            nextHref="/setup"
            nextLabel="Continue setup"
          />
        ) : null}

        <div className="grid gap-5 xl:grid-cols-[1.18fr_0.82fr]">
          <div className="space-y-5">
            <Card className="overflow-hidden border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
              <CardHeader>
                <CardDescription>Daily operator loop</CardDescription>
                <CardTitle className="text-[1.45rem] tracking-tight">What to do with this thing once it is alive</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 pt-0">
                <div className="grid gap-3">
                  {[
                    {
                      href: bootstrap.progress.onboardingComplete ? "/sessions/new" : "/setup",
                      eyebrow: bootstrap.progress.onboardingComplete ? "1. Add or review evidence" : "1. Finish setup first",
                      title: bootstrap.progress.onboardingComplete ? "Start a session when you have something new to feed the brain." : "Get purpose, identity, providers, and verification in place before normal intake.",
                      detail: bootstrap.progress.onboardingComplete
                        ? "Use sessions for notes, transcripts, uploads, and operator review. That is the normal ingest path."
                        : "Skipping setup is how you end up with a very confident potato.",
                      cta: bootstrap.progress.onboardingComplete ? "Open sessions" : "Continue setup"
                    },
                    {
                      href: "/knowledge",
                      eyebrow: "2. Inspect believed state",
                      title: "Open What It Knows when you want the current answer, not a tour of the plumbing.",
                      detail: "That page is for identity, projects, people, routines, and beliefs with visible evidence.",
                      cta: "Open knowledge"
                    },
                    {
                      href: "/clarifications",
                      eyebrow: "3. Fix uncertainty before it multiplies",
                      title: "Resolve clarifications when the brain is unsure, conflicted, or being suspiciously poetic.",
                      detail: "That queue is where you stop weak grounding from turning into weird memory.",
                      cta: "Open clarifications"
                    }
                  ].map((item) => (
                    <Link
                      key={item.eyebrow}
                      href={item.href}
                      className="rounded-[24px] border border-white/8 bg-[linear-gradient(180deg,_rgba(255,255,255,0.06)_0%,_rgba(255,255,255,0.035)_100%)] p-5 transition-all hover:-translate-y-0.5 hover:border-cyan-300/22 hover:bg-white/8"
                    >
                      <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-cyan-100/75">{item.eyebrow}</p>
                      <p className="mt-3 text-base font-semibold tracking-tight text-white">{item.title}</p>
                      <p className="mt-2 text-sm leading-7 text-slate-300">{item.detail}</p>
                      <p className="mt-4 text-sm font-medium text-cyan-100">{item.cta}</p>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="overflow-hidden border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
              <CardHeader>
                <CardDescription>Recent sessions</CardDescription>
                <CardTitle className="text-[1.3rem] tracking-tight">Pick up where you left off</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 pt-0">
                {!bootstrap.progress.onboardingComplete ? (
                  <div className="rounded-[24px] border border-dashed border-cyan-300/20 bg-cyan-300/10 p-5 text-[15px] leading-8 text-cyan-50">
                    Finish setup before opening the full session workflow. That keeps new installs from jumping into intake before purpose, owner bootstrap, provider routing, and verification are in place.
                  </div>
                ) : sessions.length === 0 ? (
                  <div className="rounded-[24px] border border-dashed border-white/12 bg-white/5 p-5 text-[15px] leading-8 text-slate-300">
                    No sessions yet. Start one when you have notes, audio, uploads, or a specific thing you want the brain to digest.
                  </div>
                ) : (
                  <div className="grid gap-3">
                    {sessions.slice(0, 4).map((session) => (
                      <Link
                        key={session.id}
                        href={`/sessions/${session.id}/overview`}
                        className="block rounded-[22px] border border-white/8 bg-white/5 p-4 transition-all hover:-translate-y-0.5 hover:border-amber-300/25 hover:bg-white/8"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <h3 className="text-lg font-semibold tracking-tight text-white">{session.title}</h3>
                            <p className="mt-2 text-sm leading-7 text-slate-300">{session.notes ?? "No operator notes yet."}</p>
                          </div>
                          <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                            {session.status.replace(/_/g, " ")}
                          </Badge>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-400">
                          <span>namespace {session.namespaceId}</span>
                          <span>inputs {session.counts?.inputs ?? 0}</span>
                          <span>artifacts {session.counts?.artifacts ?? 0}</span>
                          <span>clarifications {session.counts?.openClarifications ?? 0}</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
                {bootstrap.progress.onboardingComplete && sessions.length > 0 ? (
                  <Link
                    href="/sessions"
                    className="inline-flex min-h-11 items-center rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-white hover:bg-white/8"
                  >
                    View all sessions
                  </Link>
                ) : null}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-5">
            <Card className="overflow-hidden border-cyan-300/14 bg-[radial-gradient(circle_at_top_right,_rgba(103,232,249,0.1),_transparent_28%),linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
              <CardHeader>
                <CardDescription>State at a glance</CardDescription>
                <CardTitle className="text-[1.45rem] tracking-tight">What needs attention right now</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 pt-0">
                <div className="grid gap-3 sm:grid-cols-2">
                  <MetricCard
                    title="Runtime"
                    value={health.ok ? "healthy" : "offline"}
                    tone={health.ok ? "success" : "warning"}
                    detail={health.ok ? "The brain runtime is reachable." : "The dashboard cannot reach the brain runtime."}
                  />
                  <MetricCard
                    title="Setup"
                    value={bootstrap.progress.onboardingComplete ? "ready" : `${bootstrap.progress.completedSteps}/${bootstrap.progress.totalSteps}`}
                    tone={bootstrap.progress.onboardingComplete ? "success" : "warning"}
                    detail="Purpose, owner setup, providers, sources, and verification."
                  />
                  <MetricCard
                    title="Clarifications"
                    value={clarifications?.summary.total ?? 0}
                    tone={(clarifications?.summary.total ?? 0) > 0 ? "warning" : "success"}
                    detail={`${priorityOneClarifications} urgent blockers in ${defaultNamespaceId}.`}
                  />
                  <MetricCard
                    title="Trusted sources"
                    value={sources.length}
                    detail={`${importedSources} imported, ${sources.reduce((sum, source) => sum + source.counts.filesPending, 0)} pending.`}
                  />
                </div>

                {clarifications?.summary.total ? (
                  <div className="rounded-[22px] border border-rose-300/16 bg-rose-300/10 p-4 text-sm leading-7 text-rose-50">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="border-rose-300/20 bg-rose-300/10 text-rose-100">
                        {priorityOneClarifications} Priority 1
                      </Badge>
                      <span>Clarifications are visible here on purpose. Bad grounding compounds.</span>
                    </div>
                    <div className="mt-3 space-y-2">
                      {clarifications.items.slice(0, 3).map((item) => (
                        <Link
                          key={item.candidateId}
                          href={`/clarifications?namespace=${encodeURIComponent(defaultNamespaceId)}`}
                          className="block rounded-[18px] border border-white/10 bg-black/15 p-3 text-slate-100 hover:bg-black/25"
                        >
                          <p className="font-medium text-white">{item.rawText}</p>
                          <p className="mt-1 text-xs leading-6 text-slate-300">{item.ambiguityReason ?? "Needs operator grounding before the graph should trust it."}</p>
                        </Link>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-[22px] border border-emerald-300/16 bg-emerald-300/10 p-4 text-sm leading-7 text-emerald-50">
                    No open clarification fire right now. The brain may finally be behaving.
                  </div>
                )}

                <details className="rounded-[22px] border border-white/8 bg-white/5 p-4">
                  <summary className="cursor-pointer list-none text-sm font-medium text-white">Advanced operations and system detail</summary>
                  <div className="mt-4 space-y-4">
                    <div className="grid gap-4 sm:grid-cols-3">
                      <div className="rounded-[18px] border border-emerald-300/16 bg-emerald-300/10 p-4">
                        <p className="text-[10px] uppercase tracking-[0.22em] text-emerald-100/80">Healthy or running</p>
                        <p className="mt-2 text-2xl font-semibold tracking-tight text-white">{workerSummary.healthy}</p>
                      </div>
                      <div className="rounded-[18px] border border-amber-300/16 bg-amber-300/10 p-4">
                        <p className="text-[10px] uppercase tracking-[0.22em] text-amber-100/80">Needs attention</p>
                        <p className="mt-2 text-2xl font-semibold tracking-tight text-white">{workerSummary.attention}</p>
                      </div>
                      <div className="rounded-[18px] border border-white/10 bg-white/5 p-4">
                        <p className="text-[10px] uppercase tracking-[0.22em] text-slate-300">Checked</p>
                        <p className="mt-2 text-sm font-medium leading-7 text-white">{formatDateTime(workerStatus.checkedAt)}</p>
                      </div>
                    </div>
                    <div className="grid gap-3">
                      {workerStatus.workers.map((worker) => (
                        <div key={worker.workerKey} className="rounded-[18px] border border-white/8 bg-black/15 p-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="text-sm font-medium text-white">{worker.workerKey.replace(/_/g, " ")}</p>
                            <p className={`text-xs uppercase tracking-[0.22em] ${workerStateTone(worker.state)}`}>{worker.state}</p>
                          </div>
                          <p className="mt-2 text-sm leading-7 text-slate-300">
                            Last run {formatDateTime(worker.latestRun?.finishedAt ?? worker.latestRun?.startedAt)}. Next due {formatDateTime(worker.nextDueAt)}.
                          </p>
                          {worker.recentFailures[0] ? (
                            <div className="mt-3 rounded-[16px] border border-rose-300/16 bg-rose-300/10 p-3 text-xs leading-6 text-rose-50">
                              <p className="font-medium text-white">
                                Latest failure
                                {typeof worker.recentFailures[0].summary.failure_category === "string"
                                  ? ` · ${worker.recentFailures[0].summary.failure_category}`
                                  : ""}
                              </p>
                              {worker.recentFailures[0].errorMessage ? <p className="mt-1">{worker.recentFailures[0].errorMessage}</p> : null}
                              {typeof worker.recentFailures[0].summary.retry_guidance === "string" ? (
                                <p className="mt-1">Retry guidance: {worker.recentFailures[0].summary.retry_guidance}</p>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Link href="/runtime" className="rounded-[18px] border border-white/10 bg-white/5 p-4 text-sm leading-7 text-slate-300 hover:bg-white/8">
                        <p className="font-medium text-white">Runtime control</p>
                        <p className="mt-1">Inspect providers, workers, and quick-run controls.</p>
                      </Link>
                      <Link href="/sources" className="rounded-[18px] border border-white/10 bg-white/5 p-4 text-sm leading-7 text-slate-300 hover:bg-white/8">
                        <p className="font-medium text-white">Source manager</p>
                        <p className="mt-1">See watched folders, last scans, and pending imports.</p>
                      </Link>
                      <Link href="/knowledge" className="rounded-[18px] border border-white/10 bg-white/5 p-4 text-sm leading-7 text-slate-300 hover:bg-white/8">
                        <p className="font-medium text-white">What it knows</p>
                        <p className="mt-1">Read the current identity, project, people, and belief state with evidence.</p>
                      </Link>
                      <Link href="/clarifications" className="rounded-[18px] border border-white/10 bg-white/5 p-4 text-sm leading-7 text-slate-300 hover:bg-white/8">
                        <p className="font-medium text-white">Clarifications</p>
                        <p className="mt-1">Resolve unknowns in a ranked queue instead of guessing.</p>
                      </Link>
                    </div>
                  </div>
                </details>
              </CardContent>
            </Card>

            <div className="overflow-hidden rounded-[30px] border border-white/8 bg-[radial-gradient(circle_at_top_right,_rgba(103,232,249,0.08),_transparent_26%),linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] px-5 py-5 shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
              <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-slate-300">How to use AI Brain day to day</p>
              <h3 className="mt-3 text-[1.3rem] font-semibold tracking-tight text-white">Think of it as a memory operating system, not a dashboard museum.</h3>
              <div className="mt-3 space-y-3 text-[15px] leading-8 text-slate-300">
                <p>Bring new material in through sessions or watched sources.</p>
                <p>Inspect the current believed state in What It Knows.</p>
                <p>Resolve clarifications whenever the brain looks uncertain, conflicted, or creatively wrong.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </OperatorShell>
  );
}
