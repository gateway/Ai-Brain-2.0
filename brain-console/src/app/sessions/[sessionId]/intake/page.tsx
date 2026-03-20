import { SessionFileIntakePanel } from "@/components/session-file-intake-panel";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getModelRuntimeOverview } from "@/lib/model-runtime";
import { getWorkbenchSession } from "@/lib/operator-workbench";

const providerSelectClassName =
  "h-11 rounded-[18px] border border-white/12 bg-white/6 px-4 text-sm text-white outline-none ring-0";

export default async function SessionIntakePage({ params }: { readonly params: Promise<{ readonly sessionId: string }> }) {
  const { sessionId } = await params;
  const [session, modelRuntime] = await Promise.all([
    getWorkbenchSession(sessionId),
    getModelRuntimeOverview().catch(() => null)
  ]);
  const llmModels = modelRuntime?.families.find((family) => family.family === "llm")?.supportedModels ?? [];
  const asrModels = modelRuntime?.families.find((family) => family.family === "asr")?.supportedModels ?? [];
  const presets = modelRuntime?.presets ?? [];
  const llmModelOptionsId = `session-${session.id}-llm-models`;

  return (
    <div className="space-y-4">
      <Card className="border-cyan-300/18 bg-[linear-gradient(180deg,_rgba(12,28,39,0.94)_0%,_rgba(8,11,20,0.98)_100%)]">
        <CardHeader>
          <CardDescription>Operator flow</CardDescription>
          <CardTitle>Use intake in this order</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-7 text-slate-200">
          <div className="grid gap-3 lg:grid-cols-4">
            <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">1. Add evidence</p>
              <p className="mt-2">Paste text directly, or upload files and record microphone audio on the right.</p>
            </div>
            <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">2. Verify the source</p>
              <p className="mt-2">Read the text you pasted or listen to the audio preview before submitting.</p>
            </div>
            <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">3. Run classification</p>
              <p className="mt-2">Leave LLM classification enabled when you want staged entities, relationships, and claims extracted.</p>
            </div>
            <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">4. Review the output</p>
              <p className="mt-2">After intake, go to review and clarifications to inspect and correct what the brain inferred.</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-[20px] border border-white/10 bg-black/15 px-4 py-3">
            <StatusBadge status={session.status} />
            <span className="text-sm text-slate-300">Session defaults:</span>
            <span className="text-sm text-slate-400">LLM provider {session.defaultLlmProvider === "openrouter" ? "OpenRouter" : "Local runtime"}</span>
            <span className="text-sm text-slate-400">LLM model {session.defaultLlmModel ?? "runtime default"}</span>
            <span className="text-sm text-slate-400">Preset {session.defaultLlmPreset ?? "research-analyst"}</span>
            <span className="text-sm text-slate-400">ASR {session.defaultAsrModel ?? "runtime default"}</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Text intake</CardDescription>
            <CardTitle>Paste text and optionally classify it</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={`/api/operator/sessions/${session.id}/intake/text`} method="post" encType="multipart/form-data" className="grid gap-4">

              <div className="rounded-[20px] border border-white/10 bg-white/4 p-4 text-sm leading-7 text-slate-300">
                Use this path when the source is already text. If you are starting from speech, use the audio section so ASR can create the transcript first.
              </div>

              <label className="grid gap-2 md:max-w-sm">
                <span className="text-sm font-medium text-slate-100">Label</span>
                <Input name="label" placeholder="Interview notes" />
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-slate-100">Text</span>
                <Textarea
                  name="text"
                  rows={14}
                  required
                  placeholder="Paste source material here. Raw text remains durable evidence and can later be reviewed against staged candidates."
                />
              </label>

              <label className="flex items-center gap-3 rounded-[20px] border border-white/10 bg-white/6 px-4 py-3 text-sm text-slate-100">
                <input type="checkbox" name="run_classification" defaultChecked className="size-4 rounded border-white/20 bg-transparent" />
                Run LLM classification after ingest
              </label>

              <details className="group rounded-[20px] border border-white/8 bg-black/15 p-4">
                <summary className="cursor-pointer list-none">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-white">Advanced model options</p>
                      <p className="text-xs leading-6 text-slate-400">Only change these when you want to override the session defaults for this one text run.</p>
                    </div>
                    <span className="text-xs uppercase tracking-[0.2em] text-slate-400 transition group-open:text-amber-100">Expand</span>
                  </div>
                </summary>

                <div className="mt-4 grid gap-4 border-t border-white/8 pt-4 md:grid-cols-3">
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Classification provider</span>
                    <select
                      name="classification_provider"
                      defaultValue={session.defaultLlmProvider ?? "external"}
                      className={providerSelectClassName}
                    >
                      <option value="external">Local runtime</option>
                      <option value="openrouter">OpenRouter</option>
                    </select>
                  </label>

                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">LLM model override</span>
                    <Input
                      name="classification_model"
                      list={llmModelOptionsId}
                      placeholder={session.defaultLlmModel ?? "Leave blank to use the session default"}
                    />
                  </label>

                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-100">Preset</span>
                    <select name="classification_preset" defaultValue="" className={providerSelectClassName}>
                      <option value="">Use session default ({session.defaultLlmPreset ?? "research-analyst"})</option>
                      {presets.map((preset) => (
                        <option key={preset.presetId} value={preset.presetId}>
                          {preset.displayName} ({preset.presetId})
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="grid gap-2 md:max-w-sm">
                    <span className="text-sm font-medium text-slate-100">Max output tokens</span>
                    <Input name="classification_max_tokens" defaultValue="4096" placeholder="4096" />
                  </label>
                </div>
              </details>

              {llmModels.length > 0 ? (
                <datalist id={llmModelOptionsId}>
                  {llmModels.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              ) : null}

              <button type="submit" className="inline-flex w-fit rounded-2xl border border-amber-300/25 bg-amber-300/12 px-5 py-2.5 text-sm font-medium text-amber-50 hover:border-amber-300/35 hover:bg-amber-300/16">
                Ingest text
              </button>
            </form>
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Audio and file intake</CardDescription>
              <CardTitle>Record microphone notes or upload source files</CardTitle>
            </CardHeader>
            <CardContent>
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

          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Current capability boundary</CardDescription>
              <CardTitle>What happens when you submit</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
              <p><strong className="text-white">Text</strong> ingests directly as durable evidence and can go straight into classification.</p>
              <p><strong className="text-white">Audio</strong> can be uploaded or recorded in the browser. With ASR enabled, the runtime transcribes it first, then classification can run on the transcript.</p>
              <p><strong className="text-white">PDF and image</strong> currently store the raw artifact only. OCR and vision derivation are still waiting on an adapter.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
