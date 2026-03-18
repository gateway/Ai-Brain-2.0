import { ConsoleShell } from "@/components/console-shell";
import { ConsoleSection } from "@/components/console-primitives";
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
      return "border-amber-400/20 bg-amber-400/10 text-amber-100";
    case "month":
      return "border-teal-400/20 bg-teal-400/10 text-teal-100";
    case "week":
      return "border-sky-400/20 bg-sky-400/10 text-sky-100";
    case "day":
      return "border-violet-400/20 bg-violet-400/10 text-violet-100";
    case "profile":
      return "border-rose-400/20 bg-rose-400/10 text-rose-100";
    default:
      return "border-slate-500/20 bg-slate-500/10 text-slate-200";
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

  const summaryLayers = timelineView ? [...new Set(timelineView.summaries.map((summary) => summary.layer))] : [];

  return (
    <ConsoleShell
      currentPath="/console/timeline"
      title="Timeline"
      subtitle="A visual time scan through episodic evidence and temporal summaries. This is where the TMT becomes inspectable instead of abstract."
    >
      <ConsoleSection
        eyebrow="Temporal controls"
        title="Window the history before you inspect it"
        description="The timeline stays useful when you keep the time window explicit. This view favors episodic evidence first, then summary rollups, so long-horizon recall stays grounded."
        action={<span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs uppercase tracking-[0.28em] text-slate-300">tmt scan</span>}
      >
        <form method="GET" className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Namespace</span>
            <Input name="namespace" defaultValue={namespaceId} />
          </label>
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Time start</span>
            <Input name="time_start" defaultValue={timeStart} />
          </label>
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Time end</span>
            <Input name="time_end" defaultValue={timeEnd} />
          </label>
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Limit</span>
            <Input name="limit" defaultValue={limit} />
          </label>
          <div className="xl:col-span-4">
            <button
              type="submit"
              className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-2 text-sm font-medium text-cyan-100 hover:border-cyan-400/30 hover:bg-cyan-400/15"
            >
              Refresh timeline
            </button>
          </div>
        </form>
      </ConsoleSection>

      {error ? (
        <Card className="border-rose-400/20 bg-[linear-gradient(180deg,_rgba(127,29,29,0.35)_0%,_rgba(17,24,39,0.96)_100%)]">
          <CardHeader>
            <CardDescription>Timeline error</CardDescription>
            <CardTitle>Runtime request failed</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-rose-100">{error}</CardContent>
        </Card>
      ) : null}

      {timelineView ? (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Window</CardDescription>
                <CardTitle>{formatDate(timelineView.timeStart)}</CardTitle>
              </CardHeader>
            </Card>
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Window end</CardDescription>
                <CardTitle>{formatDate(timelineView.timeEnd)}</CardTitle>
              </CardHeader>
            </Card>
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Summary layers</CardDescription>
                <CardTitle>{summaryLayers.length ? summaryLayers.join(" · ") : "none"}</CardTitle>
              </CardHeader>
            </Card>
          </div>

          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Temporal summaries</CardDescription>
              <CardTitle>Rolled-up memory layers in this window</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {timelineView.summaries.map((summary) => (
                <div key={summary.temporalNodeId} className="rounded-[24px] border border-white/8 bg-white/5 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] ${layerTone(summary.layer)}`}>
                      {summary.layer}
                    </span>
                    <span className="text-xs text-slate-400">
                      {formatDate(summary.periodStart)} → {formatDate(summary.periodEnd)}
                    </span>
                    <span className="text-xs text-slate-400">sources {summary.sourceCount}</span>
                  </div>
                  <p className="mt-3 text-sm leading-7 text-slate-300">{summary.summaryText}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="relative pl-6">
            <div className="absolute left-[13px] top-2 bottom-2 w-px bg-gradient-to-b from-cyan-300 via-slate-500 to-amber-300" />
            <div className="space-y-4">
              {timelineView.timeline.map((item, index) => (
                <Card key={item.memoryId} className="relative border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
                  <span className="absolute -left-[22px] top-8 block h-3.5 w-3.5 rounded-full border-2 border-slate-950 bg-cyan-300 shadow-[0_0_0_6px_rgba(255,255,255,0.04)]" />
                  <CardHeader>
                    <CardDescription>{formatDate(item.occurredAt)}</CardDescription>
                    <CardTitle className="text-lg">Episodic evidence {index === 0 ? "• latest in window" : ""}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm leading-7 text-slate-300">{item.content}</p>
                    <div className="flex flex-wrap gap-3 text-xs text-slate-400">
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
