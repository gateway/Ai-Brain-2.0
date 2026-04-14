import Link from "next/link";
import { RelationshipGraph } from "@/components/relationship-graph";
import { SessionShell } from "@/components/session-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAmbiguityWorkbench, getRelationshipGraph } from "@/lib/brain-runtime";
import { getWorkbenchSession } from "@/lib/operator-workbench";

function readParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
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

export default async function SessionGraphPage({
  params,
  searchParams
}: {
  readonly params: Promise<{ readonly sessionId: string }>;
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { sessionId } = await params;
  const session = await getWorkbenchSession(sessionId);
  const query = (await searchParams) ?? {};
  const entityName = readParam(query.entity);
  const limit = readParam(query.limit) ?? "20";

  let graph;
  let error: string | undefined;
  let ambiguityWorkbench;

  try {
    [graph, ambiguityWorkbench] = await Promise.all([
      getRelationshipGraph({
        namespaceId: session.namespaceId,
        entityName,
        limit
      }),
      getAmbiguityWorkbench({
        namespaceId: session.namespaceId,
        limit: "10"
      })
    ]);
  } catch (caughtError) {
    error = caughtError instanceof Error ? caughtError.message : String(caughtError);
  }

  const selectedNode = graph?.nodes.find((node) => node.isSelected) ?? graph?.nodes[0];
  const focusEdges =
    selectedNode && graph
      ? graph.edges
          .filter((edge) => edge.subjectId === selectedNode.id || edge.objectId === selectedNode.id)
          .sort((left, right) => right.confidence - left.confidence)
          .slice(0, 5)
      : [];
  const aliasResolved =
    entityName?.trim() &&
    Boolean(graph?.selectedEntity) &&
    entityName.trim().toLowerCase() !== (graph?.selectedEntity ?? "").trim().toLowerCase();
  const graphAmbiguous = graph?.ambiguityState === "ambiguous";
  const clarificationCount = ambiguityWorkbench?.inbox.summary.total ?? 0;
  const relevantConflictCount = selectedNode
    ? (ambiguityWorkbench?.identityConflicts.filter(
        (conflict) =>
          conflict.left.name.toLowerCase() === selectedNode.name.toLowerCase() ||
          conflict.right.name.toLowerCase() === selectedNode.name.toLowerCase() ||
          conflict.left.aliases.some((alias) => alias.toLowerCase() === selectedNode.name.toLowerCase()) ||
          conflict.right.aliases.some((alias) => alias.toLowerCase() === selectedNode.name.toLowerCase())
      ).length ?? 0)
    : ambiguityWorkbench?.identityConflicts.length ?? 0;

  return (
    <SessionShell
      session={session}
      title="Session graph explorer"
      subtitle="This session now gets a real derived atlas bridge instead of a dead-end placeholder. Use it to inspect the session namespace, then jump out to the full relationships console or clarifications when alias repair, active-vs-historical state, or operator grounding still needs work."
    >
      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Session atlas</CardDescription>
            <CardTitle>{graph?.selectedEntity ? `Focused on ${graph.selectedEntity}` : "Live session relationship view"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {error ? (
              <div className="rounded-[20px] border border-rose-400/20 bg-rose-400/10 p-4 text-sm text-rose-100">{error}</div>
            ) : graph ? (
              <>
                {graphAmbiguous ? (
                  <div className="rounded-[18px] border border-amber-300/20 bg-amber-300/10 p-4 text-sm leading-7 text-amber-50">
                    <p className="font-medium text-white">
                      Session graph stopped on ambiguity for <span className="text-amber-100">{graph.requestedEntity ?? entityName}</span>.
                    </p>
                    <p className="mt-2 text-amber-100/90">
                      {graph.ambiguityReason ?? "Resolve the ambiguity before trusting this session focus node."}
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
                {aliasResolved ? (
                  <div className="rounded-[18px] border border-cyan-300/20 bg-cyan-300/10 p-4 text-sm leading-7 text-cyan-50">
                    Requested <span className="font-medium text-white">{entityName}</span>, session atlas resolved to canonical{" "}
                    <span className="font-medium text-white">{graph.selectedEntity}</span>.
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2 text-xs text-slate-400">
                  <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                    namespace {session.namespaceId}
                  </Badge>
                  <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                    nodes {graph.nodes.length}
                  </Badge>
                  <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                    edges {graph.edges.length}
                  </Badge>
                  <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                    focus {graph.selectedEntity ?? selectedNode?.name ?? "session"}
                  </Badge>
                  <Badge variant="outline" className="border-amber-300/20 bg-amber-300/10 text-amber-100">
                    clarifications {clarificationCount}
                  </Badge>
                  <Badge variant="outline" className="border-cyan-300/20 bg-cyan-300/10 text-cyan-100">
                    conflicts {relevantConflictCount}
                  </Badge>
                </div>
                <RelationshipGraph
                  graph={graph}
                  namespaceId={session.namespaceId}
                  timeStart={session.createdAt}
                  timeEnd={new Date().toISOString()}
                />
              </>
            ) : (
              <div className="rounded-[20px] border border-dashed border-white/12 bg-white/5 p-5 text-sm leading-7 text-slate-300">
                No graph payload is available for this session yet. That usually means intake or relationship derivation has not produced
                enough session-scoped edges.
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Session route bridge</CardDescription>
              <CardTitle>Use this as the fast local view</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
              <p>
                This page is now a real first-pass explorer for the session namespace. When you need the full atlas, canonical ambiguity
                review, or wider time windows, jump into the legacy relationships console or the clarification inbox.
              </p>
              <div className="space-y-2">
                <Link
                  href={`/console/relationships?namespace=${encodeURIComponent(session.namespaceId)}${selectedNode ? `&entity=${encodeURIComponent(selectedNode.name)}` : ""}`}
                  className="flex items-center justify-between rounded-[18px] border border-white/10 bg-white/5 px-4 py-3 text-white hover:bg-white/8"
                >
                  <span>Open full relationships atlas</span>
                  <span className="text-xs uppercase tracking-[0.2em] text-slate-500">atlas</span>
                </Link>
                <Link
                  href={`/sessions/${session.id}/clarifications`}
                  className="flex items-center justify-between rounded-[18px] border border-white/10 bg-white/5 px-4 py-3 text-white hover:bg-white/8"
                >
                  <span>Open session clarifications</span>
                  <span className="text-xs uppercase tracking-[0.2em] text-slate-500">clarify</span>
                </Link>
                <Link
                  href={`/sessions/${session.id}/query`}
                  className="flex items-center justify-between rounded-[18px] border border-white/10 bg-white/5 px-4 py-3 text-white hover:bg-white/8"
                >
                  <span>Ask direct session questions</span>
                  <span className="text-xs uppercase tracking-[0.2em] text-slate-500">query</span>
                </Link>
              </div>
            </CardContent>
          </Card>

          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Focused trails</CardDescription>
              <CardTitle>{selectedNode ? `${selectedNode.name} relationships` : "Select a node in the atlas"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {focusEdges.length > 0 ? (
                focusEdges.map((edge) => {
                  const counterpart = selectedNode && edge.subjectId === selectedNode.id ? edge.objectName : edge.subjectName;
                  return (
                    <div key={edge.id} className="rounded-[18px] border border-white/8 bg-white/5 p-4">
                      <p className="text-sm font-medium text-white">
                        {selectedNode?.name ?? edge.subjectName} <span className="text-amber-200">{edge.predicate}</span> {counterpart}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                        <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
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
                          {shortSourceLabel(edge.sourceUri ?? (typeof edge.metadata?.source_uri === "string" ? edge.metadata.source_uri : null))}
                        </p>
                      ) : null}
                    </div>
                  );
                })
              ) : (
                <p className="text-sm leading-7 text-slate-300">
                  Click a node in the atlas to turn this panel into a quick relationship dossier for the current session.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </SessionShell>
  );
}
