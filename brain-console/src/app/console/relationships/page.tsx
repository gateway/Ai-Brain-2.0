import Link from "next/link";
import { ConsoleShell } from "@/components/console-shell";
import { ConsoleSection } from "@/components/console-primitives";
import { MetricCard } from "@/components/metric-card";
import { RelationshipGraph } from "@/components/relationship-graph";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getAmbiguityWorkbench, getConsoleDefaults, getRelationshipGraph } from "@/lib/brain-runtime";

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

function relationshipStatusTone(status?: string | null, validUntil?: string | null): string {
  const normalized = status?.trim().toLowerCase() ?? "";
  if (normalized === "historical" || normalized === "superseded" || Boolean(validUntil)) {
    return "border-violet-400/20 bg-violet-400/10 text-violet-100";
  }
  if (normalized === "reopened") {
    return "border-sky-400/20 bg-sky-400/10 text-sky-100";
  }
  return "border-emerald-400/20 bg-emerald-400/10 text-emerald-100";
}

function relationshipStatusLabel(status?: string | null, validUntil?: string | null): string {
  const normalized = status?.trim().toLowerCase() ?? "";
  if (normalized === "historical" || normalized === "superseded" || Boolean(validUntil)) {
    return "historical";
  }
  if (normalized === "reopened") {
    return "reopened";
  }
  return "active";
}

