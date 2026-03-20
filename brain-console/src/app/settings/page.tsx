import Link from "next/link";
import {
  processOutboxNowAction,
  processSourceMonitorNowAction,
  runTemporalSummariesNowAction,
  saveSystemOperationsSettingsAction,
  rebuildNamespaceEmbeddingsAction,
  saveEmbeddingSettingsAction,
  saveOpenRouterDefaultsAction,
  testEmbeddingSettingsAction
} from "@/app/bootstrap/actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { SetupStepGuide } from "@/components/setup-step-guide";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { OperatorShell } from "@/components/operator-shell";
import {
  getBootstrapState,
  listWorkbenchSources,
  listOpenRouterModels,
  resolveBootstrapEmbeddingSettings,
  resolveWorkbenchOperationsSettings
} from "@/lib/operator-workbench";

function searchValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

export default async function SettingsPage({
  searchParams
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const params = await searchParams;
  const [bootstrap, openRouterModels, sources] = await Promise.all([
    getBootstrapState(),
    listOpenRouterModels().catch(() => []),
    listWorkbenchSources().catch(() => [])
  ]);
  const llmModels = openRouterModels.filter((model) => model.supportsChat).slice(0, 12);
  const embeddingModels = openRouterModels.filter((model) => model.supportsEmbeddings).slice(0, 16);
  const openRouterConfigured = openRouterModels.length > 0;
  const saved = searchValue(params.saved);
  const testStatus = searchValue(params.test);
  const reembedStatus = searchValue(params.reembed);
  const monitorStatus = searchValue(params.monitor);
  const outboxStatus = searchValue(params.outbox);
  const temporalStatus = searchValue(params.temporal);
  const defaultNamespaceId = bootstrap.metadata.defaultNamespaceId ?? "personal";
  const embeddingSettings = resolveBootstrapEmbeddingSettings(bootstrap.metadata);
  const operationsSettings = resolveWorkbenchOperationsSettings(bootstrap.metadata);
  const monitoredSources = sources.filter((source) => source.monitorEnabled);

  return (
    <OperatorShell
      currentPath="/settings"
      title="Settings"
      subtitle="Control embedding routing, verify the active provider path, and re-embed a namespace when the model changes."
    >
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="xl:col-span-2">
          <SetupStepGuide
            step="Provider Setup"
            title="Connect the brain to the model provider you want to use"
            statusLabel={embeddingSettings.provider}
            whatToDo="Choose whether embeddings should use your local runtime, OpenRouter, Gemini, or no embeddings at all. Then test that path and rebuild vectors if the provider or model changed."
            whyItMatters="Even if the rest of setup is complete, retrieval will not behave the way you expect unless the provider path is connected and the namespace vectors match that choice."
            nextHref="/bootstrap/verify"
            nextLabel="Back to verification"
          />
        </div>
        {saved === "embedding-settings" ? (
          <div className="xl:col-span-2 rounded-[22px] border border-emerald-300/25 bg-emerald-300/12 px-4 py-3 text-sm text-emerald-50">
            Embedding settings saved.
          </div>
        ) : null}
        {saved === "operations-settings" ? (
          <div className="xl:col-span-2 rounded-[22px] border border-emerald-300/25 bg-emerald-300/12 px-4 py-3 text-sm text-emerald-50">
            Operations settings saved.
          </div>
        ) : null}
        {saved === "openrouter-defaults" ? (
          <div className="xl:col-span-2 rounded-[22px] border border-emerald-300/25 bg-emerald-300/12 px-4 py-3 text-sm text-emerald-50">
            OpenRouter defaults saved in bootstrap settings.
          </div>
        ) : null}
        {monitorStatus ? (
          <div
            className={`xl:col-span-2 rounded-[22px] px-4 py-3 text-sm ${
              monitorStatus === "success"
                ? "border border-cyan-300/25 bg-cyan-300/12 text-cyan-50"
                : "border border-rose-300/25 bg-rose-300/10 text-rose-100"
            }`}
          >
            {monitorStatus === "success"
              ? <>Source monitor run checked <span className="font-medium text-white">{searchValue(params.monitor_due) ?? "0"}</span> due sources and processed <span className="font-medium text-white">{searchValue(params.monitor_processed) ?? "0"}</span>.</>
              : <>Source monitor run failed. {searchValue(params.monitor_reason) ? <>reason <span className="font-medium text-white">{searchValue(params.monitor_reason)}</span></> : null}</>}
          </div>
        ) : null}
        {outboxStatus ? (
          <div
            className={`xl:col-span-2 rounded-[22px] px-4 py-3 text-sm ${
              outboxStatus === "success"
                ? "border border-cyan-300/25 bg-cyan-300/12 text-cyan-50"
                : "border border-rose-300/25 bg-rose-300/10 text-rose-100"
            }`}
          >
            {outboxStatus === "success"
              ? <>Outbox worker scanned <span className="font-medium text-white">{searchValue(params.outbox_scanned) ?? "0"}</span>, processed <span className="font-medium text-white">{searchValue(params.outbox_processed) ?? "0"}</span>, failed <span className="font-medium text-white">{searchValue(params.outbox_failed) ?? "0"}</span>.</>
              : <>Outbox worker failed. {searchValue(params.outbox_reason) ? <>reason <span className="font-medium text-white">{searchValue(params.outbox_reason)}</span></> : null}</>}
          </div>
        ) : null}
        {temporalStatus ? (
          <div
            className={`xl:col-span-2 rounded-[22px] px-4 py-3 text-sm ${
              temporalStatus === "success"
                ? "border border-cyan-300/25 bg-cyan-300/12 text-cyan-50"
                : "border border-rose-300/25 bg-rose-300/10 text-rose-100"
            }`}
          >
            {temporalStatus === "success"
              ? <>Temporal summary run rebuilt <span className="font-medium text-white">{searchValue(params.temporal_layers) ?? "0"}</span> layers and upserted <span className="font-medium text-white">{searchValue(params.temporal_upserted) ?? "0"}</span> nodes.</>
              : <>Temporal summary run failed. {searchValue(params.temporal_reason) ? <>reason <span className="font-medium text-white">{searchValue(params.temporal_reason)}</span></> : null}</>}
          </div>
        ) : null}
        {testStatus ? (
          <div
            className={`xl:col-span-2 rounded-[22px] px-4 py-3 text-sm ${
              testStatus === "success"
                ? "border border-emerald-300/25 bg-emerald-300/12 text-emerald-50"
                : "border border-rose-300/25 bg-rose-300/10 text-rose-100"
            }`}
          >
            Embedding test {testStatus === "success" ? "succeeded" : "failed"}.
            {" "}provider <span className="font-medium text-white">{searchValue(params.test_provider) ?? "unknown"}</span>
            {searchValue(params.test_model) ? (
              <>
                {" "}model <span className="font-medium text-white">{searchValue(params.test_model)}</span>
              </>
            ) : null}
            {searchValue(params.test_dimensions) ? (
              <>
                {" "}dimensions <span className="font-medium text-white">{searchValue(params.test_dimensions)}</span>
              </>
            ) : null}
            {searchValue(params.test_latency) ? (
              <>
                {" "}latency <span className="font-medium text-white">{searchValue(params.test_latency)}ms</span>
              </>
            ) : null}
            {searchValue(params.test_mode) ? (
              <>
                {" "}mode <span className="font-medium text-white">{searchValue(params.test_mode)}</span>
              </>
            ) : null}
            {searchValue(params.test_reason) ? (
              <>
                {" "}reason <span className="font-medium text-white">{searchValue(params.test_reason)}</span>
              </>
            ) : null}
          </div>
        ) : null}
        {reembedStatus ? (
          <div
            className={`xl:col-span-2 rounded-[22px] px-4 py-3 text-sm ${
              reembedStatus === "queued"
                ? "border border-cyan-300/25 bg-cyan-300/12 text-cyan-50"
                : "border border-rose-300/25 bg-rose-300/10 text-rose-100"
            }`}
          >
            {reembedStatus === "queued" ? (
              <>
                Re-embed queued for <span className="font-medium text-white">{searchValue(params.reembed_namespace) ?? defaultNamespaceId}</span>
                {" "}with <span className="font-medium text-white">{searchValue(params.reembed_provider)}</span>
                {searchValue(params.reembed_model) ? (
                  <>
                    {" "}model <span className="font-medium text-white">{searchValue(params.reembed_model)}</span>
                  </>
                ) : null}
                . semantic queued <span className="font-medium text-white">{searchValue(params.reembed_semantic) ?? "0"}</span>,
                {" "}derivations queued <span className="font-medium text-white">{searchValue(params.reembed_derivations) ?? "0"}</span>.
              </>
            ) : (
              <>
                Re-embed failed.
                {searchValue(params.reembed_reason) ? (
                  <>
                    {" "}reason <span className="font-medium text-white">{searchValue(params.reembed_reason)}</span>
                  </>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Provider routing</CardDescription>
            <CardTitle>Current operator defaults</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
            <p>Purpose mode: <span className="font-medium text-white">{bootstrap.metadata.brainPurposeMode ?? "not set"}</span></p>
            <p>Default namespace: <span className="font-medium text-white">{defaultNamespaceId}</span></p>
            <p>Saved embeddings mode: <span className="font-medium text-white">{embeddingSettings.provider}</span></p>
            <p>Saved embeddings model: <span className="font-medium text-white">{embeddingSettings.model ?? "provider default"}</span></p>
            <p>Monitored folders: <span className="font-medium text-white">{monitoredSources.length}</span></p>
            <p>Source monitor worker: <span className="font-medium text-white">{operationsSettings.sourceMonitor.enabled ? "enabled" : "disabled"}</span></p>
            <p>Set provider to <span className="font-medium text-white">none</span> if you want deliberate lexical-only retrieval.</p>
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Setup guide</CardDescription>
            <CardTitle>What each provider option means</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
            <p><span className="font-medium text-white">none</span> disables embeddings and keeps retrieval lexical-only.</p>
            <p><span className="font-medium text-white">external</span> means your own local or private model runtime endpoint. The backend reads that connection from environment config, so another operator can point the system at their own runtime URL instead of yours.</p>
            <p><span className="font-medium text-white">openrouter</span> uses your OpenRouter API key and the discovered remote model catalog.</p>
            <p><span className="font-medium text-white">gemini</span> is available for future provider routing if Gemini is configured.</p>
            <p>Recommended setup today: use <span className="font-medium text-white">external</span> for local runtime testing, or use <span className="font-medium text-white">openrouter + text-embedding-3-small</span> if you want a fully working 1536-dimension re-embed path right now.</p>
            <div className="pt-2">
              <Link
                href="/help"
                className="inline-flex min-h-10 items-center rounded-2xl border border-white/10 bg-white/6 px-4 py-2 text-sm text-white hover:bg-white/10"
              >
                Open setup help
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>OpenRouter</CardDescription>
            <CardTitle>Provider path status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
            <p>Status: <span className="font-medium text-white">{openRouterConfigured ? "configured" : "not configured"}</span></p>
            <p>Discovered chat models: <span className="font-medium text-white">{llmModels.length}</span></p>
            <p>Discovered embedding models: <span className="font-medium text-white">{embeddingModels.length}</span></p>
            <p>Local runtime and OpenRouter can both be used for embeddings. The saved provider below becomes the default path for query and re-embed actions in the console.</p>
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] xl:col-span-2">
          <CardHeader>
            <CardDescription>Embeddings</CardDescription>
            <CardTitle>Provider selection and verification</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <form action={saveEmbeddingSettingsAction} className="grid gap-4 lg:grid-cols-2">
              <input type="hidden" name="namespace_id" value={defaultNamespaceId} />
              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-100">Provider</span>
                <select
                  name="embedding_provider"
                  defaultValue={embeddingSettings.provider}
                  className="h-11 rounded-2xl border border-white/10 bg-white/5 px-3 text-sm text-white outline-none transition focus:border-cyan-300/50"
                >
                  <option value="none">none</option>
                  <option value="external">external (local runtime)</option>
                  <option value="openrouter">openrouter</option>
                  <option value="gemini">gemini</option>
                </select>
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-100">Model</span>
                <Input
                  name="embedding_model"
                  list="openrouter-embedding-options"
                  defaultValue={embeddingSettings.model ?? ""}
                  placeholder="Qwen/Qwen3-Embedding-4B"
                />
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-100">Dimensions</span>
                <Input
                  name="embedding_dimensions"
                  defaultValue={embeddingSettings.dimensions ? String(embeddingSettings.dimensions) : ""}
                  placeholder="2560"
                />
              </label>
              <label className="flex items-center gap-3 rounded-[18px] border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200">
                <input
                  type="checkbox"
                  name="embedding_normalize"
                  defaultChecked={embeddingSettings.normalize ?? false}
                  className="h-4 w-4 rounded border-white/20 bg-transparent"
                />
                Normalize vectors if the provider supports it
              </label>
              <label className="grid gap-2 lg:col-span-2">
                <span className="text-sm font-medium text-slate-100">Instruction (optional)</span>
                <Input
                  name="embedding_instruction"
                  defaultValue={embeddingSettings.instruction ?? ""}
                  placeholder="query retrieval for personal memory recall"
                />
              </label>
              <div className="lg:col-span-2">
                <PendingSubmitButton
                  idleLabel="Save embedding settings"
                  pendingLabel="Saving settings..."
                  className="rounded-2xl bg-cyan-300 text-slate-950 hover:bg-cyan-200"
                />
              </div>
              <datalist id="openrouter-embedding-options">
                {embeddingModels.map((model) => (
                  <option key={model.id} value={model.id} />
                ))}
                <option value="Qwen/Qwen3-Embedding-4B" />
              </datalist>
            </form>

            <div className="grid gap-4 xl:grid-cols-2">
              <form action={testEmbeddingSettingsAction} className="space-y-4 rounded-[20px] border border-white/10 bg-white/5 p-4">
                <CardDescription>Test embeddings</CardDescription>
                <input type="hidden" name="embedding_provider" value={embeddingSettings.provider} />
                <input type="hidden" name="embedding_model" value={embeddingSettings.model ?? ""} />
                <input type="hidden" name="embedding_dimensions" value={embeddingSettings.dimensions ? String(embeddingSettings.dimensions) : ""} />
                <input type="hidden" name="embedding_instruction" value={embeddingSettings.instruction ?? ""} />
                <input type="hidden" name="embedding_normalize" value={embeddingSettings.normalize ? "on" : ""} />
                <label className="grid gap-2">
                  <span className="text-sm font-medium text-slate-100">Sample text</span>
                  <Input
                    name="embedding_test_text"
                    defaultValue="Steve lives in Chiang Mai and works on Two-Way."
                    placeholder="Enter sample text to verify the embedding path"
                  />
                </label>
                <PendingSubmitButton
                  idleLabel="Test embeddings"
                  pendingLabel="Testing embeddings..."
                  className="rounded-2xl border border-white/10 bg-white/5 text-white hover:bg-white/10"
                />
              </form>

              <form action={rebuildNamespaceEmbeddingsAction} className="space-y-4 rounded-[20px] border border-white/10 bg-white/5 p-4">
                <CardDescription>Rebuild namespace vectors</CardDescription>
                <input type="hidden" name="embedding_provider" value={embeddingSettings.provider} />
                <input type="hidden" name="embedding_model" value={embeddingSettings.model ?? ""} />
                <input type="hidden" name="embedding_dimensions" value={embeddingSettings.dimensions ? String(embeddingSettings.dimensions) : ""} />
                <input type="hidden" name="embedding_instruction" value={embeddingSettings.instruction ?? ""} />
                <input type="hidden" name="embedding_normalize" value={embeddingSettings.normalize ? "on" : ""} />
                <label className="grid gap-2">
                  <span className="text-sm font-medium text-slate-100">Namespace</span>
                  <Input name="namespace_id" defaultValue={defaultNamespaceId} />
                </label>
                <p className="text-sm leading-6 text-slate-300">
                  Use this after changing provider, model, or dimensionality so the vector-sync queue re-embeds semantic memory and artifact derivations for the namespace.
                </p>
                <PendingSubmitButton
                  idleLabel="Rebuild namespace vectors"
                  pendingLabel="Queueing re-embed..."
                  className="rounded-2xl border border-cyan-300/30 bg-cyan-300/10 text-cyan-50 hover:bg-cyan-300/15"
                />
              </form>
            </div>
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] xl:col-span-2">
          <CardHeader>
            <CardDescription>System operations</CardDescription>
            <CardTitle>Workers, schedules, and summarizer routing</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <form action={saveSystemOperationsSettingsAction} className="grid gap-4 lg:grid-cols-2">
              <div className="lg:col-span-2 grid gap-3 rounded-[20px] border border-white/10 bg-white/5 p-4">
                <div>
                  <p className="text-sm font-medium text-slate-100">Source monitor worker</p>
                  <p className="text-sm leading-6 text-slate-300">Controls how often the runtime checks monitored folders for changed markdown and text files.</p>
                </div>
                <label className="flex items-center gap-3 rounded-[18px] border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200">
                  <input type="checkbox" name="source_monitor_enabled" defaultChecked={operationsSettings.sourceMonitor.enabled} className="h-4 w-4 rounded border-white/20 bg-transparent" />
                  Enable source monitor worker in local app scripts
                </label>
                <div className="grid gap-4 lg:grid-cols-3">
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Worker interval seconds</span>
                    <Input name="source_monitor_interval_seconds" defaultValue={String(operationsSettings.sourceMonitor.workerIntervalSeconds)} />
                  </label>
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Default folder scan schedule</span>
                    <select name="source_monitor_default_schedule" defaultValue={operationsSettings.sourceMonitor.defaultScanSchedule} className="h-11 rounded-2xl border border-white/10 bg-white/5 px-3 text-sm text-white outline-none transition focus:border-cyan-300/50">
                      <option value="disabled">disabled</option>
                      <option value="every_5_minutes">every 5 minutes</option>
                      <option value="every_15_minutes">every 15 minutes</option>
                      <option value="every_30_minutes">every 30 minutes</option>
                      <option value="hourly">hourly</option>
                      <option value="daily">daily</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-3 rounded-[18px] border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200">
                    <input type="checkbox" name="source_monitor_auto_import" defaultChecked={operationsSettings.sourceMonitor.autoImportOnScan} className="h-4 w-4 rounded border-white/20 bg-transparent" />
                    Import changed files after scan
                  </label>
                </div>
              </div>

              <div className="lg:col-span-2 grid gap-3 rounded-[20px] border border-white/10 bg-white/5 p-4">
                <div>
                  <p className="text-sm font-medium text-slate-100">Inbox and propagation worker</p>
                  <p className="text-sm leading-6 text-slate-300">This governs how often clarification and merge events should be processed and pushed through rebuild logic.</p>
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Worker interval seconds</span>
                    <Input name="outbox_interval_seconds" defaultValue={String(operationsSettings.outbox.workerIntervalSeconds)} />
                  </label>
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Batch limit</span>
                    <Input name="outbox_batch_limit" defaultValue={String(operationsSettings.outbox.batchLimit)} />
                  </label>
                </div>
              </div>

              <div className="lg:col-span-2 grid gap-3 rounded-[20px] border border-white/10 bg-white/5 p-4">
                <div>
                  <p className="text-sm font-medium text-slate-100">Temporal summaries and summarizer routing</p>
                  <p className="text-sm leading-6 text-slate-300">The active implementation is the deterministic temporal scaffold. The provider/model fields below are for the next semantic-summary layer so operators can choose local, OpenRouter, or Gemini when that pass is enabled.</p>
                </div>
                <label className="flex items-center gap-3 rounded-[18px] border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200">
                  <input type="checkbox" name="temporal_summary_enabled" defaultChecked={operationsSettings.temporalSummary.enabled} className="h-4 w-4 rounded border-white/20 bg-transparent" />
                  Enable temporal summary worker
                </label>
                <div className="grid gap-4 lg:grid-cols-2">
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Worker interval seconds</span>
                    <Input name="temporal_summary_interval_seconds" defaultValue={String(operationsSettings.temporalSummary.workerIntervalSeconds)} />
                  </label>
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Lookback days</span>
                    <Input name="temporal_summary_lookback_days" defaultValue={String(operationsSettings.temporalSummary.lookbackDays)} />
                  </label>
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Strategy</span>
                    <select name="temporal_summary_strategy" defaultValue={operationsSettings.temporalSummary.strategy} className="h-11 rounded-2xl border border-white/10 bg-white/5 px-3 text-sm text-white outline-none transition focus:border-cyan-300/50">
                      <option value="deterministic">deterministic only</option>
                      <option value="deterministic_plus_llm">deterministic + small LLM summary</option>
                    </select>
                  </label>
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Summarizer provider</span>
                    <select name="temporal_summary_provider" defaultValue={operationsSettings.temporalSummary.summarizerProvider} className="h-11 rounded-2xl border border-white/10 bg-white/5 px-3 text-sm text-white outline-none transition focus:border-cyan-300/50">
                      <option value="external">external (local runtime)</option>
                      <option value="openrouter">openrouter</option>
                      <option value="gemini">gemini</option>
                    </select>
                  </label>
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Summarizer model</span>
                    <Input name="temporal_summary_model" defaultValue={operationsSettings.temporalSummary.summarizerModel ?? ""} placeholder="unsloth/Qwen3.5-35B-A3B-GGUF" />
                  </label>
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Summarizer preset</span>
                    <Input name="temporal_summary_preset" defaultValue={operationsSettings.temporalSummary.summarizerPreset ?? ""} placeholder="research-analyst" />
                  </label>
                </div>
                <label className="grid gap-2">
                  <span className="text-sm font-medium text-slate-100">Summarizer system prompt</span>
                  <textarea
                    name="temporal_summary_system_prompt"
                    defaultValue={operationsSettings.temporalSummary.systemPrompt ?? ""}
                    className="min-h-36 rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-white outline-none transition focus:border-cyan-300/50"
                  />
                </label>
              </div>

              <div className="lg:col-span-2">
                <PendingSubmitButton idleLabel="Save system operations settings" pendingLabel="Saving operations settings..." className="rounded-2xl bg-cyan-300 text-slate-950 hover:bg-cyan-200" />
              </div>
            </form>

            <div className="grid gap-4 xl:grid-cols-3">
              <form action={processSourceMonitorNowAction} className="space-y-4 rounded-[20px] border border-white/10 bg-white/5 p-4">
                <CardDescription>Run monitor now</CardDescription>
                <p className="text-sm leading-6 text-slate-300">Scan due monitored folders immediately and optionally import changed files.</p>
                <label className="flex items-center gap-3 rounded-[18px] border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200">
                  <input type="checkbox" name="scan_only" className="h-4 w-4 rounded border-white/20 bg-transparent" />
                  Scan only, do not import
                </label>
                <PendingSubmitButton idleLabel="Run source monitor" pendingLabel="Running source monitor..." className="rounded-2xl border border-white/10 bg-white/5 text-white hover:bg-white/10" />
              </form>

              <form action={processOutboxNowAction} className="space-y-4 rounded-[20px] border border-white/10 bg-white/5 p-4">
                <CardDescription>Process inbox changes</CardDescription>
                <input type="hidden" name="namespace_id" value={defaultNamespaceId} />
                <label className="grid gap-2">
                  <span className="text-sm font-medium text-slate-100">Batch limit</span>
                  <Input name="outbox_batch_limit" defaultValue={String(operationsSettings.outbox.batchLimit)} />
                </label>
                <p className="text-sm leading-6 text-slate-300">Use this after clarification or merge work if you want to force propagation immediately.</p>
                <PendingSubmitButton idleLabel="Run inbox propagation" pendingLabel="Processing inbox..." className="rounded-2xl border border-white/10 bg-white/5 text-white hover:bg-white/10" />
              </form>

              <form action={runTemporalSummariesNowAction} className="space-y-4 rounded-[20px] border border-white/10 bg-white/5 p-4">
                <CardDescription>Generate temporal summaries now</CardDescription>
                <input type="hidden" name="namespace_id" value={defaultNamespaceId} />
                <label className="grid gap-2">
                  <span className="text-sm font-medium text-slate-100">Lookback days</span>
                  <Input name="temporal_summary_lookback_days" defaultValue={String(operationsSettings.temporalSummary.lookbackDays)} />
                </label>
                <p className="text-sm leading-6 text-slate-300">This currently runs the deterministic day, week, month, and year scaffold over the namespace.</p>
                <PendingSubmitButton idleLabel="Run temporal summaries" pendingLabel="Generating summaries..." className="rounded-2xl border border-white/10 bg-white/5 text-white hover:bg-white/10" />
              </form>
            </div>
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] xl:col-span-2">
          <CardHeader>
            <CardDescription>Preferred OpenRouter defaults</CardDescription>
            <CardTitle>Persist remote model choices</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={saveOpenRouterDefaultsAction} className="grid gap-4 lg:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-100">Preferred LLM model</span>
                <Input
                  name="openrouter_llm_model"
                  list="openrouter-llm-options"
                  defaultValue={typeof bootstrap.metadata.preferredOpenRouterLlmModel === "string" ? bootstrap.metadata.preferredOpenRouterLlmModel : ""}
                  placeholder="openai/gpt-4.1-mini"
                />
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-100">Preferred OpenRouter embedding model</span>
                <Input
                  name="openrouter_embedding_model"
                  list="openrouter-embedding-options-pref"
                  defaultValue={typeof bootstrap.metadata.preferredOpenRouterEmbeddingModel === "string" ? bootstrap.metadata.preferredOpenRouterEmbeddingModel : ""}
                  placeholder="text-embedding-3-small"
                />
              </label>
              <div className="lg:col-span-2">
                <PendingSubmitButton
                  idleLabel="Save OpenRouter defaults"
                  pendingLabel="Saving defaults..."
                  className="rounded-2xl bg-cyan-300 text-slate-950 hover:bg-cyan-200"
                />
              </div>
              <datalist id="openrouter-llm-options">
                {llmModels.map((model) => (
                  <option key={model.id} value={model.id} />
                ))}
              </datalist>
              <datalist id="openrouter-embedding-options-pref">
                {embeddingModels.map((model) => (
                  <option key={model.id} value={model.id} />
                ))}
              </datalist>
            </form>
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Suggested embedding models</CardDescription>
            <CardTitle>OpenRouter embedding catalog</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
            {embeddingModels.length === 0 ? (
              <p>No OpenRouter embedding models were discovered.</p>
            ) : (
              embeddingModels.map((model) => (
                <div key={model.id} className="rounded-[18px] border border-white/8 bg-white/5 p-3">
                  <p className="font-medium text-white">{model.id}</p>
                  {model.contextLength ? <p className="mt-1 text-xs text-slate-400">context {model.contextLength.toLocaleString()}</p> : null}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Trusted sources</CardDescription>
            <CardTitle>Bootstrap import manager</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
            <p>OpenClaw and local markdown or text folders are managed through the bootstrap source manager. Source records carry intent metadata so the substrate can distinguish owner bootstrap, ongoing monitors, archives, and project lanes.</p>
            <div>
              <Link
                href="/bootstrap/import"
                className="inline-flex items-center rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white hover:bg-white/10"
              >
                Open source manager
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </OperatorShell>
  );
}
