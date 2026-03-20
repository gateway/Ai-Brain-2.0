import Link from "next/link";
import { OperatorShell } from "@/components/operator-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listWorkbenchSessions } from "@/lib/operator-workbench";

export default async function SessionsPage() {
  const sessions = await listWorkbenchSessions();

  return (
    <OperatorShell
      currentPath="/sessions"
      title="Sessions"
      subtitle="Session-scoped operator work is first-class here. Each session groups intake, artifacts, model runs, staged outputs, and later correction history."
      actions={
        <Link
          href="/sessions/new"
          className="inline-flex items-center rounded-2xl border border-amber-300/25 bg-amber-300/12 px-4 py-2.5 text-sm font-medium text-amber-50 hover:border-amber-300/35 hover:bg-amber-300/16"
        >
          New session
        </Link>
      }
    >
      <div className="space-y-6">
        <section className="overflow-hidden rounded-[32px] border border-white/8 bg-[radial-gradient(circle_at_top_right,_rgba(250,204,21,0.08),_transparent_24%),linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] px-5 py-6 shadow-[0_24px_80px_rgba(0,0,0,0.24)] sm:px-6">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
            <div className="space-y-3">
              <p className="premium-eyebrow text-slate-300">Session workflow</p>
              <h3 className="text-[1.9rem] font-semibold tracking-[-0.04em] text-white">Use sessions as the durable container for operator work.</h3>
              <p className="max-w-2xl text-[15px] leading-8 text-slate-300">
                Each session keeps intake, source artifacts, model runs, staged outputs, and later corrections together so the evidence trail stays inspectable.
              </p>
            </div>
            <div className="premium-soft-panel rounded-[24px] border border-white/10 p-5">
              <p className="premium-eyebrow text-slate-300">Current library</p>
              <p className="mt-3 text-[1.65rem] font-semibold tracking-[-0.03em] text-white">{sessions.length} sessions</p>
              <p className="mt-2 text-sm leading-7 text-slate-400">Open a session to continue intake, review, clarification, and graph inspection.</p>
            </div>
          </div>
        </section>

      <Card className="overflow-hidden rounded-[30px] border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_22px_70px_rgba(0,0,0,0.22)]">
        <CardHeader>
          <CardDescription>Session registry</CardDescription>
          <CardTitle>{sessions.length} tracked sessions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {sessions.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-white/12 bg-white/5 p-6 text-sm leading-7 text-slate-300">
              No sessions exist yet. Create one to begin the minimum operator loop: session, intake, review.
            </div>
          ) : (
            sessions.map((session) => (
              <Link
                key={session.id}
                href={`/sessions/${session.id}/overview`}
                className="block rounded-[24px] border border-white/8 bg-white/5 p-5 transition-all hover:-translate-y-0.5 hover:border-amber-300/25 hover:bg-white/7"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                        {session.status.replace(/_/g, " ")}
                      </Badge>
                      <Badge variant="outline" className="border-teal-400/20 bg-teal-400/10 text-teal-100">
                        {session.namespaceId}
                      </Badge>
                    </div>
                    <h3 className="text-xl font-semibold text-white">{session.title}</h3>
                    <p className="max-w-3xl text-sm leading-7 text-slate-300">{session.notes ?? "No notes yet."}</p>
                  </div>
                  <p className="text-sm text-slate-400">{new Date(session.updatedAt).toLocaleString()}</p>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-4">
                  <Metric label="Inputs" value={session.counts?.inputs ?? 0} />
                  <Metric label="Artifacts" value={session.counts?.artifacts ?? 0} />
                  <Metric label="Model Runs" value={session.counts?.modelRuns ?? 0} />
                  <Metric label="Clarifications" value={session.counts?.openClarifications ?? 0} />
                </div>
              </Link>
            ))
          )}
        </CardContent>
      </Card>
      </div>
    </OperatorShell>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="rounded-[20px] border border-white/8 bg-white/5 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">{label}</p>
      <p className="mt-2 text-xl font-semibold text-white">{value}</p>
    </div>
  );
}
