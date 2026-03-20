import Link from "next/link";
import { completeVerificationAction, runBootstrapVerificationSmokePackAction } from "@/app/bootstrap/actions";
import { MetricCard } from "@/components/metric-card";
import { OperatorShell } from "@/components/operator-shell";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { SetupStepGuide } from "@/components/setup-step-guide";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { runBootstrapSmokePack } from "@/lib/bootstrap-verification";
import {
  type BootstrapSmokePackItem,
  getBootstrapState,
  getWorkbenchClarifications,
  getWorkbenchSelfProfile,
  getWorkbenchSession,
  getWorkbenchSessionReview,
  listWorkbenchSources,
  searchWorkbenchMemory
} from "@/lib/operator-workbench";

function searchValue(value: string | readonly string[] | undefined): string {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] ?? "" : "";
}

export default async function BootstrapVerifyPage({
  searchParams
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = searchValue(params.query);
  const [bootstrap, sources] = await Promise.all([getBootstrapState(), listWorkbenchSources()]);
  const namespaceId = bootstrap.metadata.defaultNamespaceId ?? sources[0]?.namespaceId ?? "personal";
  const sessionId =
    typeof bootstrap.metadata.ownerBootstrapSessionId === "string" ? bootstrap.metadata.ownerBootstrapSessionId : undefined;
  const [selfProfile, clarifications, adHocSearch, session, review] = await Promise.all([
    getWorkbenchSelfProfile(namespaceId).catch(() => null),
    getWorkbenchClarifications(namespaceId, 8).catch(() => null),
    query ? searchWorkbenchMemory({ query, namespaceId, limit: 6 }).catch(() => undefined) : undefined,
    sessionId ? getWorkbenchSession(sessionId).catch(() => null) : null,
    sessionId ? getWorkbenchSessionReview(sessionId).catch(() => null) : null
  ]);
  const smokePackLive = session ? await runBootstrapSmokePack({ namespaceId, session, review, selfProfile }) : [];

  const vectorFallbackReason =
    adHocSearch && typeof adHocSearch.meta.vectorFallbackReason === "string" ? adHocSearch.meta.vectorFallbackReason : undefined;

  const filesDiscovered = sources.reduce((sum, source) => sum + source.counts.filesDiscovered, 0);
  const filesImported = sources.reduce((sum, source) => sum + source.counts.filesImported, 0);
  const filesPending = sources.reduce((sum, source) => sum + source.counts.filesPending, 0);
  const persistedSmoke = Array.isArray(bootstrap.metadata.verificationSmokePack) ? bootstrap.metadata.verificationSmokePack : [];
  const smokePack = persistedSmoke.length > 0 ? persistedSmoke : smokePackLive;
  const passes = smokePack.filter((item) => item.pass).length;

  return (
    <OperatorShell
      currentPath="/bootstrap"
      title="Verify The Brain"
      subtitle="Run the final checks against the real substrate and confirm the brain can answer from evidence before you call setup done."
    >
      <div className="space-y-6">
        <SetupStepGuide
          step="Step 4"
          title="Confirm the brain can actually answer from what you loaded"
          statusLabel={bootstrap.verificationCompleted ? "complete" : "final check"}
          whatToDo="Run the smoke pack, inspect the supporting evidence, and use the ad hoc query only as a secondary tool if you want more context."
          whyItMatters="This is where setup stops being a form flow and becomes a real system check. You only want to treat setup as done once the brain can actually recall useful information with evidence."
          nextHref={bootstrap.verificationCompleted ? "/sessions" : "/"}
          nextLabel={bootstrap.verificationCompleted ? "Start using sessions" : "Back to dashboard"}
        />
        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard title="Namespace" value={namespaceId} detail="Verification target namespace." />
          <MetricCard title="Files imported" value={String(filesImported)} detail={`${filesDiscovered} discovered total`} />
          <MetricCard title="Smoke passes" value={`${passes}/${smokePack.length}`} detail="Queries with answer plus evidence." />
          <MetricCard title="Clarifications" value={String(clarifications?.summary?.total ?? 0)} detail="Open ambiguity items still visible." />
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Smoke pack</CardDescription>
              <CardTitle>Fixed verification questions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-[18px] border border-white/8 bg-white/5 px-4 py-3 text-sm leading-7 text-slate-300">
                These checks are meant to verify that the owner bootstrap produced recallable life state with supporting evidence, not just raw imported text.
              </div>
              {smokePack.map((item) => (
                <div key={item.query} className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-white">{item.label}</p>
                      <p className="text-xs text-slate-400">{item.query}</p>
                    </div>
                    <Badge variant="outline" className={item.pass ? "border-emerald-300/25 bg-emerald-300/12 text-emerald-50" : "border-amber-300/25 bg-amber-300/12 text-amber-50"}>
                      {item.pass ? "pass" : "needs work"}
                    </Badge>
                  </div>
                  <p className="mt-3 text-sm leading-7 text-slate-100">{item.answer}</p>
                  {item.evidence.length > 0 ? (
                    <div className="mt-3 space-y-2">
                      {item.evidence.map((evidence: BootstrapSmokePackItem["evidence"][number], index: number) => (
                        <div key={`${item.query}:${index}`} className="rounded-[16px] border border-white/8 bg-black/15 p-3 text-xs leading-6 text-slate-300">
                          {evidence.sourceUri ? <p className="text-slate-400">{evidence.sourceUri}</p> : null}
                          <p>{evidence.snippet}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
              <form action={runBootstrapVerificationSmokePackAction}>
                <PendingSubmitButton
                  idleLabel="Run and record smoke pack"
                  pendingLabel="Running smoke pack..."
                  className="rounded-2xl bg-cyan-300 text-slate-950 hover:bg-cyan-200"
                />
              </form>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Brain state</CardDescription>
                <CardTitle>Owner verification context</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
                <p>Self profile: <span className="font-medium text-white">{selfProfile?.canonicalName ?? "missing"}</span></p>
                <p>Open clarification items: <span className="font-medium text-white">{clarifications?.summary?.total ?? 0}</span></p>
                <p>Pending source changes: <span className="font-medium text-white">{filesPending}</span></p>
                <p>Last smoke run: <span className="font-medium text-white">{bootstrap.metadata.verificationSmokePackRunAt ?? "not recorded"}</span></p>
                <div className="flex flex-wrap gap-3">
                  <Link
                    href="/bootstrap/owner"
                    className="inline-flex items-center rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white hover:bg-white/10"
                  >
                    Back to owner bootstrap
                  </Link>
                  <Link
                    href="/console/relationships"
                    className="inline-flex items-center rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white hover:bg-white/10"
                  >
                    Open graph
                  </Link>
                </div>
              </CardContent>
            </Card>

            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Ad hoc query</CardDescription>
                <CardTitle>Secondary retrieval tool</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <form method="GET" className="grid gap-3">
                  <Input name="query" defaultValue={query} placeholder="Try a person, place, or project keyword" />
                  <button type="submit" className="w-fit rounded-2xl bg-white px-4 py-2.5 text-sm font-medium text-stone-950 hover:bg-stone-200">
                    Run query
                  </button>
                </form>

                <div className="rounded-[18px] border border-white/8 bg-white/5 px-4 py-3 text-sm leading-7 text-slate-300">
                  Keep this as a secondary tool. The fixed smoke pack above is the primary completion check.
                  {vectorFallbackReason ? (
                    <span className="block text-xs text-slate-400">Vector fallback: {vectorFallbackReason}</span>
                  ) : null}
                </div>

                {adHocSearch ? (
                  <div className="space-y-3">
                    {adHocSearch.results.length === 0 ? (
                      <div className="rounded-[20px] border border-white/8 bg-white/5 p-4 text-sm leading-7 text-slate-300">
                        No retrieval hits were returned for this query yet.
                      </div>
                    ) : (
                      adHocSearch.results.map((result) => (
                        <div key={result.memoryId} className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <Badge variant="outline" className="border-white/10 bg-white/5 text-stone-200">
                              {result.memoryType}
                            </Badge>
                            <span className="text-xs text-slate-400">{result.namespaceId}</span>
                          </div>
                          <p className="mt-3 text-sm leading-7 text-slate-100">{result.content}</p>
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </div>

        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Finish onboarding</CardDescription>
            <CardTitle>Record the verification step</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-4">
            <p className="max-w-3xl text-sm leading-7 text-slate-300">
              Finishing onboarding now assumes the owner bootstrap has real verification state behind it. The smoke pack must have been recorded before this step can be marked complete.
            </p>
            <form action={completeVerificationAction}>
              <PendingSubmitButton
                idleLabel={bootstrap.verificationCompleted ? "Verification already recorded" : "Finish onboarding"}
                pendingLabel="Recording verification..."
                className="rounded-2xl bg-amber-300 text-stone-950 hover:bg-amber-200"
              />
            </form>
          </CardContent>
        </Card>
      </div>
    </OperatorShell>
  );
}
