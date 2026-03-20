import Link from "next/link";
import { OperatorShell } from "@/components/operator-shell";
import { MetricCard } from "@/components/metric-card";
import { SetupStepGuide } from "@/components/setup-step-guide";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getBootstrapState, getNamespaceCatalog, getRuntimeHealth, listWorkbenchSessions, listWorkbenchSources } from "@/lib/operator-workbench";

export default async function WorkbenchDashboardPage() {
  const [sessions, health, namespaces, bootstrap, sources] = await Promise.all([
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
    listWorkbenchSources().catch(() => [])
  ]);
  const importedSources = sources.filter((source) => source.lastImportAt).length;

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
          <Card className="overflow-hidden border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
            <CardHeader>
              <CardDescription>Recent sessions</CardDescription>
              <CardTitle className="text-[1.45rem] tracking-tight">Operator loop entry point</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-0">
              {!bootstrap.progress.onboardingComplete ? (
                <div className="rounded-[26px] border border-dashed border-cyan-300/20 bg-cyan-300/10 p-6 text-[15px] leading-8 text-cyan-50">
                  Finish setup before opening the full session workflow. That keeps new installs from jumping into intake before purpose, owner bootstrap, provider routing, and verification are in place.
                </div>
              ) : sessions.length === 0 ? (
                <div className="rounded-[26px] border border-dashed border-white/12 bg-white/5 p-6 text-[15px] leading-8 text-slate-300">
                  Create your first session to start ingesting material into AI Brain.
                </div>
              ) : (
                sessions.slice(0, 6).map((session) => (
                  <Link
                    key={session.id}
                    href={`/sessions/${session.id}/overview`}
                    className="block rounded-[26px] border border-white/8 bg-[linear-gradient(180deg,_rgba(255,255,255,0.06)_0%,_rgba(255,255,255,0.035)_100%)] p-5 transition-all hover:-translate-y-0.5 hover:border-amber-300/25 hover:bg-white/8"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-xl font-semibold tracking-tight text-white">{session.title}</h3>
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
                ))
              )}
            </CardContent>
          </Card>

          <div className="space-y-5">
            <div className="overflow-hidden rounded-[30px] border border-white/8 bg-[radial-gradient(circle_at_top_right,_rgba(103,232,249,0.08),_transparent_26%),linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] px-5 py-5 shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
              <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-slate-300">What this home screen is for</p>
              <h3 className="mt-3 text-[1.3rem] font-semibold tracking-tight text-white">This is your operator control room.</h3>
              <p className="mt-3 max-w-xl text-[15px] leading-8 text-slate-300">
                Use it to finish setup, see whether the runtime is healthy, check whether trusted evidence has been imported, and then move into normal session intake once the system is verified.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <MetricCard
                title="Runtime"
                value={health.ok ? "healthy" : "offline"}
                tone={health.ok ? "success" : "warning"}
                detail="Operator workbench talks to the AI Brain HTTP runtime. Core memory logic stays behind that boundary."
              />
              <MetricCard
                title="Namespaces"
                value={namespaces.namespaces.length}
                detail={`Default lane: ${namespaces.defaultNamespaceId}`}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <MetricCard
                title="Bootstrap"
                value={bootstrap.progress.onboardingComplete ? "complete" : `${bootstrap.progress.completedSteps}/${bootstrap.progress.totalSteps}`}
                detail="Protected first-run state for purpose, owner bootstrap, import, and verification."
              />
              <MetricCard
                title="Trusted sources"
                value={sources.length}
                detail={`${importedSources} imported, ${sources.reduce((sum, source) => sum + source.counts.filesPending, 0)} pending`}
              />
            </div>

            <Card className="overflow-hidden border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
              <CardHeader>
                <CardDescription>Current slice</CardDescription>
                <CardTitle className="text-[1.35rem] tracking-tight">What is live now</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 pt-0 text-[15px] leading-8 text-slate-300">
                <p>Session CRUD is now explicit instead of hidden behind namespace-only tooling.</p>
                <p>Text intake runs through the brain runtime, persists durable source text, and can trigger chunked LLM classification.</p>
                <p>Review surfaces show entities, relationships, claims, and unresolved items tied back to session-linked chunks.</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </OperatorShell>
  );
}