function shortSourceLabel(value?: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const segments = trimmed.split("/").filter(Boolean);
  return segments.slice(-2).join("/") || trimmed;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function matchesFocus(value: string, focus: string): boolean {
  const normalizedFocus = normalizeText(focus);
  const normalizedValue = normalizeText(value);

  return (
    normalizedValue === normalizedFocus ||
    normalizedValue.includes(normalizedFocus) ||
    normalizedFocus.includes(normalizedValue)
  );
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
  let ambiguityWorkbench;

  try {
    [graph, ambiguityWorkbench] = await Promise.all([
      getRelationshipGraph({
        namespaceId,
        entityName: entityName || undefined,
        timeStart,
        timeEnd,
        limit
      }),
      getAmbiguityWorkbench({
        namespaceId,
        limit: "18"
      })
    ]);
  } catch (caughtError) {
    error = caughtError instanceof Error ? caughtError.message : String(caughtError);
  }

  const selectedNode = graph?.nodes.find((node) => node.isSelected) ?? graph?.nodes[0];
  const strongestEdge = graph?.edges[0];
  const focusLabel = graph?.selectedEntity ?? selectedNode?.name ?? "Relationship atlas";
  const focusKey = selectedNode?.name ?? entityName;
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
  const focusEdges =
    selectedNode && graph
      ? graph.edges
          .filter((edge) => edge.subjectId === selectedNode.id || edge.objectId === selectedNode.id)
          .sort((left, right) => right.confidence - left.confidence)
          .slice(0, 6)
      : [];
  const connectedNodeIds = new Set(
    focusEdges.flatMap((edge) =>
      selectedNode
        ? [edge.subjectId, edge.objectId].filter((nodeId) => nodeId !== selectedNode.id)
        : []
    )
  );
  const connectedNodes =
    graph?.nodes.filter((node) => connectedNodeIds.has(node.id)).sort((left, right) => right.degree - left.degree).slice(0, 6) ?? [];
  const clarificationItems = ambiguityWorkbench?.inbox.items ?? [];
  const identityConflicts = ambiguityWorkbench?.identityConflicts ?? [];
  const relevantClarifications = focusKey
    ? clarificationItems
        .filter(
          (item) =>
            matchesFocus(item.rawText, focusKey) ||
            item.suggestedMatches.some((match) => matchesFocus(match, focusKey)) ||
            Boolean(item.sceneText && matchesFocus(item.sceneText, focusKey))
        )
        .slice(0, 4)
    : clarificationItems.slice(0, 4);
  const relevantConflicts = focusKey
    ? identityConflicts
        .filter(
          (conflict) =>
            matchesFocus(conflict.left.name, focusKey) ||
            matchesFocus(conflict.right.name, focusKey) ||
            conflict.left.aliases.some((alias) => matchesFocus(alias, focusKey)) ||
            conflict.right.aliases.some((alias) => matchesFocus(alias, focusKey))
        )
        .slice(0, 3)
    : identityConflicts.slice(0, 3);
  const clarificationTotal = ambiguityWorkbench?.inbox.summary.total ?? 0;
  const identityConflictTotal = identityConflicts.length;
  const aliasResolved =
    entityName.trim() &&
    Boolean(graph?.selectedEntity) &&
    normalizeText(entityName) !== normalizeText(graph?.selectedEntity ?? "");
  const graphAmbiguous = graph?.ambiguityState === "ambiguous";
  const activeFocusEdgeCount = focusEdges.filter((edge) => relationshipStatusLabel(edge.status, edge.validUntil) === "active").length;
  const historicalFocusEdgeCount = focusEdges.filter((edge) => relationshipStatusLabel(edge.status, edge.validUntil) === "historical").length;
  const atlasActions = [
    {
      label: "Open clarifications",
      href: `/console/inbox?namespace_id=${encodeURIComponent(namespaceId)}`,
      note: clarificationTotal ? `${clarificationTotal} open items` : "No open ambiguity items"
    },
    {
      label: "Open query console",
      href: `/console/query?namespace=${encodeURIComponent(namespaceId)}&query=${encodeURIComponent(
        selectedNode ? `Who is ${selectedNode.name} in my life?` : "Who are the important people in my life?"
      )}`,
      note: "Use exact questions when you want a direct answer instead of atlas browsing"
    },
    {
      label: "Open timeline",
      href: `/console/timeline?namespace=${encodeURIComponent(namespaceId)}&time_start=${encodeURIComponent(timeStart)}&time_end=${encodeURIComponent(timeEnd)}`,
      note: "Switch here when the graph needs a time-first view"
    }
  ];

  return (
    <ConsoleShell
      currentPath="/console/relationships"
      title="Relationships"
      subtitle="Inspect canonical people, places, projects, and the edges that bind them. This derived atlas now carries canonical alias redirects, active vs historical relationship state, validity windows, source-backed trails, and the same temporal relationship truth used by direct person queries; stop in Clarifications when an alias, place, or kinship role still looks suspicious."
    >
      <ConsoleSection
        eyebrow="Relationship controls"
        title="Set the window, then move inside the atlas"
        description="The query frame stays explicit, but the derived atlas does the exploratory work. Use a wide window to see the whole atlas, then narrow or re-root when the graph gets dense. For exact relationship lookups, typed purchase/media queries, or recap answers, use the knowledge or query surfaces; for uncertain names, aliases, kinship roles, and places, resolve the ambiguity before trusting the edge."
        action={<span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs uppercase tracking-[0.28em] text-slate-300">derived atlas</span>}
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
              Refresh atlas
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

          <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Focus dossier</CardDescription>
                <CardTitle>{selectedNode ? `${selectedNode.name} at a glance` : "Atlas root at a glance"}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {graphAmbiguous ? (
                  <div className="rounded-[20px] border border-amber-300/20 bg-amber-300/10 p-4 text-sm leading-7 text-amber-50">
                    <p className="font-medium text-white">
                      Atlas stopped on ambiguity for <span className="text-amber-100">{graph.requestedEntity ?? entityName}</span>.
                    </p>
                    <p className="mt-2 text-amber-100/90">
                      {graph.ambiguityReason ?? "This focus term still needs clarification before the atlas can trust a canonical node."}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-amber-100/90">
                      {graph.ambiguityType ? (
                        <Badge variant="outline" className="border-amber-300/25 bg-amber-300/10 text-amber-100">
                          {graph.ambiguityType.replace(/_/g, " ")}
                        </Badge>
                      ) : null}
                      {typeof graph.clarificationCount === "number" ? (
                        <Badge variant="outline" className="border-amber-300/25 bg-amber-300/10 text-amber-100">
                          {graph.clarificationCount} clarification{graph.clarificationCount === 1 ? "" : "s"}
                        </Badge>
                      ) : null}
                      {(graph.suggestedMatches ?? []).slice(0, 4).map((match) => (
                        <Badge key={match} variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                          {match}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
                {selectedNode ? (
                  <>
                    {aliasResolved ? (
                      <div className="rounded-[20px] border border-cyan-300/20 bg-cyan-300/10 p-4 text-sm leading-7 text-cyan-50">
                        Requested <span className="font-medium text-white">{entityName}</span>, atlas resolved to canonical{" "}
                        <span className="font-medium text-white">{graph?.selectedEntity}</span>. Treat that as an alias redirect, not proof that the
                        original spelling is independently canonical.
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline" className={entityTone(selectedNode.entityType)}>
                        {selectedNode.entityType}
                      </Badge>
                      <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                        degree {selectedNode.degree}
                      </Badge>
                      <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                        mentions {selectedNode.mentionCount}
                      </Badge>
                      {relevantClarifications.length > 0 ? (
                        <Badge variant="outline" className="border-amber-300/20 bg-amber-300/10 text-amber-100">
                          {relevantClarifications.length} clarification{relevantClarifications.length === 1 ? "" : "s"}
                        </Badge>
                      ) : null}
                      {relevantConflicts.length > 0 ? (
                        <Badge variant="outline" className="border-cyan-300/20 bg-cyan-300/10 text-cyan-100">
                          {relevantConflicts.length} conflict{relevantConflicts.length === 1 ? "" : "s"}
                        </Badge>
                      ) : null}
                      <Badge variant="outline" className="border-emerald-400/20 bg-emerald-400/10 text-emerald-100">
                        active {activeFocusEdgeCount}
                      </Badge>
                      <Badge variant="outline" className="border-violet-400/20 bg-violet-400/10 text-violet-100">
                        historical {historicalFocusEdgeCount}
                      </Badge>
                    </div>
                    <div className="grid gap-4 lg:grid-cols-2">
                      <div className="space-y-3 rounded-[22px] border border-white/8 bg-white/5 p-4">
                        <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Strongest relationship trails</p>
                        {focusEdges.length > 0 ? (
                          focusEdges.map((edge) => {
                            const counterpart =
                              edge.subjectId === selectedNode.id ? edge.objectName : edge.subjectName;
                            return (
                              <div key={edge.id} className="rounded-[18px] border border-white/8 bg-black/15 p-3">
                                <p className="text-sm font-medium text-white">
                                  {selectedNode.name} <span className="text-amber-200">{edge.predicate}</span> {counterpart}
                                </p>
                                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                                  <Badge variant="outline" className={relationshipStatusTone(edge.status, edge.validUntil)}>
                                    {relationshipStatusLabel(edge.status, edge.validUntil)}
                                  </Badge>
                                  {typeof edge.metadata?.tier === "string" ? (
                                    <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                                      {edge.metadata.tier}
                                    </Badge>
                                  ) : null}
                                  <span>confidence {formatConfidence(edge.confidence)}</span>
                                  <span>valid from {new Date(edge.validFrom).toLocaleDateString()}</span>
                                  {edge.validUntil ? <span>until {new Date(edge.validUntil).toLocaleDateString()}</span> : null}
                                </div>
                                {shortSourceLabel(edge.sourceUri ?? (typeof edge.metadata?.source_uri === "string" ? edge.metadata.source_uri : null)) ? (
                                  <p className="mt-2 break-all text-xs leading-5 text-slate-500">
                                    source{" "}
                                    {shortSourceLabel(
                                      edge.sourceUri ?? (typeof edge.metadata?.source_uri === "string" ? edge.metadata.source_uri : null)
                                    )}
                                  </p>
                                ) : null}
                              </div>
                            );
                          })
                        ) : (
                          <p className="text-sm leading-6 text-slate-400">No focused edges yet for this entity.</p>
                        )}
                      </div>
                      <div className="space-y-3 rounded-[22px] border border-white/8 bg-white/5 p-4">
                        <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Connected entities</p>
                        {connectedNodes.length > 0 ? (
                          connectedNodes.map((node) => (
                            <a
                              key={node.id}
                              href={`/console/relationships?namespace=${encodeURIComponent(namespaceId)}&entity=${encodeURIComponent(node.name)}&time_start=${encodeURIComponent(timeStart)}&time_end=${encodeURIComponent(timeEnd)}&limit=${encodeURIComponent(limit)}`}
                              className="flex items-center justify-between gap-3 rounded-[18px] border border-white/8 bg-black/15 px-3 py-2 hover:border-cyan-400/25 hover:bg-black/25"
                            >
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-white">{node.name}</p>
                                <p className="text-xs text-slate-400">{node.entityType}</p>
                              </div>
                              <div className="text-right text-xs text-slate-400">
                                <div>deg {node.degree}</div>
                                <div>mentions {node.mentionCount}</div>
                              </div>
                            </a>
                          ))
                        ) : (
                          <p className="text-sm leading-6 text-slate-400">Focus an entity to see its nearest neighborhood.</p>
                        )}
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="text-sm leading-7 text-slate-300">
                    Start with a person, place, or project to turn the atlas into a tighter relationship dossier. This view is best when you
                    know the entity you want and need the surrounding edges, ambiguity pressure, and nearby nodes in one place.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>Atlas hygiene</CardDescription>
                <CardTitle>Clarifications and conflicts</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {graphAmbiguous ? (
                  <Link
                    href={`/console/inbox?namespace_id=${encodeURIComponent(namespaceId)}`}
                    className="block rounded-[20px] border border-amber-300/20 bg-amber-300/10 p-4 hover:border-amber-300/30 hover:bg-amber-300/12"
                  >
                    <p className="text-sm font-medium text-white">
                      Clarification needed for {(graph.requestedEntity ?? entityName) || "the current focus"}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-amber-100/90">
                      {graph.ambiguityReason ?? "Resolve the ambiguity before trusting this focus node in the atlas."}
                    </p>
                  </Link>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-[18px] border border-white/8 bg-white/5 p-4">
                    <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Open clarifications</p>
                    <p className="mt-2 text-2xl font-semibold text-white">{clarificationTotal}</p>
                    <p className="mt-1 text-sm text-slate-400">
                      {focusKey
                        ? "Items relevant to this focus are listed below."
                        : "Ambiguous names and places still waiting for operator grounding before canonical rebuilds can fully clean the atlas."}
                    </p>
                  </div>
                  <div className="rounded-[18px] border border-white/8 bg-white/5 p-4">
                    <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Identity conflicts</p>
                    <p className="mt-2 text-2xl font-semibold text-white">{identityConflictTotal}</p>
                    <p className="mt-1 text-sm text-slate-400">
                      Potential merges or keep-separate decisions still affecting canonical redirects, edge cleanup, and atlas trust.
                    </p>
                  </div>
                </div>

                {relevantClarifications.length > 0 ? (
                  <div className="space-y-3">
                    <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Relevant clarifications</p>
                    {relevantClarifications.map((item) => (
                      <Link
                        key={item.candidateId}
                        href={`/console/inbox?namespace_id=${encodeURIComponent(namespaceId)}`}
                        className="block rounded-[18px] border border-amber-300/15 bg-amber-300/8 p-4 hover:border-amber-300/25 hover:bg-amber-300/10"
                      >
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="outline" className="border-amber-300/20 bg-amber-300/10 text-amber-100">
                            {item.ambiguityType.replace(/_/g, " ")}
                          </Badge>
                          <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                            {item.targetRole}
                          </Badge>
                        </div>
                        <p className="mt-3 text-sm font-medium text-white">{item.rawText}</p>
                        {item.ambiguityReason ? <p className="mt-1 text-sm leading-6 text-slate-300">{item.ambiguityReason}</p> : null}
                      </Link>
                    ))}
                  </div>
                ) : null}

                {relevantConflicts.length > 0 ? (
                  <div className="space-y-3">
                    <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Identity conflict watchlist</p>
                    {relevantConflicts.map((conflict) => (
                      <Link
                        key={`${conflict.left.entityId}:${conflict.right.entityId}`}
                        href={`/console/inbox?namespace_id=${encodeURIComponent(namespaceId)}`}
                        className="block rounded-[18px] border border-cyan-300/15 bg-cyan-300/8 p-4 hover:border-cyan-300/25 hover:bg-cyan-300/10"
                      >
                        <p className="text-sm font-medium text-white">
                          {conflict.left.name} ↔ {conflict.right.name}
                        </p>
                        <p className="mt-1 text-sm leading-6 text-slate-300">
                          canonical suggestion {conflict.suggestedCanonicalName} · confidence {formatConfidence(conflict.confidence)}
                        </p>
                      </Link>
                    ))}
                  </div>
                ) : null}

                <div className="space-y-2">
                  {atlasActions.map((action) => (
                    <Link
                      key={action.href}
                      href={action.href}
                      className="flex items-center justify-between gap-3 rounded-[18px] border border-white/8 bg-white/5 px-4 py-3 hover:border-white/12 hover:bg-white/8"
                    >
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-white">{action.label}</p>
                        <p className="text-xs leading-5 text-slate-400">{action.note}</p>
                      </div>
                      <span className="text-xs uppercase tracking-[0.2em] text-slate-500">open</span>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(13,18,31,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
            <CardDescription>Atlas surface</CardDescription>
            <CardTitle>{graph.selectedEntity ? `Focused on ${graph.selectedEntity}` : "Interactive relationship atlas"}</CardTitle>
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
                <CardTitle className="text-white">How to work the derived atlas</CardTitle>
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
                  to the original root when you want the broader atlas again. If a name, alias, kinship role, or place looks ambiguous, stop in Clarifications
                  before treating the edge as authoritative; resolved clarifications feed rebuilds that clean the atlas on the next pass.
                </p>
                {strongestEdge ? (
                  <div className="rounded-[22px] border border-white/10 bg-white/5 p-4">
                    <p className="text-xs uppercase tracking-[0.26em] text-slate-400">Strongest edge</p>
                    <p className="mt-2 text-sm font-medium text-white">
                      {strongestEdge.subjectName} <span className="text-amber-200">{strongestEdge.predicate}</span>{" "}
                      {strongestEdge.objectName}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <Badge variant="outline" className={relationshipStatusTone(strongestEdge.status, strongestEdge.validUntil)}>
                        {relationshipStatusLabel(strongestEdge.status, strongestEdge.validUntil)}
                      </Badge>
                      <span>confidence {formatConfidence(strongestEdge.confidence)}</span>
                      <span>valid from {new Date(strongestEdge.validFrom).toLocaleString()}</span>
                      {strongestEdge.validUntil ? <span>until {new Date(strongestEdge.validUntil).toLocaleString()}</span> : null}
                    </div>
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
