import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getWorkbenchSessionTimeline } from "@/lib/operator-workbench";

function formatDateTime(value: string): string {
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
    default:
      return "border-slate-500/20 bg-slate-500/10 text-slate-200";
  }
}

function formatMetadataList(value: unknown): string | null {
  return Array.isArray(value) && value.length > 0 ? value.filter((item): item is string => typeof item === "string").join(" · ") : null;
}

export default async function SessionTimelinePage({ params }: { readonly params: Promise<{ readonly sessionId: string }> }) {
  const { sessionId } = await params;
  const timeline = await getWorkbenchSessionTimeline(sessionId);

  return (
    <div className="space-y-4">
      <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
        <CardHeader>
          <CardDescription>Session window</CardDescription>
          <CardTitle>Evidence and summaries tied to this intake session</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3 text-sm leading-7 text-slate-300">
          <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
            <p className="text-[10px] uppercase tracking-[0.22em] text-slate-400">Start</p>
            <p className="mt-2 font-medium text-white">{formatDateTime(timeline.timeStart)}</p>
          </div>
          <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
            <p className="text-[10px] uppercase tracking-[0.22em] text-slate-400">End</p>
            <p className="mt-2 font-medium text-white">{formatDateTime(timeline.timeEnd)}</p>
          </div>
          <div className="rounded-[20px] border border-white/8 bg-white/5 p-4">
            <p className="text-[10px] uppercase tracking-[0.22em] text-slate-400">Timeline rows</p>
            <p className="mt-2 font-medium text-white">{timeline.timeline.length}</p>
          </div>
        </CardContent>
      </Card>

      <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
        <CardHeader>
          <CardDescription>Temporal summaries</CardDescription>
          <CardTitle>Rollups overlapping this session</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {timeline.summaries.length === 0 ? (
            <p className="text-sm leading-7 text-slate-300">No temporal summaries overlap this session yet.</p>
          ) : (
            timeline.summaries.map((summary) => (
              <div key={summary.temporalNodeId} className="rounded-[24px] border border-white/8 bg-white/5 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] ${layerTone(summary.layer)}`}>
                    {summary.layer}
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-slate-200">
                    {summary.generatedBy.replace(/_/g, " ")}
                  </span>
                  <span className="text-xs text-slate-400">
                    {formatDateTime(summary.periodStart)} → {formatDateTime(summary.periodEnd)}
                  </span>
                  <span className="text-xs text-slate-400">sources {summary.sourceCount}</span>
                </div>
                <p className="mt-3 text-sm leading-7 text-slate-300">{summary.summaryText}</p>
                {summary.metadata.semantic_summary_provider || summary.metadata.semantic_summary_model || summary.metadata.semantic_summary_recurring_themes ? (
                  <div className="mt-3 space-y-2 rounded-[18px] border border-white/8 bg-white/5 p-3 text-xs leading-6 text-slate-300">
                    <p>
                      Semantic layer:
                      {" "}
                      <span className="font-medium text-white">
                        {String(summary.metadata.semantic_summary_provider ?? "unknown")}
                        {summary.metadata.semantic_summary_model ? ` / ${String(summary.metadata.semantic_summary_model)}` : ""}
                      </span>
                    </p>
                    {formatMetadataList(summary.metadata.semantic_summary_recurring_themes) ? (
                      <p>Recurring themes: <span className="font-medium text-white">{formatMetadataList(summary.metadata.semantic_summary_recurring_themes)}</span></p>
                    ) : null}
                    {formatMetadataList(summary.metadata.semantic_summary_uncertainties) ? (
                      <p>Uncertainties: <span className="font-medium text-white">{formatMetadataList(summary.metadata.semantic_summary_uncertainties)}</span></p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="relative pl-6">
        <div className="absolute left-[13px] top-2 bottom-2 w-px bg-gradient-to-b from-cyan-300 via-slate-500 to-amber-300" />
        <div className="space-y-4">
          {timeline.timeline.length === 0 ? (
            <Card className="relative border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardContent className="p-5 text-sm leading-7 text-slate-300">No episodic rows have been linked to this session yet.</CardContent>
            </Card>
          ) : (
            timeline.timeline.map((item, index) => (
              <Card key={item.memoryId} className="relative border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
                <span className="absolute -left-[22px] top-8 block h-3.5 w-3.5 rounded-full border-2 border-slate-950 bg-cyan-300 shadow-[0_0_0_6px_rgba(255,255,255,0.04)]" />
                <CardHeader>
                  <CardDescription>{formatDateTime(item.occurredAt)}</CardDescription>
                  <CardTitle className="text-lg">Session evidence {index === 0 ? "• earliest in session" : ""}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm leading-7 text-slate-300">{item.content}</p>
                  <div className="flex flex-wrap gap-3 text-xs text-slate-400">
                    {item.sourceUri ? <span>source {item.sourceUri}</span> : null}
                    {item.artifactId ? <span>artifact {item.artifactId}</span> : null}
                    {typeof item.metadata.role === "string" ? <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">{item.metadata.role}</Badge> : null}
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
