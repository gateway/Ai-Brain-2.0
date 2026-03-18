import { ConsoleShell } from "@/components/console-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getConsoleDefaults, getTimelineView } from "@/lib/brain-runtime";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function readParam(value: string | string[] | undefined, fallback = ""): string {
  return Array.isArray(value) ? value[0] ?? fallback : value ?? fallback;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function layerTone(layer: string): string {
  switch (layer) {
    case "year":
      return "bg-amber-100 text-amber-950 border-amber-300/60";
    case "month":
      return "bg-teal-100 text-teal-950 border-teal-300/60";
    case "week":
      return "bg-sky-100 text-sky-950 border-sky-300/60";
    case "day":
      return "bg-violet-100 text-violet-950 border-violet-300/60";
    default:
      return "bg-slate-100 text-slate-900 border-slate-300/60";
  }
}

export default async function TimelinePage({ searchParams }: { readonly searchParams: SearchParams }) {
  const params = await searchParams;
  const defaults = await getConsoleDefaults();
  const namespaceId = readParam(params.namespace, defaults.namespaceId);
  const timeStart = readParam(params.time_start, defaults.timeStart);
  const timeEnd = readParam(params.time_end, defaults.timeEnd);
  const limit = readParam(params.limit, "24");

  let timelineView;
  let error: string | undefined;

  try {
    timelineView = await getTimelineView({
      namespaceId,
      timeStart,
      timeEnd,
      limit
    });
  } catch (caughtError) {
    error = caughtError instanceof Error ? caughtError.message : String(caughtError);
  }

  return (
    <ConsoleShell
      currentPath="/console/timeline"
      title="Timeline"
      subtitle="A visual time scan through episodic evidence and temporal summaries. This is where the TMT becomes inspectable instead of abstract."
    >
      <Card className="overflow-hidden border-slate-900/10 bg-white/80">
        <CardHeader>
          <CardDescription>Time Window</CardDescription>
          <CardTitle>Timeline operator controls</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="GET" className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="space-y-2 text-sm">
              <span>Namespace</span>
              <Input name="namespace" defaultValue={namespaceId} />
            </label>
            <label className="space-y-2 text-sm">
              <span>Time start</span>
              <Input name="time_start" defaultValue={timeStart} />
            </label>
            <label className="space-y-2 text-sm">
              <span>Time end</span>
              <Input name="time_end" defaultValue={timeEnd} />
            </label>
            <label className="space-y-2 text-sm">
              <span>Limit</span>
              <Input name="limit" defaultValue={limit} />
            </label>
            <div className="xl:col-span-4">
              <button type="submit" className="rounded-2xl bg-slate-950 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
                Refresh timeline
              </button>
            </div>
          </form>
        </CardContent>
      </Card>

      {error ? (
        <Card className="border-rose-300/50 bg-rose-50/90">
          <CardHeader>
            <CardDescription>Timeline error</CardDescription>
            <CardTitle>Runtime request failed</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-rose-900">{error}</CardContent>
        </Card>
      ) : null}

      {timelineView ? (
        <>
          <Card className="border-slate-900/10 bg-[linear-gradient(180deg,_rgba(255,255,255,0.95)_0%,_rgba(247,242,234,0.92)_100%)]">
            <CardHeader>
              <CardDescription>Temporal summaries</CardDescription>
              <CardTitle>Rolled-up memory layers in this window</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {timelineView.summaries.map((summary) => (
                <div key={summary.temporalNodeId} className="rounded-[24px] border border-slate-900/10 bg-white/80 p-4 shadow-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] ${layerTone(summary.layer)}`}>
                      {summary.layer}
                    </span>
                    <span className="text-xs text-slate-500">
                      {formatDate(summary.periodStart)} → {formatDate(summary.periodEnd)}
                    </span>
                    <span className="text-xs text-slate-500">sources {summary.sourceCount}</span>
                  </div>
                  <p className="mt-3 text-sm leading-7 text-slate-700">{summary.summaryText}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="relative pl-6">
            <div className="absolute left-[13px] top-2 bottom-2 w-px bg-gradient-to-b from-amber-300 via-slate-300 to-teal-300" />
            <div className="space-y-4">
              {timelineView.timeline.map((item) => (
                <Card key={item.memoryId} className="relative border-slate-900/10 bg-white/82">
                  <span className="absolute -left-[22px] top-8 block h-3.5 w-3.5 rounded-full border-2 border-white bg-slate-950 shadow-[0_0_0_6px_rgba(255,255,255,0.55)]" />
                  <CardHeader>
                    <CardDescription>{formatDate(item.occurredAt)}</CardDescription>
                    <CardTitle className="text-lg">Episodic evidence</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm leading-7 text-slate-700">{item.content}</p>
                    <div className="flex flex-wrap gap-3 text-xs text-slate-500">
                      {item.sourceUri ? <span>source {item.sourceUri}</span> : null}
                      {item.artifactId ? <span>artifact {item.artifactId}</span> : null}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </ConsoleShell>
  );
}
