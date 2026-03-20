import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getWorkbenchSession } from "@/lib/operator-workbench";

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatInteger(value: number | undefined): string | undefined {
  return value === undefined ? undefined : value.toLocaleString();
}

function formatDecimal(value: number | undefined, suffix: string): string | undefined {
  return value === undefined ? undefined : `${value.toFixed(2)} ${suffix}`;
}

function formatSeconds(value: number | undefined): string | undefined {
  return value === undefined ? undefined : `${value.toFixed(value >= 10 ? 1 : 3)}s`;
}

function summarizeRunMetrics(metrics: Record<string, unknown>): readonly { label: string; value: string }[] {
  const tokenUsage =
    metrics.token_usage && typeof metrics.token_usage === "object" && !Array.isArray(metrics.token_usage)
      ? (metrics.token_usage as Record<string, unknown>)
      : undefined;
  const providerMetadata =
    metrics.provider_metadata && typeof metrics.provider_metadata === "object" && !Array.isArray(metrics.provider_metadata)
      ? (metrics.provider_metadata as Record<string, unknown>)
      : undefined;
  const providerMetrics =
    providerMetadata?.metrics && typeof providerMetadata.metrics === "object" && !Array.isArray(providerMetadata.metrics)
      ? (providerMetadata.metrics as Record<string, unknown>)
      : undefined;

  return [
    readNumber(tokenUsage?.totalTokens ?? tokenUsage?.total_tokens) !== undefined
      ? { label: "tokens", value: formatInteger(readNumber(tokenUsage?.totalTokens ?? tokenUsage?.total_tokens)) ?? "" }
      : undefined,
    readNumber(tokenUsage?.inputTokens ?? tokenUsage?.input_tokens) !== undefined
      ? { label: "prompt", value: formatInteger(readNumber(tokenUsage?.inputTokens ?? tokenUsage?.input_tokens)) ?? "" }
      : undefined,
    readNumber(tokenUsage?.outputTokens ?? tokenUsage?.output_tokens) !== undefined
      ? { label: "output", value: formatInteger(readNumber(tokenUsage?.outputTokens ?? tokenUsage?.output_tokens)) ?? "" }
      : undefined,
    readNumber(providerMetrics?.tokens_per_second) !== undefined
      ? { label: "tok/s", value: formatDecimal(readNumber(providerMetrics?.tokens_per_second), "tok/s") ?? "" }
      : undefined,
    readNumber(providerMetrics?.prompt_tokens_per_second) !== undefined
      ? { label: "prompt tok/s", value: formatDecimal(readNumber(providerMetrics?.prompt_tokens_per_second), "tok/s") ?? "" }
      : undefined,
    readNumber(providerMetrics?.completion_tokens_per_second) !== undefined
      ? { label: "output tok/s", value: formatDecimal(readNumber(providerMetrics?.completion_tokens_per_second), "tok/s") ?? "" }
      : undefined,
    readNumber(providerMetrics?.texts_per_second) !== undefined
      ? { label: "texts/s", value: formatDecimal(readNumber(providerMetrics?.texts_per_second), "texts/s") ?? "" }
      : undefined,
    readNumber(providerMetrics?.completion_seconds) !== undefined
      ? { label: "completion", value: formatSeconds(readNumber(providerMetrics?.completion_seconds)) ?? "" }
      : undefined,
    readNumber(providerMetrics?.embedding_seconds) !== undefined
      ? { label: "embedding", value: formatSeconds(readNumber(providerMetrics?.embedding_seconds)) ?? "" }
      : undefined,
    readNumber(metrics.latency_ms) !== undefined
      ? { label: "latency", value: formatSeconds(readNumber(metrics.latency_ms)! / 1000) ?? "" }
      : undefined
  ].filter((item): item is { label: string; value: string } => Boolean(item && item.value));
}

export default async function SessionOverviewPage({ params }: { readonly params: Promise<{ readonly sessionId: string }> }) {
  const { sessionId } = await params;
  const session = await getWorkbenchSession(sessionId);

  return (
    <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
      <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
        <CardHeader>
          <CardDescription>Recent inputs</CardDescription>
          <CardTitle>What entered this session</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {(session.recentInputs ?? []).length === 0 ? (
            <p className="text-sm leading-7 text-slate-300">No intake has been submitted yet.</p>
          ) : (
            session.recentInputs!.map((input) => (
              <div key={input.id} className="rounded-[22px] border border-white/8 bg-white/5 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-white">{input.label || input.fileName || input.inputType}</p>
                    <p className="mt-1 text-xs uppercase tracking-[0.2em] text-slate-400">{input.inputType}</p>
                  </div>
                  <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                    {input.status.replace(/_/g, " ")}
                  </Badge>
                </div>
                {input.rawText ? <p className="mt-3 line-clamp-4 text-sm leading-7 text-slate-300">{input.rawText}</p> : null}
                <p className="mt-3 text-xs text-slate-400">{new Date(input.createdAt).toLocaleString()}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4">
        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Artifacts</CardDescription>
            <CardTitle>Raw evidence and derived outputs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(session.artifacts ?? []).length === 0 ? (
              <p className="text-sm leading-7 text-slate-300">Artifacts will appear here after intake.</p>
            ) : (
              session.artifacts!.map((artifact) => (
                <div key={`${artifact.artifactId}-${artifact.role}`} className="rounded-[22px] border border-white/8 bg-white/5 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-white">{artifact.role.replace(/_/g, " ")}</p>
                      <p className="mt-1 text-xs uppercase tracking-[0.2em] text-slate-400">{artifact.sourceType}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                        {artifact.status}
                      </Badge>
                      {artifact.deriveStatus ? (
                        <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                          {artifact.deriveStatus}
                        </Badge>
                      ) : null}
                      {artifact.classifyStatus ? (
                        <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                          {artifact.classifyStatus}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <p className="mt-3 break-all text-xs leading-6 text-slate-400">{artifact.uri}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Model runs</CardDescription>
            <CardTitle>Recent ASR and LLM activity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(session.recentRuns ?? []).length === 0 ? (
              <p className="text-sm leading-7 text-slate-300">No model runs have been recorded for this session yet.</p>
            ) : (
              session.recentRuns!.map((run) => (
                <div key={run.id} className="rounded-[22px] border border-white/8 bg-white/5 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-white">{run.family}</p>
                      <p className="mt-1 text-xs uppercase tracking-[0.2em] text-slate-400">{run.model || run.endpoint}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {run.providerId ? (
                        <Badge variant="outline" className="border-white/10 bg-black/15 text-slate-100">
                          {run.providerId}
                        </Badge>
                      ) : null}
                      <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                        {run.status}
                      </Badge>
                    </div>
                  </div>
                  {run.presetId ? <p className="mt-3 text-xs text-slate-400">preset {run.presetId}</p> : null}
                  {summarizeRunMetrics(run.metrics).length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {summarizeRunMetrics(run.metrics).map((metric) => (
                        <Badge key={`${run.id}:${metric.label}`} variant="outline" className="border-white/10 bg-black/15 text-slate-100">
                          {metric.label} {metric.value}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {run.errorText ? <p className="mt-3 text-xs text-rose-200">{run.errorText}</p> : null}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
