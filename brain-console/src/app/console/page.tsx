import Link from "next/link";
import { ConsoleShell } from "@/components/console-shell";
import { MetricCard, StatusBadge } from "@/components/metric-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getHealth, getLatestBenchmark, getLatestEval, getOpsOverview, getRuntimeBaseUrl } from "@/lib/brain-runtime";

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

  const passedChecks = evalJson?.checks.filter((item) => item.passed).length ?? 0;
  const totalChecks = evalJson?.checks.length ?? 0;

  return (
    <ConsoleShell
      currentPath="/console"
      title="Overview"
      subtitle="Live runtime status, BM25/FTS benchmark posture, and the current health of temporal, relationship, and queue layers."
    >
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
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
          title="Temporal Nodes"
          value={overview?.memorySummary.temporalNodes ?? "?"}
          detail="Current TMT-backed summary rows stored in Postgres."
          footer={<StatusBadge value={`linked relationships ${overview?.memorySummary.relationshipMemoryActive ?? "?"}`} />}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <Card>
          <CardHeader>
            <CardDescription>Operator Highlights</CardDescription>
            <CardTitle>What the console is showing now</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm leading-6 text-slate-700">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">BM25 default</Badge>
              <Badge variant="outline">FTS guarded fallback</Badge>
              <Badge variant="outline">RRF active</Badge>
              <Badge variant="outline">Timescale sidecar live</Badge>
              <Badge variant="outline">TMT summaries linked</Badge>
            </div>
            <p>
              BM25 is now the local lexical default because it cleared the strengthened suite with lower token burn than
              FTS. The console keeps the proof visible instead of hiding that decision in docs.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <Link
                href="/console/query"
                className="flex w-full items-center justify-between rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800"
              >
                <span>Run live retrieval</span>
                <span className="font-mono text-xs uppercase tracking-[0.3em]">search</span>
              </Link>
              <Link
                href="/console/timeline"
                className="flex w-full items-center justify-between rounded-2xl border border-slate-900/15 bg-white px-4 py-3 text-sm font-medium text-slate-900 hover:bg-slate-50"
              >
                <span>Open temporal atlas</span>
                <span className="font-mono text-xs uppercase tracking-[0.3em]">tmt</span>
              </Link>
              <Link
                href="/console/relationships"
                className="flex w-full items-center justify-between rounded-2xl border border-slate-900/15 bg-white px-4 py-3 text-sm font-medium text-slate-900 hover:bg-slate-50"
              >
                <span>Open relationship graph</span>
                <span className="font-mono text-xs uppercase tracking-[0.3em]">graph</span>
              </Link>
              <Link
                href="/console/inbox"
                className="flex w-full items-center justify-between rounded-2xl border border-slate-900/15 bg-white px-4 py-3 text-sm font-medium text-slate-900 hover:bg-slate-50"
              >
                <span>Review clarification inbox</span>
                <span className="font-mono text-xs uppercase tracking-[0.3em]">inbox</span>
              </Link>
              <Link
                href="/console/benchmark"
                className="flex w-full items-center justify-between rounded-2xl border border-slate-900/15 bg-white px-4 py-3 text-sm font-medium text-slate-900 hover:bg-slate-50"
              >
                <span>Inspect lexical benchmark</span>
                <span className="font-mono text-xs uppercase tracking-[0.3em]">bm25</span>
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Queue and Memory Health</CardDescription>
            <CardTitle>Current operator snapshot</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-6 text-slate-700">
            <div className="flex items-center justify-between">
              <span>Lexical provider</span>
              <StatusBadge value={overview?.lexicalProvider ?? "unknown"} />
            </div>
            <div className="flex items-center justify-between">
              <span>Lexical fallback</span>
              <StatusBadge value={overview?.lexicalFallbackEnabled ? "enabled" : "disabled"} />
            </div>
            <div className="flex items-center justify-between">
              <span>Derivation queue pending</span>
              <span className="font-mono text-sm">{overview?.queueSummary.derivation.pending ?? "?"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Vector sync pending</span>
              <span className="font-mono text-sm">{overview?.queueSummary.vectorSync.pending ?? "?"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Relationship candidates pending</span>
              <span className="font-mono text-sm">{overview?.memorySummary.relationshipCandidatesPending ?? "?"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Clarifications pending</span>
              <span className="font-mono text-sm">{overview?.memorySummary.clarificationPending ?? "?"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Outbox pending</span>
              <span className="font-mono text-sm">{overview?.memorySummary.outboxPending ?? "?"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Semantic decay events</span>
              <span className="font-mono text-sm">{overview?.memorySummary.semanticDecayEvents ?? "?"}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </ConsoleShell>
  );
}
