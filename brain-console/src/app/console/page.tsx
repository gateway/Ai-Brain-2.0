import Link from "next/link";
import { ConsoleShell } from "@/components/console-shell";
import { ConsoleEntryCard, ConsoleSection } from "@/components/console-primitives";
import { MetricCard, StatusBadge } from "@/components/metric-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getHealth, getLatestBenchmark, getLatestEval, getOpsOverview, getRuntimeBaseUrl } from "@/lib/brain-runtime";
import { getBootstrapState, getWorkbenchClarifications } from "@/lib/operator-workbench";

export default async function ConsoleOverviewPage() {
  const [evalReport, benchmarkReport, health, ops] = await Promise.allSettled([
    getLatestEval(),
    getLatestBenchmark(),
    getHealth(),
    getOpsOverview()
  ]);

  const evalJson = evalReport.status === "fulfilled" ? evalReport.value.json : undefined;
  const benchmarkJson = benchmarkReport.status === "fulfilled" ? benchmarkReport.value.json : undefined;
  const runtimeHealth = health.status === "fulfilled" ? health.value : undefined;
  const overview = ops.status === "fulfilled" ? ops.value : undefined;
  const bootstrap = await getBootstrapState().catch(() => null);
  const defaultNamespaceId = bootstrap?.metadata.defaultNamespaceId ?? "personal";
  const clarifications = await getWorkbenchClarifications(defaultNamespaceId, 3).catch(() => null);
  const clarificationItems = clarifications?.items ?? [];

  const passedChecks = evalJson?.checks.filter((item) => item.passed).length ?? 0;
  const totalChecks = evalJson?.checks.length ?? 0;

  return (
    <ConsoleShell
      currentPath="/console"
      title="Overview"
      subtitle="Live runtime status, benchmark posture, continuity-first startup, and the current health of canonical entities, relationships, clarifications, and queue layers."
    >
      <div className="space-y-6 pt-6">
        <section className="overflow-hidden rounded-[34px] border border-white/8 bg-[radial-gradient(circle_at_top_right,_rgba(34,211,238,0.12),_transparent_26%),linear-gradient(180deg,_rgba(16,20,29,0.96)_0%,_rgba(8,11,20,0.98)_100%)] px-5 py-6 shadow-[0_28px_90px_rgba(0,0,0,0.26)] sm:px-6 lg:px-8">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_360px] lg:items-start">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="border-cyan-400/20 bg-cyan-400/10 text-cyan-100">
                  Advanced console
                </Badge>
                <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                  Canonical entities
                </Badge>
                <Badge variant="outline" className="border-emerald-400/20 bg-emerald-400/10 text-emerald-100">
                  Continuity-first startup
                </Badge>
                <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                  Clarification queue/list
                </Badge>
              </div>
              <div className="space-y-3">
                <h3 className="max-w-3xl text-[1.9rem] font-semibold tracking-[-0.04em] text-white sm:text-[2.35rem]">
                  Use the console when you need to inspect how the brain is actually behaving.
                </h3>
                <p className="max-w-2xl text-[15px] leading-8 text-slate-200">
                  This surface is for live retrieval, graph exploration, timeline inspection, clarification decisions, and benchmark posture. It is intentionally more technical than the guided workbench, and the session graph is still a placeholder while the derived atlas remains here.
                </p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
              {[
                { label: "Retrieval", value: "live", detail: "query and fallback inspection" },
                { label: "Graph", value: "derived", detail: "relationship atlas stays here while the session graph is pending" },
                { label: "Clarifications", value: clarifications?.summary.total ?? "?", detail: "ranked queue/list from the real backend" },
                { label: "Benchmark", value: benchmarkJson?.summary.recommendation ?? "unknown", detail: "lexical posture" }
              ].map((item) => (
                <div key={item.label} className="premium-soft-panel rounded-[24px] border border-white/10 p-4">
                  <p className="premium-eyebrow text-slate-300">{item.label}</p>
                  <p className="mt-3 text-[1.4rem] font-semibold tracking-[-0.03em] text-white">{item.value}</p>
                  <p className="mt-2 text-sm leading-7 text-slate-400">{item.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <ConsoleSection
        eyebrow="Operator entry points"
        title="Where to start in the brain"
        description="The console keeps the highest-signal surfaces visible first: query, timeline, relationships, clarifications, and benchmark posture. The rest of the runtime lives behind those doors."
        action={
          <>
            <Badge variant="outline" className="border-emerald-400/20 bg-emerald-400/10 text-emerald-100">
              BM25 default
            </Badge>
            <Badge variant="outline" className="border-sky-400/20 bg-sky-400/10 text-sky-100">
              RRF active
            </Badge>
            <Badge variant="outline" className="border-violet-400/20 bg-violet-400/10 text-violet-100">
              TMT summaries
            </Badge>
          </>
        }
        >
        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="grid gap-4 md:grid-cols-2">
            <ConsoleEntryCard
              href="/console/query"
              eyebrow="Primary action"
              title="Run live retrieval"
              description="Inspect planner intent, lexical mode, fallback behavior, and provenance on the active runtime."
              meta="search / exact / temporal"
              badge="query"
            />
            <ConsoleEntryCard
              href="/console/timeline"
              eyebrow="Temporal scan"
              title="Inspect timeline layers"
              description="Review episodic evidence alongside rolled-up summaries so long-horizon recall stays grounded."
              meta="episodic / day / week / month"
              badge="tmt"
            />
            <ConsoleEntryCard
              href="/console/relationships"
              eyebrow="Graph view"
              title="Open relationship memory"
              description="Trace people, places, projects, and edges without collapsing everything into a flat list."
              meta="entities / edges / predicates"
              badge="graph"
            />
            <ConsoleEntryCard
              href="/clarifications"
              eyebrow="Clarification queue"
              title="Resolve ambiguity before it spreads"
              description="Review ranked clarification items so names, places, and aliases stay grounded before they become graph edges."
              meta="queue / list / fixes"
              badge="clarify"
            />
            <ConsoleEntryCard
              href="/console/benchmark"
              eyebrow="Verification"
              title="Review lexical benchmark"
              description="Check the latest FTS vs BM25 posture before changing defaults or widening the retrieval stack."
              meta="fts / bm25 / token burn"
              badge="bm25"
            />
          </div>

          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <MetricCard
                title="Runtime"
                value={runtimeHealth?.ok ? "healthy" : "offline"}
                tone={runtimeHealth?.ok ? "success" : "warning"}
                detail={`Runtime base URL: ${getRuntimeBaseUrl()}`}
                footer={<StatusBadge value={runtimeHealth?.ok ? "HTTP ready" : "HTTP unavailable"} />}
              />
              <MetricCard
                title="Eval"
                value={`${passedChecks}/${totalChecks || "?"}`}
                tone={passedChecks === totalChecks && totalChecks > 0 ? "success" : "warning"}
                detail={evalJson ? `Latest run: ${new Date(evalJson.generatedAt).toLocaleString()}` : "Eval artifact not readable."}
              />
            </div>

            <MetricCard
              title="Benchmark"
              value={benchmarkJson?.summary.recommendation ?? "unknown"}
              tone={benchmarkJson?.summary.recommendation === "candidate_for_default" ? "success" : "warning"}
              detail={benchmarkJson ? benchmarkJson.summary.reason : "Benchmark artifact not readable."}
              footer={
                benchmarkJson ? (
                  <div className="flex flex-wrap gap-2">
                    <StatusBadge value={`FTS ${benchmarkJson.summary.ftsPassed}/${benchmarkJson.summary.totalCases}`} />
                    <StatusBadge value={`BM25 ${benchmarkJson.summary.bm25Passed}/${benchmarkJson.summary.totalCases}`} />
                  </div>
                ) : null
              }
            />

            <MetricCard
              title="Temporal nodes"
              value={overview?.memorySummary.temporalNodes ?? "?"}
              detail="Current TMT-backed summary rows stored in Postgres."
              footer={<StatusBadge value={`linked relationships ${overview?.memorySummary.relationshipMemoryActive ?? "?"}`} />}
            />
          </div>
        </div>
        </ConsoleSection>

        <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
            <Card className="relative overflow-hidden rounded-[30px] border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_22px_70px_rgba(0,0,0,0.22)]">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/12 to-transparent" />
          <div className="px-5 pt-5">
            <p className="premium-eyebrow font-mono text-slate-400">Current posture</p>
            <h3 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-white">What the console is showing now</h3>
          </div>
          <CardContent className="space-y-4 pt-5 text-sm leading-7 text-slate-300">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                BM25 default
              </Badge>
              <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                FTS guarded fallback
              </Badge>
              <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                RRF active
              </Badge>
              <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                Timescale sidecar live
              </Badge>
              <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                Clarifications live
              </Badge>
              <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                Session graph pending
              </Badge>
              <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                TMT summaries linked
              </Badge>
            </div>
            <p>
              BM25 is now the local lexical default because it cleared the strengthened suite with lower token burn than
              FTS. The console keeps the proof visible instead of hiding that decision in docs, and it also keeps the derived
              atlas visible until the session-scoped graph route is finished. Clarifications are a real queue/list, not a placeholder,
              and canonical entities are what we are trying to keep honest.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <Link
                href="/console/query"
                className="flex w-full items-center justify-between rounded-[20px] border border-cyan-400/20 bg-cyan-400/10 px-4 py-3 text-sm font-medium text-cyan-100 transition hover:border-cyan-400/30 hover:bg-cyan-400/15"
              >
                <span>Run live retrieval</span>
                <span className="font-mono text-xs uppercase tracking-[0.3em]">search</span>
              </Link>
              <Link
                href="/console/timeline"
                className="flex w-full items-center justify-between rounded-[20px] border border-white/8 bg-white/5 px-4 py-3 text-sm font-medium text-slate-100 transition hover:border-white/12 hover:bg-white/8"
              >
                <span>Open temporal atlas</span>
                <span className="font-mono text-xs uppercase tracking-[0.3em]">tmt</span>
              </Link>
              <Link
                href="/console/relationships"
                className="flex w-full items-center justify-between rounded-[20px] border border-white/8 bg-white/5 px-4 py-3 text-sm font-medium text-slate-100 transition hover:border-white/12 hover:bg-white/8"
              >
                <span>Open relationship atlas</span>
                <span className="font-mono text-xs uppercase tracking-[0.3em]">graph</span>
              </Link>
              <Link
                href="/clarifications"
                className="flex w-full items-center justify-between rounded-[20px] border border-white/8 bg-white/5 px-4 py-3 text-sm font-medium text-slate-100 transition hover:border-white/12 hover:bg-white/8"
              >
                <span>Open clarification queue/list</span>
                <span className="font-mono text-xs uppercase tracking-[0.3em]">queue</span>
              </Link>
              <Link
                href="/console/benchmark"
                className="flex w-full items-center justify-between rounded-[20px] border border-white/8 bg-white/5 px-4 py-3 text-sm font-medium text-slate-100 transition hover:border-white/12 hover:bg-white/8"
              >
                <span>Inspect lexical benchmark</span>
                <span className="font-mono text-xs uppercase tracking-[0.3em]">bm25</span>
              </Link>
            </div>
          </CardContent>
          </Card>

          <Card className="relative overflow-hidden rounded-[30px] border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_22px_70px_rgba(0,0,0,0.22)]">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/12 to-transparent" />
          <div className="px-5 pt-5">
            <p className="premium-eyebrow font-mono text-slate-400">Queue and memory health</p>
            <h3 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-white">Current operator snapshot</h3>
          </div>
          <CardContent className="space-y-4 pt-5 text-sm leading-7 text-slate-300">
            {clarificationItems.length ? (
              <div className="rounded-[22px] border border-white/8 bg-white/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-slate-500">Clarification queue</p>
                    <p className="mt-1 text-sm text-slate-300">Ranked unknowns surfaced from the backend.</p>
                  </div>
                  <Link href="/clarifications" className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-white hover:bg-white/8">
                    Open list
                  </Link>
                </div>
                <div className="mt-3 space-y-2">
                  {clarificationItems.map((item) => (
                    <Link
                      key={item.candidateId}
                      href="/clarifications"
                      className="block rounded-[18px] border border-white/8 bg-black/15 p-3 text-xs leading-6 text-slate-300 hover:bg-black/25"
                    >
                      <p className="font-medium text-white">{item.rawText}</p>
                      <p className="mt-1 text-slate-400">{item.ambiguityReason ?? "Needs operator grounding."}</p>
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-[22px] border border-white/8 bg-white/5 p-4">
                <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-slate-500">Lexical provider</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <StatusBadge value={overview?.lexicalProvider ?? "unknown"} />
                  <StatusBadge value={overview?.lexicalFallbackEnabled ? "fallback enabled" : "fallback disabled"} />
                </div>
              </div>
              <div className="rounded-[22px] border border-white/8 bg-white/5 p-4">
                <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-slate-500">Temporal nodes</p>
                <p className="mt-3 text-3xl font-semibold text-white">{overview?.memorySummary.temporalNodes}</p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-[22px] border border-white/8 bg-white/5 p-4">
                <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-slate-500">Derivation queue</p>
                <p className="mt-3 text-3xl font-semibold text-white">{overview?.queueSummary.derivation.pending ?? "?"}</p>
                <p className="mt-2 text-xs text-slate-400">pending jobs</p>
              </div>
              <div className="rounded-[22px] border border-white/8 bg-white/5 p-4">
                <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-slate-500">Vector sync</p>
                <p className="mt-3 text-3xl font-semibold text-white">{overview?.queueSummary.vectorSync.pending ?? "?"}</p>
                <p className="mt-2 text-xs text-slate-400">pending jobs</p>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="flex items-center justify-between rounded-[18px] border border-white/8 bg-white/5 px-4 py-3">
                <span>Relationship candidates</span>
                <span className="font-mono text-white">{overview?.memorySummary.relationshipCandidatesPending ?? "?"}</span>
              </div>
              <div className="flex items-center justify-between rounded-[18px] border border-white/8 bg-white/5 px-4 py-3">
                <span>Clarifications pending</span>
                <span className="font-mono text-white">{overview?.memorySummary.clarificationPending ?? "?"}</span>
              </div>
              <div className="flex items-center justify-between rounded-[18px] border border-white/8 bg-white/5 px-4 py-3">
                <span>Outbox pending</span>
                <span className="font-mono text-white">{overview?.memorySummary.outboxPending ?? "?"}</span>
              </div>
              <div className="flex items-center justify-between rounded-[18px] border border-white/8 bg-white/5 px-4 py-3">
                <span>Semantic decay events</span>
                <span className="font-mono text-white">{overview?.memorySummary.semanticDecayEvents ?? "?"}</span>
              </div>
            </div>
          </CardContent>
          </Card>
        </div>
      </div>
    </ConsoleShell>
  );
}
