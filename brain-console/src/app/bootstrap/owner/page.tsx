import Link from "next/link";
import {
  markOwnerBootstrapCompleteAction,
  runBootstrapVerificationSmokePackAction,
  saveBootstrapSelfProfileAction
} from "@/app/bootstrap/actions";
import { MetricCard } from "@/components/metric-card";
import { ClarificationWorkbench } from "@/components/clarification-workbench";
import { OwnerNarrativeForm } from "@/components/owner-narrative-form";
import { OperatorShell } from "@/components/operator-shell";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { SessionFileIntakePanel } from "@/components/session-file-intake-panel";
import { SetupStepGuide } from "@/components/setup-step-guide";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { runBootstrapSmokePack } from "@/lib/bootstrap-verification";
import { getModelRuntimeOverview } from "@/lib/model-runtime";
import {
  type BootstrapSmokePackItem,
  getBootstrapState,
  getWorkbenchClarifications,
  getWorkbenchSelfProfile,
  getWorkbenchSession,
  getWorkbenchSessionReview,
} from "@/lib/operator-workbench";

function searchValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

function confidenceTone(confidence?: number): string {
  if (confidence === undefined) {
    return "border-white/10 bg-white/5 text-slate-100";
  }
  if (confidence >= 0.85) {
    return "border-emerald-400/20 bg-emerald-400/10 text-emerald-100";
  }
  if (confidence >= 0.6) {
    return "border-amber-300/20 bg-amber-300/10 text-amber-100";
  }
  return "border-rose-400/20 bg-rose-400/10 text-rose-100";
}

function summarizeLocation(item: BootstrapSmokePackItem | undefined): string {
  return item?.pass ? item.answer : "Not verified yet";
}

function summarizeProjects(item: BootstrapSmokePackItem | undefined): string {
  return item?.pass ? item.answer : "No project recall yet";
}

function summarizePreferences(item: BootstrapSmokePackItem | undefined): string {
  return item?.pass ? item.answer : "No preference recall yet";
}

