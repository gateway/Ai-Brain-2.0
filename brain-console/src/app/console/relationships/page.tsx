import { ConsoleShell } from "@/components/console-shell";
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
    return "border-amber-300/70 bg-amber-100 text-amber-950";
  }

  if (normalized.includes("place") || normalized.includes("location") || normalized.includes("geo")) {
    return "border-teal-300/70 bg-teal-100 text-teal-950";
  }

  if (normalized.includes("project") || normalized.includes("task") || normalized.includes("work")) {
    return "border-sky-300/70 bg-sky-100 text-sky-950";
  }

  if (normalized.includes("artifact") || normalized.includes("document") || normalized.includes("file")) {
    return "border-violet-300/70 bg-violet-100 text-violet-950";
  }

  return "border-slate-300/70 bg-slate-100 text-slate-900";
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

  const queryBase = new URLSearchParams({
    namespace: namespaceId,
    time_start: timeStart,
    time_end: timeEnd,
    limit
  });

  const selectedNode = graph?.nodes.find((node) => node.isSelected) ?? graph?.nodes[0];
  const topNode = graph?.nodes[0];
  const strongestEdge = graph?.edges[0];
  const focusLabel = graph?.selectedEntity ?? selectedNode?.name ?? topNode?.name ?? "Top graph";
  const entityCount = graph?.nodes.length ?? 0;
  const edgeCount = graph?.edges.length ?? 0;
  const typeCounts = new Map<string, number>();
  const predicateCounts = new Map<string, number>();

  for (const node of graph?.nodes ?? []) {
    const key = node.entityType || "unknown";
    typeCounts.set(key, (typeCounts.get(key) ?? 0) + 1);
  }

  for (const edge of graph?.edges ?? []) {
    predicateCounts.set(edge.predicate, (predicateCounts.get(edge.predicate) ?? 0) + 1);
  }

  const topTypes = [...typeCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4);
  const topPredicates = [...predicateCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3);

  return (
    <ConsoleShell
      currentPath="/console/relationships"
      title="Relationships"
      subtitle="Inspect people, places, projects, and the edges that bind them. This is relationship memory rendered as a navigable graph instead of a flat list."
    >
      <Card className="border-slate-900/10 bg-[linear-gradient(180deg,_rgba(255,255,255,0.96)_0%,_rgba(249,244,235,0.92)_100%)]">
        <CardHeader>
          <CardDescription>Relationship graph controls</CardDescription>
          <CardTitle>Graph window and entity focus</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="GET" className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <label className="space-y-2 text-sm">
              <span>Namespace</span>
              <Input name="namespace" defaultValue={namespaceId} />
            </label>
            <label className="space-y-2 text-sm">
              <span>Focus entity</span>
              <Input name="entity" defaultValue={entityName} placeholder="Sarah" />
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
            <div className="xl:col-span-5 flex flex-wrap gap-2">
              <button
                type="submit"
                className="rounded-2xl bg-slate-950 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
              >
                Refresh graph
              </button>
              {entityName ? (
                <a
                  href={`/console/relationships?namespace=${encodeURIComponent(namespaceId)}&time_start=${encodeURIComponent(timeStart)}&time_end=${encodeURIComponent(timeEnd)}&limit=${encodeURIComponent(limit)}`}
                  className="rounded-2xl border border-slate-900/10 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
                >
                  Clear focus
                </a>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      {graph ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard title="Nodes" value={entityCount} detail="Distinct entities in the current graph window." />
          <MetricCard title="Edges" value={edgeCount} detail="Active relationship links available for inspection." />
          <MetricCard title="Focus" value={focusLabel} detail="Current center of the graph surface." />
          <MetricCard
            title="Strongest link"
            value={strongestEdge ? formatConfidence(strongestEdge.confidence) : "n/a"}
            detail={strongestEdge ? `${strongestEdge.subjectName} → ${strongestEdge.objectName}` : "No active edges in view."}
          />
        </div>
      ) : null}

      {error ? (
        <Card className="border-rose-300/50 bg-rose-50/90">
          <CardHeader>
            <CardDescription>Relationship graph error</CardDescription>
            <CardTitle>Runtime request failed</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-rose-900">{error}</CardContent>
        </Card>
      ) : null}

      {graph ? (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.85fr)]">
            <Card className="border-slate-900/10 bg-[linear-gradient(180deg,_rgba(255,255,255,0.94)_0%,_rgba(247,242,234,0.96)_100%)]">
              <CardHeader>
                <CardDescription>Graph surface</CardDescription>
                <CardTitle>{graph.selectedEntity ? `Focused on ${graph.selectedEntity}` : "Top relationship graph"}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2 text-xs text-slate-600">
                  <Badge variant="outline">nodes {graph.nodes.length}</Badge>
                  <Badge variant="outline">edges {graph.edges.length}</Badge>
                  <Badge variant="outline">click a node to refocus</Badge>
                  {topNode ? <Badge variant="outline">hub {topNode.name}</Badge> : null}
                </div>
                <RelationshipGraph graph={graph} basePath="/console/relationships" baseQuery={queryBase} />
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card className="border-slate-900/10 bg-[linear-gradient(180deg,_rgba(15,23,42,0.98)_0%,_rgba(24,37,58,0.96)_100%)] text-white shadow-[0_24px_80px_rgba(27,31,44,0.26)]">
                <CardHeader>
                  <CardDescription className="text-slate-300">Focus entity</CardDescription>
                  <CardTitle className="text-white">{selectedNode?.name ?? focusLabel}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <Badge
                      variant="outline"
                      className={selectedNode ? entityTone(selectedNode.entityType) : "border-white/15 bg-white/10 text-white"}
                    >
                      {selectedNode?.entityType ?? "entity"}
                    </Badge>
                    <Badge variant="outline" className="border-white/15 bg-white/10 text-white">
                      degree {selectedNode?.degree ?? 0}
                    </Badge>
                    <Badge variant="outline" className="border-white/15 bg-white/10 text-white">
                      mentions {selectedNode?.mentionCount ?? 0}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {topTypes.map(([type, count]) => (
                      <Badge key={type} variant="outline" className="border-white/15 bg-white/10 text-white">
                        {type} · {count}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-sm leading-7 text-slate-300">
                    The graph centers on the selected entity, then expands around its strongest relationships. Click another
                    node to re-root the view.
                  </p>
                  {strongestEdge ? (
                    <div className="rounded-[22px] border border-white/10 bg-white/6 p-4">
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

              <Card className="border-slate-900/10 bg-white/85">
                <CardHeader>
                  <CardDescription>Node roster</CardDescription>
                  <CardTitle>High-signal entities</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {graph.nodes.slice(0, 8).map((node) => (
                    <a
                      key={node.id}
                      href={`/console/relationships?namespace=${encodeURIComponent(namespaceId)}&entity=${encodeURIComponent(node.name)}&time_start=${encodeURIComponent(timeStart)}&time_end=${encodeURIComponent(timeEnd)}&limit=${encodeURIComponent(limit)}`}
                      className="flex items-center justify-between gap-3 rounded-[20px] border border-slate-900/10 bg-white px-4 py-3 transition-all hover:-translate-y-0.5 hover:border-slate-900/20 hover:shadow-[0_16px_40px_rgba(15,23,42,0.08)]"
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-slate-950">{node.name}</span>
                          <Badge variant="outline" className={`${entityTone(node.entityType)} text-[10px] uppercase tracking-[0.2em]`}>
                            {node.entityType}
                          </Badge>
                        </div>
                        <p className="text-xs text-slate-500">click to re-center the graph around this node</p>
                      </div>
                      <div className="flex flex-col items-end gap-1 text-right text-xs text-slate-500">
                        <span>deg {node.degree}</span>
                        <span>mentions {node.mentionCount}</span>
                      </div>
                    </a>
                  ))}
                </CardContent>
              </Card>

              <Card className="border-slate-900/10 bg-[linear-gradient(180deg,_rgba(255,255,255,0.96)_0%,_rgba(248,244,237,0.92)_100%)]">
                <CardHeader>
                  <CardDescription>Predicate mix</CardDescription>
                  <CardTitle>Most common relationships</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {topPredicates.length > 0 ? (
                    topPredicates.map(([predicate, count]) => (
                      <div key={predicate} className="flex items-center justify-between rounded-2xl border border-slate-900/10 bg-white px-4 py-3">
                        <span className="font-medium text-slate-950">{predicate}</span>
                        <Badge variant="outline">{count}</Badge>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm leading-6 text-slate-500">No predicates available yet for this graph window.</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          <Card className="border-slate-900/10 bg-[linear-gradient(180deg,_rgba(255,255,255,0.96)_0%,_rgba(248,244,237,0.92)_100%)]">
            <CardHeader>
              <CardDescription>Relationship ledger</CardDescription>
              <CardTitle>Active edges in this view</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {graph.edges.map((edge) => (
                <div key={edge.id} className="rounded-[22px] border border-slate-900/10 bg-white/85 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={`/console/relationships?namespace=${encodeURIComponent(namespaceId)}&entity=${encodeURIComponent(edge.subjectName)}&time_start=${encodeURIComponent(timeStart)}&time_end=${encodeURIComponent(timeEnd)}&limit=${encodeURIComponent(limit)}`}
                      className="font-semibold text-slate-950 underline decoration-slate-300 underline-offset-4 transition hover:text-slate-700"
                    >
                      {edge.subjectName}
                    </a>
                    <span className="rounded-full border border-amber-300/60 bg-amber-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-950">
                      {edge.predicate}
                    </span>
                    <a
                      href={`/console/relationships?namespace=${encodeURIComponent(namespaceId)}&entity=${encodeURIComponent(edge.objectName)}&time_start=${encodeURIComponent(timeStart)}&time_end=${encodeURIComponent(timeEnd)}&limit=${encodeURIComponent(limit)}`}
                      className="font-semibold text-slate-950 underline decoration-slate-300 underline-offset-4 transition hover:text-slate-700"
                    >
                      {edge.objectName}
                    </a>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
                    <span>confidence {edge.confidence.toFixed(2)}</span>
                    <span>from {new Date(edge.validFrom).toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      ) : null}
    </ConsoleShell>
  );
}
