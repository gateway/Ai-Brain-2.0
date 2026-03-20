import Link from "next/link";
import { launchOwnerBootstrapAction, markOwnerBootstrapCompleteAction } from "@/app/bootstrap/actions";
import { ConsoleEntryCard, ConsoleSection } from "@/components/console-primitives";
import { MetricCard } from "@/components/metric-card";
import { OperatorShell } from "@/components/operator-shell";
import { SetupStepGuide } from "@/components/setup-step-guide";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getBootstrapState, listWorkbenchSources } from "@/lib/operator-workbench";

function completedTone(completed: boolean): string {
  return completed
    ? "border-emerald-300/25 bg-emerald-300/12 text-emerald-50"
    : "border-white/10 bg-white/5 text-stone-200";
}

function stepCardTone(active: boolean): string {
  return active
    ? "border-cyan-300/30 bg-[linear-gradient(180deg,_rgba(56,189,248,0.14)_0%,_rgba(8,12,22,0.98)_100%)] shadow-[0_18px_45px_rgba(34,211,238,0.08)]"
    : "border-white/8 bg-[linear-gradient(180deg,_rgba(15,23,42,0.94)_0%,_rgba(8,12,22,0.98)_100%)]";
}

export default async function BootstrapPage() {
  const [bootstrap, sources] = await Promise.all([getBootstrapState(), listWorkbenchSources()]);
  const ownerBootstrapSessionId =
    typeof bootstrap.metadata.ownerBootstrapSessionId === "string" ? bootstrap.metadata.ownerBootstrapSessionId : undefined;
  const brainPurpose = bootstrap.metadata.brainPurposeMode ?? "not set";
  const importedSources = sources.filter((source) => source.lastImportAt).length;
  const hasPurpose = Boolean(bootstrap.metadata.brainPurposeMode);
  const highlightPurpose = !hasPurpose;
  const highlightOwner = hasPurpose && !bootstrap.ownerProfileCompleted;
  const highlightImport = hasPurpose && bootstrap.ownerProfileCompleted && !bootstrap.sourceImportCompleted;
  const purposeNamespace = bootstrap.metadata.defaultNamespaceId ?? "personal";

  return (
    <OperatorShell
      currentPath="/bootstrap"
      title="Guided Setup"
      subtitle="Use this guided setup flow to teach the system what kind of brain this is, who it belongs to, what trusted evidence it should start with, and whether retrieval is actually working."
      actions={
        <Link
          href="/bootstrap/import"
          className="inline-flex items-center rounded-2xl border border-amber-300/25 bg-amber-300/12 px-4 py-2.5 text-sm font-medium text-amber-50 hover:border-amber-300/35 hover:bg-amber-300/16"
        >
          Open source manager
        </Link>
      }
    >
      <div className="space-y-6">
        <SetupStepGuide
          step="Guided Setup"
          title="Move through the setup flow one step at a time"
          statusLabel={`${bootstrap.progress.completedSteps}/${bootstrap.progress.totalSteps} complete`}
          whatToDo="Complete the purpose step first, then the owner step, then import trusted files, then verify the brain. If you are unsure where to go next, follow the highlighted card below."
          whyItMatters="These steps create the initial brain configuration and trustworthy evidence base. They are the foundation for later sessions, graph review, and query/debug work."
          nextHref={
            !hasPurpose ? "/bootstrap/purpose" : !bootstrap.ownerProfileCompleted ? "/bootstrap/owner" : !bootstrap.sourceImportCompleted ? "/bootstrap/import" : "/bootstrap/verify"
          }
          nextLabel={!hasPurpose ? "Set purpose" : !bootstrap.ownerProfileCompleted ? "Open owner step" : !bootstrap.sourceImportCompleted ? "Import trusted sources" : "Run verification"}
        />
        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard title="Completed steps" value={`${bootstrap.progress.completedSteps}/${bootstrap.progress.totalSteps}`} detail="Tracked onboarding milestones." />
          <MetricCard title="Purpose" value={brainPurpose.replace(/_/g, " ")} detail="Stored in protected bootstrap state." />
          <MetricCard title="Namespace" value={purposeNamespace} detail="Derived from the typed purpose mode." />
          <MetricCard title="Sources" value={String(sources.length)} detail={`${importedSources} imported at least once`} />
          <MetricCard
            title="Verification"
            value={bootstrap.metadata.verificationSmokePackRunAt ? "ran" : "pending"}
            detail="Smoke-pack status for owner bootstrap."
          />
        </div>

        <ConsoleSection
          eyebrow="First Run"
          title="Bootstrap flow"
          description="This onboarding path is not a separate toy wizard. It stages real operator work: purpose, owner bootstrap, trusted source import, and verification."
        >
          <div className="grid gap-4 xl:grid-cols-3">
            <ConsoleEntryCard
              href="/bootstrap/purpose"
              eyebrow="Step 1"
              title="Brain purpose"
              description="Set whether this brain is personal, business, creative, or hybrid. This drives default namespace, source posture, and verification hints."
              meta={brainPurpose.replace(/_/g, " ")}
              badge={highlightPurpose ? "current step" : bootstrap.metadata.brainPurposeMode ? "saved" : "required"}
              className={stepCardTone(highlightPurpose)}
            />
            <div className={`rounded-[28px] border p-5 ${stepCardTone(highlightOwner)}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-200">Step 2</p>
                  <h3 className="mt-2 text-[1.15rem] font-semibold tracking-tight text-white">Owner bootstrap</h3>
                  <p className="mt-2 max-w-md text-[15px] leading-7 text-slate-100">
                    Create a dedicated owner intake session for self-anchor data, owner evidence, clarifications, and search-backed verification.
                  </p>
                </div>
                <Badge variant="outline" className={highlightOwner ? "border-cyan-300/30 bg-cyan-300/16 text-cyan-50" : completedTone(bootstrap.ownerProfileCompleted)}>
                  {highlightOwner ? "current step" : bootstrap.ownerProfileCompleted ? "complete" : ownerBootstrapSessionId ? "in progress" : "pending"}
                </Badge>
              </div>
              <div className="mt-6 flex flex-wrap gap-3">
                <form action={launchOwnerBootstrapAction}>
                  <Button type="submit" className="rounded-2xl bg-amber-300 text-stone-950 hover:bg-amber-200">
                    {ownerBootstrapSessionId ? "Continue owner bootstrap" : "Launch owner bootstrap"}
                  </Button>
                </form>
                {ownerBootstrapSessionId ? (
                  <Link
                    href="/bootstrap/owner"
                    className="inline-flex items-center rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white hover:bg-white/10"
                  >
                    Open owner flow
                  </Link>
                ) : null}
                {!bootstrap.ownerProfileCompleted && ownerBootstrapSessionId ? (
                  <form action={markOwnerBootstrapCompleteAction}>
                    <Button type="submit" variant="outline" className="rounded-2xl border-white/10 bg-white/5 text-white hover:bg-white/10">
                      Mark complete
                    </Button>
                  </form>
                ) : null}
              </div>
            </div>
            <ConsoleEntryCard
              href="/bootstrap/import"
              eyebrow="Step 3"
              title="Import existing memories"
              description="Register OpenClaw or local markdown folders, scan supported files, preview what changed, and import through the normal brain ingest path."
              meta={`${sources.length} configured sources`}
              badge={highlightImport ? "current step" : bootstrap.sourceImportCompleted ? "imported" : "pending"}
              className={stepCardTone(highlightImport)}
            />
          </div>
        </ConsoleSection>

        <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Verification</CardDescription>
              <CardTitle>Finish by checking the brain</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm leading-7 text-slate-300">
              <p>The verification page now runs a real smoke pack against the current namespace and shows the evidence returned for each question.</p>
              <div className="flex flex-wrap gap-3">
                <Link
                  href="/bootstrap/verify"
                  className="inline-flex items-center rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-4 py-2.5 text-sm font-medium text-cyan-50 hover:border-cyan-300/35 hover:bg-cyan-300/16"
                >
                  Open verification
                </Link>
                {bootstrap.progress.onboardingComplete ? (
                  <Badge variant="outline" className="border-emerald-300/25 bg-emerald-300/12 text-emerald-50">
                    onboarding complete
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-white/10 bg-white/5 text-stone-200">
                    onboarding still open
                  </Badge>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Model providers</CardDescription>
              <CardTitle>Choose local runtime or OpenRouter</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
              <p>This app can run against your own local model runtime or against OpenRouter. Both paths are valid. You choose which one to use in Settings.</p>
              <p><span className="font-medium text-white">Local runtime</span> is for your own endpoint and local models like Qwen. Use this when you want the brain to call a machine you control.</p>
              <p><span className="font-medium text-white">OpenRouter</span> is optional and uses your OpenRouter API key for hosted models and embeddings.</p>
              <p>Current note: local <span className="font-medium text-white">Qwen/Qwen3-Embedding-4B</span> can be tested now, but full namespace re-embed still requires a pgvector schema upgrade because it returns <span className="font-medium text-white">2560</span> dimensions.</p>
              <div>
                <Link
                  href="/settings"
                  className="inline-flex items-center rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-4 py-2.5 text-sm font-medium text-cyan-50 hover:border-cyan-300/35 hover:bg-cyan-300/16"
                >
                  Open provider settings
                </Link>
              </div>
            </CardContent>
          </Card>

          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Trusted sources</CardDescription>
              <CardTitle>Current monitored folders</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {sources.length === 0 ? (
                <p className="text-sm leading-7 text-slate-300">No trusted sources have been configured yet.</p>
              ) : (
                sources.slice(0, 6).map((source) => (
                  <div key={source.id} className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-white">{source.label}</p>
                        <p className="mt-1 text-xs text-slate-400">{source.rootPath}</p>
                      </div>
                      <Badge variant="outline" className={completedTone(Boolean(source.lastImportAt))}>
                        {source.monitorEnabled ? "monitoring on" : "manual only"}
                      </Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-400">
                      <span>{source.sourceType}</span>
                      <span>{source.counts.filesDiscovered} discovered</span>
                      <span>{source.counts.filesPending} pending</span>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </OperatorShell>
  );
}