export default async function BootstrapOwnerPage({
  searchParams
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const params = await searchParams;
  const bootstrap = await getBootstrapState();
  const sessionId =
    typeof bootstrap.metadata.ownerBootstrapSessionId === "string" ? bootstrap.metadata.ownerBootstrapSessionId : undefined;

  if (!sessionId) {
    return (
      <OperatorShell
        currentPath="/bootstrap"
        title="Owner Setup"
        subtitle="This step creates the protected owner profile session where you tell the brain who you are and add the first trusted evidence about yourself."
      >
        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Owner profile session</CardDescription>
            <CardTitle>Launch the protected owner bootstrap</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm leading-7 text-slate-300">
            <p>Start Step 2 from the Bootstrap overview. A dedicated owner session is created once and reused until you finish review.</p>
            <Link
              href="/bootstrap"
              className="inline-flex items-center rounded-2xl border border-amber-300/25 bg-amber-300/12 px-4 py-2.5 text-sm font-medium text-amber-50 hover:border-amber-300/35 hover:bg-amber-300/16"
            >
              Back to bootstrap
            </Link>
          </CardContent>
        </Card>
      </OperatorShell>
    );
  }

  const namespaceId = bootstrap.metadata.defaultNamespaceId ?? "personal";
  const [session, review, modelRuntime, selfProfile, clarifications] = await Promise.all([
    getWorkbenchSession(sessionId),
    getWorkbenchSessionReview(sessionId).catch(() => null),
    getModelRuntimeOverview().catch(() => null),
    getWorkbenchSelfProfile(namespaceId).catch(() => null),
    getWorkbenchClarifications(namespaceId, 8).catch(() => null)
  ]);
  const liveSmoke = await runBootstrapSmokePack({ namespaceId, session, review, selfProfile });

  const llmModels = modelRuntime?.families.find((family) => family.family === "llm")?.supportedModels ?? [];
  const asrModels = modelRuntime?.families.find((family) => family.family === "asr")?.supportedModels ?? [];
  const presets = modelRuntime?.presets ?? [];
  const persistedSmoke = Array.isArray(bootstrap.metadata.verificationSmokePack) ? bootstrap.metadata.verificationSmokePack : [];
  const smokePack = persistedSmoke.length > 0 ? persistedSmoke : liveSmoke;
  const hasEvidence = (session.counts?.inputs ?? 0) > 0 || (session.artifacts?.length ?? 0) > 0;
  const hasReviewData = Boolean(review && (review.summary.entityCount > 0 || review.summary.relationshipCount > 0 || review.summary.claimCount > 0));
  const hasSmokePack = Array.isArray(bootstrap.metadata.verificationSmokePack) && Boolean(bootstrap.metadata.verificationSmokePackRunAt);
  const completionChecks = [
    { label: "Self profile exists", pass: Boolean(selfProfile) },
    { label: "At least one owner evidence artifact exists", pass: hasEvidence },
    { label: "Review data exists", pass: hasReviewData },
    { label: "Verification smoke pack has run", pass: hasSmokePack }
  ];
  const error = searchValue(params.error);
  const missing = searchValue(params.missing)?.split(",").filter(Boolean) ?? [];
  const saved = searchValue(params.saved);
  const smokeStatus = searchValue(params.smoke);
  const clarificationStatus = searchValue(params.clarification);
  const locationSmoke = smokePack.find((item) => item.query === "where do I live?");
  const friendsSmoke = smokePack.find((item) => item.query === "who are my friends?");
  const projectsSmoke = smokePack.find((item) => item.query === "what am I working on?");
  const likesSmoke = smokePack.find((item) => item.query === "what do I like?");

  return (
    <OperatorShell
      currentPath="/bootstrap"
      title="Owner Setup"
      subtitle="Tell the brain who you are, add owner evidence, review what it learned, and only then mark this step complete."
      actions={
        <Link
          href={`/sessions/${session.id}/review`}
          className="inline-flex items-center rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-4 py-2.5 text-sm font-medium text-cyan-50 hover:border-cyan-300/35 hover:bg-cyan-300/16"
        >
          Open full review
        </Link>
      }
    >
      <div className="space-y-6">
        <SetupStepGuide
          step="Step 2"
          title="Set the owner identity and add the first personal evidence"
          statusLabel={bootstrap.ownerProfileCompleted ? "complete" : "in progress"}
          whatToDo="Save the self profile first. Then add a typed narrative, microphone notes, or bootstrap files so the brain has real evidence to classify and review."
          whyItMatters="The owner step gives the brain a real self anchor and a trustworthy first body of evidence. Without it, later retrieval and graph state are much harder to trust."
          nextHref="/bootstrap/import"
          nextLabel="Next: import trusted sources"
        />
        {error ? (
          <div className="rounded-[22px] border border-amber-300/25 bg-amber-300/12 px-4 py-3 text-sm text-amber-50">
            {error === "incomplete"
              ? `Owner bootstrap cannot be completed yet. Missing: ${missing.join(", ")}.`
              : error === "missing-self-name"
                ? "Canonical name is required before the self anchor can be saved."
                : "Owner bootstrap action could not complete."}
          </div>
        ) : null}
        {saved === "self" ? (
          <div className="rounded-[22px] border border-emerald-300/25 bg-emerald-300/12 px-4 py-3 text-sm text-emerald-50">
            Self profile saved to the brain and bound to namespace <code>{namespaceId}</code>.
          </div>
        ) : null}
        {smokeStatus === "done" ? (
          <div className="rounded-[22px] border border-cyan-300/25 bg-cyan-300/12 px-4 py-3 text-sm text-cyan-50">
            Verification smoke pack recorded against the current namespace.
          </div>
        ) : null}
        {clarificationStatus ? (
          <div className="rounded-[22px] border border-emerald-300/25 bg-emerald-300/12 px-4 py-3 text-sm text-emerald-50">
            Clarification {clarificationStatus === "resolved" ? "resolved" : "ignored"} and sent to the brain.
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard title="Namespace" value={namespaceId} detail="Derived from bootstrap purpose mode." />
          <MetricCard title="Inputs" value={String(session.counts?.inputs ?? 0)} detail="Typed notes plus owner bootstrap files." />
          <MetricCard title="Review rows" value={String(review ? review.summary.claimCount + review.summary.relationshipCount : 0)} detail="Claims and relationships staged so far." />
          <MetricCard title="Clarifications" value={String(clarifications?.summary?.total ?? session.counts?.openClarifications ?? 0)} detail="Open ambiguity items from the real backend." />
        </div>

        <Card className="border-cyan-300/18 bg-[linear-gradient(180deg,_rgba(12,28,39,0.94)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Step 2</CardDescription>
            <CardTitle>Owner bootstrap is a verified intake lane</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm leading-7 text-slate-200">
            <div className="grid gap-3 lg:grid-cols-4">
              <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">1. Save self anchor</p>
                <p className="mt-2">Bind the canonical owner identity to this namespace with real profile APIs before relying on narrative text.</p>
              </div>
              <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">2. Add evidence</p>
                <p className="mt-2">Typed text, markdown, audio, and microphone notes land in the protected owner bootstrap session as provenance-bearing evidence.</p>
              </div>
              <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">3. Review and clarify</p>
                <p className="mt-2">Inspect learned state, staged entities, and live clarification items before treating this bootstrap as trustworthy.</p>
              </div>
              <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">4. Run smoke checks</p>
                <p className="mt-2">Ask the substrate real questions and confirm the answer comes back with supporting evidence before completion.</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 rounded-[20px] border border-white/10 bg-black/15 px-4 py-3">
              <StatusBadge status={session.status} />
              <span className="text-sm text-slate-300">Current defaults:</span>
              <span className="text-sm text-slate-400">LLM provider {session.defaultLlmProvider === "openrouter" ? "OpenRouter" : "Local runtime"}</span>
              <span className="text-sm text-slate-400">Preset {session.defaultLlmPreset ?? "research-analyst"}</span>
              <span className="text-sm text-slate-400">ASR {session.defaultAsrModel ?? "runtime default"}</span>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="grid gap-4">
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Self anchor</CardDescription>
                <CardTitle>Save the owner identity explicitly</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-[20px] border border-white/10 bg-white/4 p-4 text-sm leading-7 text-slate-300">
                  This calls <code>POST /ops/profile/self</code>. The owner narrative helps classification, but it is not the same thing as binding the self anchor.
                </div>
                <form action={saveBootstrapSelfProfileAction} className="grid gap-4">
                  <input type="hidden" name="namespace_id" value={namespaceId} />
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="grid gap-2">
                      <span className="text-sm font-medium text-slate-100">Canonical name</span>
                      <Input name="canonical_name" required defaultValue={selfProfile?.canonicalName ?? ""} placeholder="Steve Tietze" />
                    </label>
                    <label className="grid gap-2">
                      <span className="text-sm font-medium text-slate-100">Aliases</span>
                      <Input
                        name="aliases"
                        defaultValue={selfProfile?.aliases.join(", ") ?? ""}
                        placeholder="Steve, Steven"
                      />
                    </label>
                  </div>
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Note</span>
                    <Textarea
                      name="note"
                      rows={3}
                      defaultValue={typeof selfProfile?.metadata?.note === "string" ? selfProfile.metadata.note : ""}
                      placeholder="Optional note about how the self profile should be interpreted."
                    />
                  </label>
                  <PendingSubmitButton
                    idleLabel={selfProfile ? "Update self profile" : "Save self profile"}
                    pendingLabel="Saving self profile..."
                    className="w-fit rounded-2xl bg-cyan-300 text-slate-950 hover:bg-cyan-200"
                  />
                </form>
              </CardContent>
            </Card>

            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Owner narrative</CardDescription>
                <CardTitle>Type the first “about me” profile pass</CardTitle>
              </CardHeader>
              <CardContent>
                <OwnerNarrativeForm
                  sessionId={session.id}
                  defaultLlmProvider={session.defaultLlmProvider}
                  defaultLlmModel={session.defaultLlmModel}
                  defaultLlmPreset={session.defaultLlmPreset}
                  llmModels={llmModels}
                  presets={presets}
                />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4">
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>What the brain learned</CardDescription>
                <CardTitle>High-signal learned state after ingest</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">Self identity</p>
                  <p className="mt-2 text-sm text-white">{selfProfile?.canonicalName ?? "Self profile not saved yet"}</p>
                  {selfProfile?.aliases.length ? <p className="mt-1 text-xs text-slate-400">aliases: {selfProfile.aliases.join(", ")}</p> : null}
                </div>
                <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">Current location</p>
                  <p className="mt-2 text-sm text-white">{summarizeLocation(locationSmoke)}</p>
                </div>
                <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">Current projects</p>
                  <p className="mt-2 text-sm text-white">{summarizeProjects(projectsSmoke)}</p>
                </div>
                <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">Important people</p>
                  <p className="mt-2 text-sm text-white">{friendsSmoke?.pass ? friendsSmoke.answer : review?.entities.slice(0, 4).map((entity) => entity.displayLabel).join(", ") || "No people surfaced yet"}</p>
                </div>
                <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">Preferences</p>
                  <p className="mt-2 text-sm text-white">{summarizePreferences(likesSmoke)}</p>
                </div>
                <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">Open clarifications</p>
                  <p className="mt-2 text-sm text-white">{clarifications?.summary?.total ?? 0} active clarification items</p>
                  {(clarifications?.items ?? []).slice(0, 3).map((item) => (
                    <p key={item.candidateId} className="mt-2 text-xs leading-6 text-slate-400">
                      {item.ambiguityType}: {item.rawText}
                    </p>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Bootstrap documents</CardDescription>
                <CardTitle>Add markdown, text, audio, and mic notes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-[20px] border border-white/10 bg-white/4 p-4 text-sm leading-7 text-slate-300">
                  Markdown, text, audio, and microphone recordings land in the protected owner bootstrap session as real evidence. PDF and image uploads are stored, but still wait on OCR or vision adapters.
                </div>
                <SessionFileIntakePanel
                  sessionId={session.id}
                  defaultAsrModel={session.defaultAsrModel}
                  defaultLlmProvider={session.defaultLlmProvider}
                  defaultLlmModel={session.defaultLlmModel}
                  defaultLlmPreset={session.defaultLlmPreset}
                  asrModels={asrModels}
                  llmModels={llmModels}
                  presets={presets}
                />
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Verification surfaces</CardDescription>
              <CardTitle>Live backend checks after owner ingest</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                <MetricCard title="Self profile" value={selfProfile ? "present" : "missing"} detail="GET /ops/profile/self" />
                <MetricCard title="Clarifications" value={String(clarifications?.summary?.total ?? 0)} detail="GET /ops/clarifications" />
                <MetricCard title="Search passes" value={String(smokePack.filter((item) => item.pass).length)} detail="GET /search smoke checks" />
                <MetricCard title="Last run" value={bootstrap.metadata.verificationSmokePackRunAt ? "recorded" : "live only"} detail="Persisted in bootstrap metadata." />
              </div>

              <div className="space-y-3">
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
              </div>

              <div className="flex flex-wrap gap-3">
                <form action={runBootstrapVerificationSmokePackAction}>
                  <PendingSubmitButton
                    idleLabel="Run and record smoke pack"
                    pendingLabel="Running smoke pack..."
                    className="rounded-2xl bg-cyan-300 text-slate-950 hover:bg-cyan-200"
                  />
                </form>
                <Link
                  href="/bootstrap/verify"
                  className="inline-flex items-center rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white hover:bg-white/10"
                >
                  Open verification page
                </Link>
              </div>
            </CardContent>
          </Card>

          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Completion gate</CardDescription>
              <CardTitle>Requirements to finish owner bootstrap</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                {completionChecks.map((item) => (
                  <div key={item.label} className="flex items-center justify-between gap-3 rounded-[18px] border border-white/8 bg-white/5 px-4 py-3">
                    <p className="text-sm text-white">{item.label}</p>
                    <Badge variant="outline" className={item.pass ? "border-emerald-300/25 bg-emerald-300/12 text-emerald-50" : "border-white/10 bg-white/5 text-stone-200"}>
                      {item.pass ? "ready" : "missing"}
                    </Badge>
                  </div>
                ))}
              </div>

              <div className="rounded-[20px] border border-white/8 bg-black/15 p-4 text-sm leading-7 text-slate-300">
                Completion no longer means “the user clicked complete.” It now requires a self anchor, at least one owner evidence artifact, non-empty review data, and a recorded verification smoke pack.
              </div>

              {review ? (
                <div className="grid gap-3 md:grid-cols-4">
                  <MetricCard title="Entities" value={String(review.summary.entityCount)} detail="Detected identity candidates." />
                  <MetricCard title="Relationships" value={String(review.summary.relationshipCount)} detail="Edges staged from bootstrap evidence." />
                  <MetricCard title="Claims" value={String(review.summary.claimCount)} detail="Candidate facts awaiting trust." />
                  <MetricCard title="Unresolved" value={String(review.summary.unresolvedCount)} detail="Clarifications still open." />
                </div>
              ) : (
                <p className="text-sm leading-7 text-slate-300">Review data will appear here after the first owner narrative or bootstrap file is ingested.</p>
              )}

              {review?.entities.slice(0, 4).map((entity) => (
                <div key={entity.entityId} className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-white">{entity.displayLabel}</p>
                      <p className="text-xs text-slate-400">{entity.entityType}</p>
                    </div>
                    <Badge variant="outline" className={confidenceTone(entity.confidence)}>
                      {entity.confidence !== undefined ? `${Math.round(entity.confidence * 100)}%` : "n/a"}
                    </Badge>
                  </div>
                </div>
              ))}

              <div className="flex flex-wrap gap-3">
                <Link
                  href={`/sessions/${session.id}/clarifications`}
                  className="inline-flex items-center rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white hover:bg-white/10"
                >
                  Open clarifications
                </Link>
                <Link
                  href={`/sessions/${session.id}/review`}
                  className="inline-flex items-center rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white hover:bg-white/10"
                >
                  Open review
                </Link>
                <form action={markOwnerBootstrapCompleteAction}>
                  <PendingSubmitButton
                    idleLabel="Mark owner bootstrap complete"
                    pendingLabel="Verifying completion..."
                    disabled={!completionChecks.every((item) => item.pass)}
                    className="rounded-2xl bg-amber-300 text-stone-950 hover:bg-amber-200 disabled:cursor-not-allowed disabled:bg-stone-500"
                  />
                </form>
              </div>
            </CardContent>
          </Card>
        </div>

        <ClarificationWorkbench
          namespaceId={namespaceId}
          clarifications={clarifications}
          redirectPath="/bootstrap/owner"
          title="Resolve the top owner bootstrap ambiguities"
          description="This same clarification system is meant to plug into bootstrap, session review, and later inbox surfaces. Resolve people, kinship labels, vague places, and aliases here and push the correction back into the brain."
          limit={3}
          compact
        />
      </div>
    </OperatorShell>
  );
}
