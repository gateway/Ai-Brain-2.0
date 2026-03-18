import Link from "next/link";
import { ConsoleShell } from "@/components/console-shell";
import { StatusBadge } from "@/components/metric-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getConsoleDefaults, getRuntimeBaseUrl, searchBrain, type SearchResult } from "@/lib/brain-runtime";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function readParam(value: string | string[] | undefined, fallback = ""): string {
  return Array.isArray(value) ? value[0] ?? fallback : value ?? fallback;
}

export default async function QueryPage({ searchParams }: { readonly searchParams: SearchParams }) {
  const params = await searchParams;
  const defaults = await getConsoleDefaults();
  const namespaceId = readParam(params.namespace, defaults.namespaceId);
  const query = readParam(params.q);
  const timeStart = readParam(params.time_start);
  const timeEnd = readParam(params.time_end);
  const provider = readParam(params.provider);
  const model = readParam(params.model);
  const dimensions = readParam(params.dimensions);
  const limit = readParam(params.limit, "5");

  let result: SearchResult | undefined;
  let error: string | undefined;

  if (query) {
    try {
      result = await searchBrain({
        namespaceId,
        query,
        timeStart: timeStart || undefined,
        timeEnd: timeEnd || undefined,
        provider: provider || undefined,
        model: model || undefined,
        dimensions: dimensions || undefined,
        limit: limit || undefined
      });
    } catch (caughtError) {
      error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    }
  }

  return (
    <ConsoleShell
      currentPath="/console/query"
      title="Query Runner"
      subtitle="Run retrieval against the live local runtime and inspect planner, lexical mode, fallback, provenance, and temporal hints."
    >
      <Card>
        <CardHeader>
          <CardDescription>Search Form</CardDescription>
          <CardTitle>Server-rendered retrieval</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="GET" className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="space-y-2 text-sm">
              <span>Namespace</span>
              <Input name="namespace" defaultValue={namespaceId} />
            </label>
            <label className="space-y-2 text-sm xl:col-span-2">
              <span>Query</span>
              <Input name="q" defaultValue={query} placeholder="What was I doing in Japan in 2025?" />
            </label>
            <label className="space-y-2 text-sm">
              <span>Limit</span>
              <Input name="limit" defaultValue={limit} />
            </label>
            <label className="space-y-2 text-sm">
              <span>Time start</span>
              <Input name="time_start" defaultValue={timeStart} placeholder="2025-01-01T00:00:00Z" />
            </label>
            <label className="space-y-2 text-sm">
              <span>Time end</span>
              <Input name="time_end" defaultValue={timeEnd} placeholder="2025-12-31T23:59:59Z" />
            </label>
            <label className="space-y-2 text-sm">
              <span>Embedding provider</span>
              <Input name="provider" defaultValue={provider} placeholder="openrouter | gemini | external" />
            </label>
            <label className="space-y-2 text-sm">
              <span>Model</span>
              <Input name="model" defaultValue={model} placeholder="text-embedding-3-small" />
            </label>
            <label className="space-y-2 text-sm">
              <span>Dimensions</span>
              <Input name="dimensions" defaultValue={dimensions} placeholder="1536" />
            </label>
            <div className="md:col-span-2 xl:col-span-4">
              <button
                type="submit"
                className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
              >
                Run query
              </button>
            </div>
          </form>
        </CardContent>
      </Card>

      {error ? (
        <Card className="border-rose-300/50 bg-rose-50/80">
          <CardHeader>
            <CardDescription>Runtime issue</CardDescription>
            <CardTitle>Search request failed</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-rose-900">
            <p>{error}</p>
            <p>Runtime base URL: {getRuntimeBaseUrl()}</p>
          </CardContent>
        </Card>
      ) : null}

      {result ? (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardDescription>Planner</CardDescription>
                <CardTitle>Query interpretation</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm leading-6 text-slate-700">
                <div className="flex flex-wrap gap-2">
                  <StatusBadge value={result.lexicalProvider ?? "unknown"} />
                  <StatusBadge value={result.lexicalFallbackUsed ? "fallback used" : "no fallback"} />
                  {result.planner?.intent ? <StatusBadge value={result.planner.intent} /> : null}
                  {result.planner?.temporalGateTriggered ? <StatusBadge value="temporal support used" /> : null}
                </div>
                <p>Branch preference: {result.planner?.branchPreference ?? "not reported"}</p>
                <p>
                  Temporal window: {result.planner?.timeStart ?? "unset"} → {result.planner?.timeEnd ?? "unset"}
                </p>
                <p>Lexical terms: {result.planner?.lexicalTerms?.join(", ") || "none"}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardDescription>Results</CardDescription>
                <CardTitle>{result.results.length} hits</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm leading-6 text-slate-700">
                <p>Provider: {result.provider ?? "lexical-only"}</p>
                <p>Result mix should make token burn visible before the prompt window gets bloated.</p>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            {result.results.map((item) => (
              <Card key={`${item.memoryType}-${item.id}`}>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <CardDescription>{item.memoryType}</CardDescription>
                      <CardTitle className="text-lg">{item.occurredAt ?? "Undated memory"}</CardTitle>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {item.score !== undefined ? <StatusBadge value={`score ${item.score.toFixed(4)}`} /> : null}
                      {item.lexicalProvider ? <StatusBadge value={item.lexicalProvider} /> : null}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm leading-6 text-slate-700">{item.content}</p>
                  <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
                    {item.sourceUri ? <span>source: {item.sourceUri}</span> : null}
                    {item.sourceUri?.startsWith("artifact://") ? (
                      <Link href={`/console/artifacts/${item.sourceUri.replace("artifact://", "")}`} className="text-slate-900 underline">
                        open artifact
                      </Link>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      ) : null}
    </ConsoleShell>
  );
}
