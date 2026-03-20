import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { loadModelAction, unloadModelAction } from "@/app/models/actions";
import { OperatorShell } from "@/components/operator-shell";
import { getModelRuntimeOverview } from "@/lib/model-runtime";
import { listOpenRouterModels } from "@/lib/operator-workbench";

function bannerTone(status?: string): string {
  if (status === "ok") {
    return "border-emerald-300/25 bg-emerald-300/12 text-emerald-50";
  }
  if (status === "error") {
    return "border-rose-300/25 bg-rose-300/12 text-rose-50";
  }
  return "border-white/10 bg-white/5 text-stone-200";
}

function modelTone(loaded: boolean): string {
  return loaded
    ? "border-emerald-300/25 bg-emerald-300/12 text-emerald-50"
    : "border-white/10 bg-white/5 text-stone-200";
}

function searchValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatCount(value: number | undefined): string | undefined {
  return value === undefined ? undefined : value.toLocaleString();
}

function formatSeconds(value: number | undefined): string | undefined {
  return value === undefined ? undefined : `${value.toFixed(value >= 10 ? 1 : 3)}s`;
}

function formatRate(value: number | undefined, suffix: string): string | undefined {
  return value === undefined ? undefined : `${value.toFixed(2)} ${suffix}`;
}

function summarizeFamilyMetrics(metrics: Record<string, unknown> | undefined): readonly { label: string; value: string }[] {
  if (!metrics) {
    return [];
  }

  const tokenCount =
    readNumber(metrics.total_tokens) ??
    readNumber(metrics.token_count);
  const inputTokens = readNumber(metrics.prompt_tokens);
  const outputTokens = readNumber(metrics.completion_tokens);
  const loadSeconds = readNumber(metrics.load_seconds);
  const completionSeconds = readNumber(metrics.completion_seconds);
  const embeddingSeconds = readNumber(metrics.embedding_seconds);
  const tokensPerSecond = readNumber(metrics.tokens_per_second);
  const textsPerSecond = readNumber(metrics.texts_per_second);
  const dimensions = readNumber(metrics.dimensions);
  const estimatedVram = readNumber(metrics.estimated_vram_gb);

  return [
    tokenCount !== undefined ? { label: "tokens", value: formatCount(tokenCount) ?? "0" } : undefined,
    inputTokens !== undefined ? { label: "prompt", value: formatCount(inputTokens) ?? "0" } : undefined,
    outputTokens !== undefined ? { label: "output", value: formatCount(outputTokens) ?? "0" } : undefined,
    tokensPerSecond !== undefined ? { label: "tok/s", value: formatRate(tokensPerSecond, "tok/s") ?? "" } : undefined,
    textsPerSecond !== undefined ? { label: "texts/s", value: formatRate(textsPerSecond, "texts/s") ?? "" } : undefined,
    completionSeconds !== undefined ? { label: "completion", value: formatSeconds(completionSeconds) ?? "" } : undefined,
    embeddingSeconds !== undefined ? { label: "embedding", value: formatSeconds(embeddingSeconds) ?? "" } : undefined,
    loadSeconds !== undefined ? { label: "load", value: formatSeconds(loadSeconds) ?? "" } : undefined,
    dimensions !== undefined ? { label: "dims", value: formatCount(dimensions) ?? "" } : undefined,
    estimatedVram !== undefined ? { label: "VRAM est.", value: `${estimatedVram.toFixed(1)} GB` } : undefined
  ].filter((item): item is { label: string; value: string } => Boolean(item && item.value));
}

