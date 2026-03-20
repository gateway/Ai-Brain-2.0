import Link from "next/link";
import { OperatorShell } from "@/components/operator-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getBootstrapState, getRuntimeHealth, resolveBootstrapEmbeddingSettings } from "@/lib/operator-workbench";
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

export default async function SetupPage({
  searchParams
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const params = await searchParams;
  const [bootstrap, health] = await Promise.all([
    getBootstrapState().catch(() => null),
    getRuntimeHealth().catch(() => ({ ok: false }))
  ]);
  const defaultNamespaceId = bootstrap?.metadata.defaultNamespaceId ?? "personal";
  const embeddingSettings = bootstrap ? resolveBootstrapEmbeddingSettings(bootstrap.metadata) : {
    provider: "external" as const,
    model: null,
    dimensions: null
  };

  const purposeDone = Boolean(bootstrap?.metadata.brainPurposeMode);
  const ownerDone = Boolean(bootstrap?.ownerProfileCompleted);
  const importDone = Boolean(bootstrap?.sourceImportCompleted);
  const verifyDone = Boolean(bootstrap?.metadata.verificationSmokePackRunAt);
  const embeddingsConfigured = Boolean(embeddingSettings.provider);
  const embeddingTestDone = Boolean(bootstrap?.metadata.lastEmbeddingTest?.success);
  const embeddingRebuildDone = Boolean(bootstrap?.metadata.lastEmbeddingRebuild?.success);

  const setupSteps = [
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
      description: "Choose the operational lane first so namespace and verification defaults are explicit.",
      completed: purposeDone,
      href: "/bootstrap/purpose",
      hrefLabel: "Set purpose"
    },
    {
      key: "owner",
      title: "Finish owner bootstrap",
      description: "Create the self anchor, add owner evidence, and review what the brain learned.",
      completed: ownerDone,
      href: "/bootstrap/owner",
      hrefLabel: "Open owner bootstrap"
    },
    {
      key: "import",
      title: "Import trusted sources",
      description: "Add monitored folders or trusted bootstrap sources before relying on retrieval.",
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
    },
    {
      key: "embeddings",
      title: "Configure embeddings",
      description: "Choose local runtime, OpenRouter, Gemini, or deliberate lexical-only mode.",
      completed: embeddingsConfigured,
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

  const firstPendingIndex = setupSteps.findIndex((step) => !step.completed);

  return (
    <OperatorShell
      currentPath="/setup"
      title="Start Here"
      subtitle="This is the first-run path. Follow it step by step and the app will take you from a fresh install to a verified system that is ready for real use."
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
          whatToDo="Work through the checklist from top to bottom. Each step links directly to the page where that task is completed."
          whyItMatters="This app depends on having a purpose, self anchor, provider connection, trusted evidence, and verification in place. Skipping ahead makes the system harder to trust."
          nextHref={setupSteps[firstPendingIndex === -1 ? setupSteps.length - 1 : firstPendingIndex]?.href}
          nextLabel={firstPendingIndex === -1 ? "Review settings" : setupSteps[firstPendingIndex]?.hrefLabel}
        />
        <section className="overflow-hidden rounded-[34px] border border-white/8 bg-[radial-gradient(circle_at_top_right,_rgba(103,232,249,0.11),_transparent_24%),linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_28px_100px_rgba(0,0,0,0.28)]">
          <div className="grid gap-6 px-5 py-6 sm:px-6 lg:grid-cols-[minmax(0,1.15fr)_340px] lg:px-8 lg:py-8">
            <div className="space-y-4">
              <div className="inline-flex rounded-full border border-white/10 bg-white/6 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-100">
                First-time journey
              </div>
              <div className="space-y-3">
                <h2 className="max-w-3xl text-[1.85rem] font-semibold tracking-[-0.03em] text-white sm:text-[2.25rem]">
                  Set up the brain in one calm pass, then move into daily use.
                </h2>
                <p className="max-w-2xl text-[15px] leading-8 text-slate-200">
                  Everything here is ordered on purpose. Start with identity and purpose, connect the model provider, load trusted evidence, then verify retrieval before relying on the system.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  {
                    label: "Purpose",
                    detail: "Choose what kind of brain this is and which lane it should default to."
                  },
                  {
                    label: "Evidence",
                    detail: "Ground the system in owner context and trusted source material."
                  },
                  {
                    label: "Verification",
                    detail: "Prove retrieval and provider routing are actually working."
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
              {setupSteps.map((step, index) => {
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
          </section>

          <div className="space-y-5">
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
