import { ConsoleShell } from "@/components/console-shell";
import { StatusBadge } from "@/components/metric-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getOpsOverview } from "@/lib/brain-runtime";

export default async function JobsPage() {
  const overview = await getOpsOverview();

  return (
    <ConsoleShell
      currentPath="/console/jobs"
      title="Jobs and Memory Health"
      subtitle="Read-only operator view for derivation and vector-sync queues, plus temporal and relationship memory totals."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>Derivation queue</CardDescription>
            <CardTitle>OCR, caption, transcript, summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-700">
            <div className="flex items-center justify-between">
              <span>Pending</span>
              <span className="font-mono">{overview.queueSummary.derivation.pending}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Processing</span>
              <span className="font-mono">{overview.queueSummary.derivation.processing}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Failed</span>
              <span className="font-mono">{overview.queueSummary.derivation.failed}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Completed</span>
              <span className="font-mono">{overview.queueSummary.derivation.completed}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Next attempt</span>
              <span className="font-mono text-xs">{overview.queueSummary.derivation.nextAttemptAt ?? "n/a"}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Vector sync queue</CardDescription>
            <CardTitle>Embedding sync and backfill</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-700">
            <div className="flex items-center justify-between">
              <span>Pending</span>
              <span className="font-mono">{overview.queueSummary.vectorSync.pending}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Processing</span>
              <span className="font-mono">{overview.queueSummary.vectorSync.processing}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Failed</span>
              <span className="font-mono">{overview.queueSummary.vectorSync.failed}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Completed</span>
              <span className="font-mono">{overview.queueSummary.vectorSync.completed}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Next attempt</span>
              <span className="font-mono text-xs">{overview.queueSummary.vectorSync.nextAttemptAt ?? "n/a"}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardDescription>Memory health</CardDescription>
          <CardTitle>Temporal and relationship state</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-slate-900/10 bg-slate-50 p-4">
            <p className="font-mono text-xs uppercase tracking-[0.28em] text-slate-500">Lexical mode</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <StatusBadge value={overview.lexicalProvider} />
              <StatusBadge value={overview.lexicalFallbackEnabled ? "fallback enabled" : "fallback disabled"} />
            </div>
          </div>
          <div className="rounded-2xl border border-slate-900/10 bg-slate-50 p-4">
            <p className="font-mono text-xs uppercase tracking-[0.28em] text-slate-500">Temporal nodes</p>
            <p className="mt-2 text-3xl font-semibold">{overview.memorySummary.temporalNodes}</p>
          </div>
          <div className="rounded-2xl border border-slate-900/10 bg-slate-50 p-4">
            <p className="font-mono text-xs uppercase tracking-[0.28em] text-slate-500">Relationship candidates pending</p>
            <p className="mt-2 text-3xl font-semibold">{overview.memorySummary.relationshipCandidatesPending}</p>
          </div>
          <div className="rounded-2xl border border-slate-900/10 bg-slate-50 p-4">
            <p className="font-mono text-xs uppercase tracking-[0.28em] text-slate-500">Active relationships</p>
            <p className="mt-2 text-3xl font-semibold">{overview.memorySummary.relationshipMemoryActive}</p>
          </div>
        </CardContent>
      </Card>
    </ConsoleShell>
  );
}