export default async function ModelsPage({
  searchParams
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const [overview, params] = await Promise.all([getModelRuntimeOverview(), searchParams]);
  const openRouterModels = await listOpenRouterModels().catch(() => []);
  const status = searchValue(params.status);
  const message = searchValue(params.message);
  const openRouterLlmModels = openRouterModels.filter((model) => model.supportsChat).slice(0, 16);
  const openRouterEmbeddingModels = openRouterModels.filter((model) => model.supportsEmbeddings).slice(0, 16);

  return (
    <OperatorShell
      currentPath="/models"
      title="Model Lab"
      subtitle="Direct runtime inspection and operator-safe lab controls for discovery, presets, and explicit model load or unload actions."
    >
      <div className="space-y-6">
        {message ? <div className={`rounded-[22px] border px-4 py-3 text-sm ${bannerTone(status)}`}>{message}</div> : null}

        {overview.errors.length > 0 ? (
          <div className="rounded-[22px] border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-50">
            {overview.errors.map((error) => (
              <p key={error}>{error}</p>
            ))}
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard
            title="Connectivity"
            value={overview.reachable ? "reachable" : "offline"}
            detail={overview.baseUrl}
          />
          <MetricCard
            title="Provider"
            value={overview.provider ?? "unknown"}
            detail="Reported by `/v1/models`."
          />
          <MetricCard
            title="Loaded families"
            value={String(overview.loadedFamilyCount)}
            detail="Families with an active or resident runtime."
          />
          <MetricCard
            title="Presets"
            value={String(overview.presets.length)}
            detail={overview.presetsModel ?? "No preset model reported."}
          />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Runtime families</CardDescription>
              <CardTitle>Supported models and active runtime state</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {overview.families.length === 0 ? (
                <p className="text-sm text-stone-300">The runtime did not return a supported model catalog.</p>
              ) : (
                overview.families.map((family) => (
                  <div key={family.family} className="rounded-[22px] border border-white/8 bg-white/5 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-stone-200">{family.family}</p>
                        <p className="mt-1 text-xs text-stone-400">
                          {family.supportedModels.length} supported model{family.supportedModels.length === 1 ? "" : "s"}
                        </p>
                      </div>
                      <Badge variant="outline" className={modelTone(family.loaded)}>
                        {family.loaded ? "loaded" : "idle"}
                      </Badge>
                    </div>

                    <div className="mt-4 space-y-3">
                      {family.activeModel ? (
                        <div className="rounded-[18px] border border-emerald-300/18 bg-emerald-300/10 p-3 text-sm text-emerald-50">
                          <p className="font-medium">{family.activeModel}</p>
                          {family.contextLength ? <p className="mt-1 text-xs text-emerald-100/80">context length {family.contextLength.toLocaleString()}</p> : null}
                          {family.runtimeStrategy ? <p className="mt-1 text-xs text-emerald-100/80">{family.runtimeStrategy}</p> : null}
                          {summarizeFamilyMetrics(family.lastMetrics).length > 0 ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {summarizeFamilyMetrics(family.lastMetrics).map((metric) => (
                                <Badge
                                  key={`${family.family}:${metric.label}`}
                                  variant="outline"
                                  className="border-emerald-200/15 bg-black/15 text-emerald-50"
                                >
                                  {metric.label} {metric.value}
                                </Badge>
                              ))}
                            </div>
                          ) : null}
                          <form action={unloadModelAction} className="mt-3">
                            <input type="hidden" name="family" value={family.family} />
                            <input type="hidden" name="model" value={family.activeModel} />
                            <Button type="submit" variant="outline" className="border-white/10 bg-black/15 text-white hover:bg-black/25">
                              Unload active model
                            </Button>
                          </form>
                        </div>
                      ) : null}

                      <div className="space-y-2">
                        {family.supportedModels.map((model) => (
                          <form key={model} action={loadModelAction} className="grid gap-2 rounded-[18px] border border-white/8 bg-black/15 p-3 lg:grid-cols-[minmax(0,1fr)_140px_auto]">
                            <input type="hidden" name="family" value={family.family} />
                            <input type="hidden" name="model" value={model} />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-white">{model}</p>
                            </div>
                            {family.family === "llm" ? (
                              <Input
                                name="context_length"
                                type="number"
                                min="2048"
                                step="1024"
                                defaultValue={family.contextLength ?? 100000}
                                className="h-9 border-white/10 bg-white/5 text-sm text-white"
                              />
                            ) : (
                              <div className="flex items-center text-xs text-stone-400">standard load</div>
                            )}
                            <Button type="submit" className="bg-amber-300 text-stone-950 hover:bg-amber-200">
                              Load
                            </Button>
                          </form>
                        ))}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Registry summary</CardDescription>
                <CardTitle>What the runtime says it knows about</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {overview.registryFamilies.length === 0 ? (
                  <p className="text-sm text-stone-300">No registry metadata was returned.</p>
                ) : (
                  overview.registryFamilies.map((family) => (
                    <div key={family.family} className="rounded-[18px] border border-white/8 bg-white/5 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="font-medium text-white">{family.family}</p>
                        <Badge variant="outline" className="border-white/10 bg-white/5 text-stone-100">
                          {family.modelCount} models
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs text-stone-400">
                        integrated {family.integratedCount} · validated {family.validatedCount}
                      </p>
                      {family.previewModels.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {family.previewModels.map((model) => (
                            <Badge key={`${family.family}:${model}`} variant="outline" className="border-white/10 bg-black/15 text-stone-200">
                              {model}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Capability boundary</CardDescription>
                <CardTitle>Current operator truth</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm leading-7 text-stone-300">
                <p>Audio ASR, LLM classification, and embeddings are live through your local external model runtime.</p>
                <p>PDF and image upload belong in intake, but the generic OCR or vision derive adapter is still not exposed in the runtime contract.</p>
                <p>This page is a direct lab surface. Standard session ingestion should continue to flow through the AI Brain runtime boundary.</p>
                <p>OpenRouter is now an optional provider path for LLM and embedding selection, but the current primary path remains the local runtime you are operating on the other machine.</p>
                <p>Enable it server-side with <code className="rounded bg-white/8 px-1.5 py-0.5 text-xs">OPENROUTER_API_KEY</code>, then choose <code className="rounded bg-white/8 px-1.5 py-0.5 text-xs">OpenRouter</code> in session defaults or intake forms.</p>
              </CardContent>
            </Card>

            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Optional provider catalog</CardDescription>
                <CardTitle>OpenRouter discovery</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-[18px] border border-white/8 bg-white/5 px-4 py-3 text-sm leading-7 text-stone-300">
                  This is a discovery surface for optional remote models. Selection still happens in session defaults and intake overrides.
                </div>
                <div className="space-y-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-stone-400">Chat</p>
                  {openRouterLlmModels.length === 0 ? (
                    <p className="text-sm text-stone-300">No OpenRouter chat catalog available.</p>
                  ) : (
                    openRouterLlmModels.map((model) => (
                      <div key={model.id} className="rounded-[18px] border border-white/8 bg-black/15 p-3">
                        <p className="text-sm font-medium text-white">{model.id}</p>
                      </div>
                    ))
                  )}
                </div>
                <div className="space-y-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-stone-400">Embeddings</p>
                  {openRouterEmbeddingModels.length === 0 ? (
                    <p className="text-sm text-stone-300">No OpenRouter embedding catalog available.</p>
                  ) : (
                    openRouterEmbeddingModels.map((model) => (
                      <div key={model.id} className="rounded-[18px] border border-white/8 bg-black/15 p-3">
                        <p className="text-sm font-medium text-white">{model.id}</p>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Prompt presets</CardDescription>
            <CardTitle>Preset browser from `/v1/llm/presets`</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 xl:grid-cols-2">
            {overview.presets.length === 0 ? (
              <p className="text-sm text-stone-300">No LLM presets were returned by the runtime.</p>
            ) : (
              overview.presets.map((preset) => (
                <div key={preset.presetId} className="rounded-[22px] border border-white/8 bg-white/5 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-white">{preset.displayName}</p>
                      <p className="mt-1 text-xs text-stone-400">{preset.presetId}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {preset.enableThinking !== undefined ? (
                        <Badge variant="outline" className="border-white/10 bg-black/15 text-stone-100">
                          {preset.enableThinking ? "thinking" : "instruct"}
                        </Badge>
                      ) : null}
                      {preset.maxTokens ? (
                        <Badge variant="outline" className="border-white/10 bg-black/15 text-stone-100">
                          max {preset.maxTokens}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  {preset.description ? <p className="mt-3 text-sm leading-7 text-stone-300">{preset.description}</p> : null}
                  {preset.tags.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {preset.tags.map((tag) => (
                        <Badge key={`${preset.presetId}:${tag}`} variant="outline" className="border-teal-300/20 bg-teal-300/10 text-teal-100">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-4 grid gap-2 text-xs text-stone-400 sm:grid-cols-3">
                    <div>source: {preset.source ?? "unknown"}</div>
                    <div>temperature: {preset.temperature ?? "n/a"}</div>
                    <div>system prompt: {preset.systemPrompt ? "available" : "not provided"}</div>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </OperatorShell>
  );
}

function MetricCard({
  title,
  value,
  detail
}: {
  readonly title: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle>{value}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0 text-sm text-stone-400">{detail}</CardContent>
    </Card>
  );
}
