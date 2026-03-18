import { ConsoleShell } from "@/components/console-shell";
import { ConsoleSection } from "@/components/console-primitives";
import { MetricCard } from "@/components/metric-card";
import { RelationshipGraph } from "@/components/relationship-graph";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getConsoleDefaults, getRelationshipGraph } from "@/lib/brain-runtime";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function readParam(value: string | string[] | undefined, fallback = ""): string {
  return Array.isArray(value) ? value[0] ?? fallback : value ?? fallback;
}

function entityTone(entityType: string): string {
  const normalized = entityType.trim().toLowerCase();

  if (normalized.includes("person") || normalized.includes("user") || normalized.includes("human")) {
    return "border-amber-400/20 bg-amber-400/10 text-amber-100";
  }

  if (normalized.includes("place") || normalized.includes("location") || normalized.includes("geo")) {
    return "border-teal-400/20 bg-teal-400/10 text-teal-100";
  }

  if (normalized.includes("project") || normalized.includes("task") || normalized.includes("work")) {
    return "border-sky-400/20 bg-sky-400/10 text-sky-100";
  }

  return "border-slate-500/20 bg-slate-500/10 text-slate-200";
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export default async function RelationshipsPage({ searchParams }: { readonly searchParams: SearchParams }) {
  const params = await searchParams;
  const defaults = await getConsoleDefaults();
  const namespaceId = readParam(params.namespace, defaults.namespaceId);
  const entityName = readParam(params.entity);
  const timeStart = readParam(params.time_start, defaults.timeStart);
  const timeEnd = readParam(params.time_end, defaults.timeEnd);
  const limit = readParam(params.limit, "24");

  let graph;
  let error: string | undefined;

  try {
    graph = await getRelationshipGraph({
      namespaceId,
      entityName: entityName || undefined,
      timeStart,
      timeEnd,
      limit
    });
  } catch (caughtError) {
    error = caughtError instanceof Error ? caughtError.message : String(caughtError);
  }

  const selectedNode = graph?.nodes.find((node) => node.isSelected) ?? graph?.nodes[0];
  const strongestEdge = graph?.edges[0];
  const focusLabel = graph?.selectedEntity ?? selectedNode?.name ?? "Relationship atlas";
  const typeCounts = new Map<string, number>();
  const predicateCounts = new Map<string, number>();

  for (const node of graph?.nodes ?? []) {
    typeCounts.set(node.entityType || "unknown", (typeCounts.get(node.entityType || "unknown") ?? 0) + 1);
  }

  for (const edge of graph?.edges ?? []) {
    predicateCounts.set(edge.predicate, (predicateCounts.get(edge.predicate) ?? 0) + 1);
  }

  const topTypes = [...typeCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 4);
  const topPredicates = [...predicateCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 6);

  return (
    <ConsoleShell
      currentPath="/console/relationships"
      title="Relationships"
      subtitle="Inspect people, places, projects, and the edges that bind them. Start with the whole atlas, click into a root like Steve, and expand outward without losing provenance."
    >
      <ConsoleSection
        eyebrow="Relationship controls"
        title="Set the window, then move inside the graph"
        description="The query frame stays explicit, but the graph itself now does the exploratory work. Use a wide window to see the whole atlas, then narrow or re-root when the graph gets dense."
        action={<span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs uppercase tracking-[0.28em] text-slate-300">graph atlas</span>}
      >
        <form method="GET" className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Namespace</span>
            <Input name="namespace" defaultValue={namespaceId} />
          </label>
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Focus entity</span>
            <Input name="entity" defaultValue={entityName} placeholder="Sarah" />
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
          <div className="flex flex-wrap gap-2 xl:col-span-5">
            <button
              type="submit"
              className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-2 text-sm font-medium text-cyan-100 hover:border-cyan-400/30 hover:bg-cyan-400/15"
            >
              Refresh graph
            </button>
            {entityName ? (
              <a
                href={`/console/relationships?namespace=${encodeURIComponent(namespaceId)}&time_start=${encodeURIComponent(timeStart)}&time_end=${encodeURIComponent(timeEnd)}&limit=${encodeURIComponent(limit)}`}
                className="rounded-2xl border border-white/8 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 hover:border-white/12 hover:bg-white/8"
              >
                Clear focus
              </a>
            ) : null}
          </div>
        </form>
      </ConsoleSection>

      {error ? (
        <Card className="border-rose-400/20 bg-[linear-gradient(180deg,_rgba(127,29,29,0.35)_0%,_rgba(17,24,39,0.96)_100%)]">
          <CardHeader>
            <CardDescription>Relationship graph error</CardDescription>
            <CardTitle>Runtime request failed</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-rose-100">{error}</CardContent>
        </Card>
      ) : null}

      {graph ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard title="Nodes" value={graph.nodes.length} detail="Distinct entities in the current graph window." />
            <MetricCard title="Edges" value={graph.edges.length} detail="Active relationship links available for inspection." />
            <MetricCard title="Focus" value={focusLabel} detail="Current center of the graph surface." />
            <MetricCard
              title="Strongest link"
              value={strongestEdge ? formatConfidence(strongestEdge.confidence) : "n/a"}
              detail={strongestEdge ? `${strongestEdge.subjectName} → ${strongestEdge.objectName}` : "No active edges in view."}
            />
          </div>

          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Graph surface</CardDescription>
              <CardTitle>{graph.selectedEntity ? `Focused on ${graph.selectedEntity}` : "Interactive relationship graph"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2 text-xs text-slate-400">
                <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                  nodes {graph.nodes.length}
                </Badge>
                <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                  edges {graph.edges.length}
                </Badge>
                <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                  show atlas / click root / expand / reset
                </Badge>
              </div>
              <RelationshipGraph graph={graph} />
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.98)_0%,_rgba(8,11,20,0.98)_100%)] text-white shadow-[0_24px_80px_rgba(0,0,0,0.26)]">
              <CardHeader>
                <CardDescription className="text-slate-300">Atlas posture</CardDescription>
                <CardTitle className="text-white">How to work the graph</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {selectedNode ? (
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline" className={entityTone(selectedNode.entityType)}>
                      {selectedNode.entityType}
                    </Badge>
                    <Badge variant="outline" className="border-white/15 bg-white/10 text-white">
                      degree {selectedNode.degree}
                    </Badge>
                    <Badge variant="outline" className="border-white/15 bg-white/10 text-white">
                      mentions {selectedNode.mentionCount}
                    </Badge>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {topTypes.map(([type, count]) => (
                    <Badge key={type} variant="outline" className="border-white/15 bg-white/10 text-white">
                      {type} · {count}
                    </Badge>
                  ))}
                </div>
                <p className="text-sm leading-7 text-slate-300">
                  Click a node to re-root around it. Expand outward from that node, inspect the live edge set, then reset back
                  to the original root when you want the broader atlas again.
                </p>
                {strongestEdge ? (
                  <div className="rounded-[22px] border border-white/10 bg-white/5 p-4">
                    <p className="text-xs uppercase tracking-[0.26em] text-slate-400">Strongest edge</p>
                    <p className="mt-2 text-sm font-medium text-white">
                      {strongestEdge.subjectName} <span className="text-amber-200">{strongestEdge.predicate}</span>{" "}
                      {strongestEdge.objectName}
                    </p>
                    <p className="mt-2 text-xs text-slate-400">
                      confidence {formatConfidence(strongestEdge.confidence)} · valid from{" "}
                      {new Date(strongestEdge.validFrom).toLocaleString()}
                    </p>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Node roster</CardDescription>
                <CardTitle>High-signal entities</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {graph.nodes.slice(0, 8).map((node) => (
                  <a
                    key={node.id}
                    href={`/console/relationships?namespace=${encodeURIComponent(namespaceId)}&entity=${encodeURIComponent(node.name)}&time_start=${encodeURIComponent(timeStart)}&time_end=${encodeURIComponent(timeEnd)}&limit=${encodeURIComponent(limit)}`}
                    className="flex items-center justify-between gap-3 rounded-[20px] border border-white/8 bg-white/5 px-4 py-3 transition-all hover:-translate-y-0.5 hover:border-cyan-400/30 hover:bg-white/8 hover:shadow-[0_16px_40px_rgba(0,0,0,0.18)]"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-white">{node.name}</span>
                        <Badge variant="outline" className={`${entityTone(node.entityType)} text-[10px] uppercase tracking-[0.2em]`}>
                          {node.entityType}
                        </Badge>
                      </div>
                      <p className="text-xs text-slate-400">click to make this the server-side root</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 text-right text-xs text-slate-400">
                      <span>deg {node.degree}</span>
                      <span>mentions {node.mentionCount}</span>
                    </div>
                  </a>
                ))}
              </CardContent>
            </Card>

            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Predicate mix</CardDescription>
                <CardTitle>Most common relationships</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {topPredicates.length > 0 ? (
                  topPredicates.map(([predicate, count]) => (
                    <div key={predicate} className="flex items-center justify-between rounded-2xl border border-white/8 bg-white/5 px-4 py-3">
                      <span className="font-medium text-white">{predicate}</span>
                      <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                        {count}
                      </Badge>
                    </div>
                  ))
                ) : (
                  <p className="text-sm leading-6 text-slate-400">No predicates available yet for this graph window.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </ConsoleShell>
  );
}
