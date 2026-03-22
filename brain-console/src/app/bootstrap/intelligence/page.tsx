import Link from "next/link";
import { saveOnboardingIntelligenceAction } from "@/app/bootstrap/actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { OperatorShell } from "@/components/operator-shell";
import { SetupStepGuide } from "@/components/setup-step-guide";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getModelRuntimeOverview } from "@/lib/model-runtime";
import { getBootstrapState, listOpenRouterModels, resolveBootstrapEmbeddingSettings, resolveWorkbenchOperationsSettings } from "@/lib/operator-workbench";

const selectClassName =
  "h-11 rounded-[18px] border border-white/12 bg-white/6 px-4 text-sm text-white outline-none ring-0";

function searchValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

export default async function BootstrapIntelligencePage({
  searchParams
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const params = await searchParams;
  const bootstrap = await getBootstrapState();
  const [runtime, openRouterModels] = await Promise.all([
    getModelRuntimeOverview().catch(() => null),
    listOpenRouterModels().catch(() => [])
  ]);
  const operations = resolveWorkbenchOperationsSettings(bootstrap.metadata);
  const embeddings = resolveBootstrapEmbeddingSettings(bootstrap.metadata);
  const llmModels = runtime?.families.find((family) => family.family === "llm")?.supportedModels ?? [];
  const asrModels = runtime?.families.find((family) => family.family === "asr")?.supportedModels ?? [];
  const presets = runtime?.presets ?? [];
  const openRouterLlmModels = openRouterModels.filter((model) => model.supportsChat).slice(0, 20);
  const saved = searchValue(params.saved);
  const currentMode = bootstrap.metadata.intelligenceMode ?? (runtime?.reachable ? "external" : openRouterLlmModels.length > 0 ? "openrouter" : "skip");
  const modelListId = "onboarding-llm-models";

  return (
    <OperatorShell
      currentPath="/bootstrap"
      title="Connect Intelligence"
      subtitle="Pick where the brain gets model help for chat, summaries, ASR, and embeddings."
      actions={
        <div className="flex flex-wrap gap-2">
          <Link
            href="/help#provider-choices"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center rounded-2xl border border-white/10 bg-white/6 px-4 py-2.5 text-sm font-medium text-white hover:bg-white/10"
          >
            Docs
          </Link>
        </div>
      }
    >
      <div className="mx-auto max-w-5xl space-y-5">
        <SetupStepGuide
          step="Step 2"
          title="Choose where the brain gets its help"
          statusLabel={bootstrap.metadata.intelligenceSetupCompletedAt ? "saved" : "choose a route"}
          whatToDo="Pick local runtime, OpenRouter, or skip for now. Then choose whether summaries stay factual-only or get a readable LLM overlay."
          whyItMatters="This controls whether ASR, classification, summaries, and vector helpers are available during setup."
          nextHref="/bootstrap/owner"
          nextLabel="Next: tell the brain who you are"
        />

        {saved === "intelligence" ? (
          <div className="rounded-[22px] border border-emerald-300/25 bg-emerald-300/12 px-4 py-3 text-sm text-emerald-50">
            Intelligence settings saved. Tiny robots are pleased, but still evidence-bound.
          </div>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[1.08fr_0.92fr]">
          <Card className="border-white/8 bg-[radial-gradient(circle_at_top_right,_rgba(103,232,249,0.1),_transparent_26%),linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Step 2</CardDescription>
              <CardTitle>How the brain runs after setup</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <form action={saveOnboardingIntelligenceAction} className="grid gap-4">
                <label className="grid gap-2 md:max-w-sm">
                  <span className="text-sm font-medium text-slate-100">Primary intelligence route</span>
                  <select name="intelligence_route" defaultValue={currentMode} className={selectClassName}>
                    <option value="external">Local runtime</option>
                    <option value="openrouter">OpenRouter</option>
                    <option value="skip">Skip for now</option>
                  </select>
                  <span className="text-xs leading-6 text-slate-400">
                    Recommended: use local runtime if it is already reachable. Use OpenRouter if you want the easiest hosted path. Skip only if you want to finish setup first and wire intelligence later.
                  </span>
                </label>

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Model override</span>
                    <Input
                      name="llm_model"
                      list={modelListId}
                      defaultValue={bootstrap.metadata.defaultLlmModel ?? ""}
                      placeholder="Leave blank to use the provider default"
                    />
                  </label>
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Preset</span>
                    <select name="llm_preset" defaultValue={bootstrap.metadata.defaultLlmPreset ?? ""} className={selectClassName}>
                      <option value="">Use provider default</option>
                      {presets.map((preset) => (
                        <option key={preset.presetId} value={preset.presetId}>
                          {preset.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="grid gap-2 md:max-w-sm">
                  <span className="text-sm font-medium text-slate-100">ASR model for voice intake</span>
                  <select name="asr_model" defaultValue={bootstrap.metadata.defaultAsrModel ?? ""} className={selectClassName}>
                    <option value="">Use runtime default</option>
                    {asrModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Embeddings route</span>
                    <select name="embedding_route" defaultValue={embeddings.provider === "none" ? "none" : "match"} className={selectClassName}>
                      <option value="match">Match the main route</option>
                      <option value="external">Force local runtime</option>
                      <option value="openrouter">Force OpenRouter</option>
                      <option value="none">Skip vectors for now</option>
                    </select>
                  </label>
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Summary style</span>
                    <select name="summary_style" defaultValue={operations.temporalSummary.strategy} className={selectClassName}>
                      <option value="deterministic">Factual only</option>
                      <option value="deterministic_plus_llm">Factual + readable LLM overlay</option>
                    </select>
                  </label>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Default watched-folder schedule</span>
                    <select name="source_monitor_default_schedule" defaultValue={operations.sourceMonitor.defaultScanSchedule} className={selectClassName}>
                      <option value="every_30_minutes">Every 30 minutes</option>
                      <option value="hourly">Hourly</option>
                      <option value="daily">Daily</option>
                    </select>
                  </label>
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Summary cadence</span>
                    <select name="temporal_summary_interval_seconds" defaultValue={String(operations.temporalSummary.workerIntervalSeconds)} className={selectClassName}>
                      <option value="300">Every 5 minutes</option>
                      <option value="1800">Every 30 minutes</option>
                      <option value="3600">Hourly</option>
                    </select>
                  </label>
                </div>

                <PendingSubmitButton
                  idleLabel="Save and continue"
                  pendingLabel="Saving intelligence settings..."
                  className="w-fit rounded-2xl bg-amber-300 text-stone-950 hover:bg-amber-200"
                />
              </form>

              <datalist id={modelListId}>
                {[...llmModels, ...openRouterLlmModels.map((model) => model.id)].map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </CardContent>
          </Card>

          <div className="grid gap-4">
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Availability</CardDescription>
                <CardTitle>What the app can see right now</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
                <p>Local runtime: <span className="font-medium text-white">{runtime?.reachable ? "reachable" : "not reachable"}</span></p>
                <p>Local LLM models: <span className="font-medium text-white">{llmModels.length}</span></p>
                <p>Local ASR models: <span className="font-medium text-white">{asrModels.length}</span></p>
                <p>OpenRouter chat models discovered: <span className="font-medium text-white">{openRouterLlmModels.length}</span></p>
              </CardContent>
            </Card>

            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Friendly advice</CardDescription>
                <CardTitle>What to pick if you just want this to work</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
                <p><span className="font-medium text-white">Local runtime</span> is the private default if it is already reachable.</p>
                <p><span className="font-medium text-white">OpenRouter</span> is the easier hosted default.</p>
                <p><span className="font-medium text-white">Skip for now</span> is fine if you only want to finish setup and come back later.</p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Link href="/help#provider-choices" target="_blank" rel="noreferrer" className="text-cyan-100 hover:text-white">
                    Read provider docs
                  </Link>
                  <span className="text-slate-500">·</span>
                  <Link href="/settings" className="text-cyan-100 hover:text-white">
                    Tune this later in Settings
                  </Link>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </OperatorShell>
  );
}
