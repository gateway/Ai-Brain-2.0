import { ConsoleShell } from "@/components/console-shell";
import { StatusBadge } from "@/components/metric-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getAmbiguityWorkbench, getConsoleDefaults } from "@/lib/brain-runtime";

function ambiguityLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function defaultEntityType(ambiguityType: string): string {
  if (ambiguityType === "vague_place" || ambiguityType === "place_grounding") {
    return "place";
  }

  return "person";
}

function laneLabel(namespaceId: string): string {
  if (namespaceId === "personal") {
    return "personal";
  }

  if (namespaceId.startsWith("project:")) {
    return namespaceId.replace(/^project:/, "project ");
  }

  return namespaceId;
}

export default async function ConsoleInboxPage({
  searchParams
}: {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const defaults = await getConsoleDefaults();
  const namespaceId =
    typeof params.namespace_id === "string" && params.namespace_id.trim() ? params.namespace_id : defaults.namespaceId;
  const workbench = await getAmbiguityWorkbench({
    namespaceId,
    limit: "40"
  });
  const inbox = workbench.inbox;
  const identityConflicts = workbench.identityConflicts;
  const identityHistory = workbench.identityHistory;

  return (
    <ConsoleShell
      currentPath="/console/inbox"
      title="Clarification Inbox"
      subtitle="Resolve misspellings, undefined kinship roles, vague places, and alias collisions without touching the raw evidence layer."
    >
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="border-white/10 bg-white/5 text-white">
          <CardHeader className="pb-2">
            <CardDescription>Namespace</CardDescription>
            <CardTitle className="text-lg text-white">{namespaceId}</CardTitle>
          </CardHeader>
          <CardContent>
            <StatusBadge value={`${inbox.summary.total} pending`} />
          </CardContent>
        </Card>
        {Object.entries(inbox.summary.byType)
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, 3)
          .map(([type, total]) => (
            <Card key={type} className="border-white/10 bg-white/5 text-white">
              <CardHeader className="pb-2">
                <CardDescription>Ambiguity Type</CardDescription>
                <CardTitle className="text-lg text-white">{ambiguityLabel(type)}</CardTitle>
              </CardHeader>
              <CardContent>
                <StatusBadge value={`${total}`} />
              </CardContent>
            </Card>
          ))}
        <Card className="border-white/10 bg-white/5 text-white">
          <CardHeader className="pb-2">
            <CardDescription>Identity conflicts</CardDescription>
            <CardTitle className="text-lg text-white">Possible merges</CardTitle>
          </CardHeader>
          <CardContent>
            <StatusBadge value={`${identityConflicts.length} detected`} />
          </CardContent>
        </Card>
      </div>

      <Card className="border-white/10 bg-white/5 text-white">
        <CardHeader>
          <CardDescription>Review queue</CardDescription>
          <CardTitle>Manual clarification keeps the graph honest</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {inbox.items.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-white/12 bg-white/5 p-8 text-sm text-slate-200">
              No unresolved ambiguity items in this namespace.
            </div>
          ) : (
            inbox.items.map((item) => (
              <section key={item.candidateId} className="rounded-[28px] border border-white/10 bg-white/5 p-5 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{ambiguityLabel(item.ambiguityType)}</Badge>
                  <Badge variant="outline">{item.targetRole}</Badge>
                  <StatusBadge value={`confidence ${item.confidence.toFixed(2)}`} />
                  <StatusBadge value={`prior ${item.priorScore.toFixed(2)}`} />
                </div>
                <div className="mt-3 space-y-2">
                  <h3 className="text-lg font-semibold text-white">{item.rawText}</h3>
                  <p className="text-[15px] leading-7 text-slate-200">{item.ambiguityReason}</p>
                  {item.sceneText ? (
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-[15px] leading-7 text-slate-100">
                      {item.sceneText}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2 text-xs text-slate-300">
                    <span>{new Date(item.occurredAt).toLocaleString()}</span>
                    {item.sourceUri ? <span>{item.sourceUri}</span> : null}
                    <span>{item.claimType}</span>
                    <span>{item.predicate}</span>
                  </div>
                  {item.suggestedMatches.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {item.suggestedMatches.map((match) => (
                        <Badge key={match} variant="outline" className="border-amber-300/20 bg-amber-300/10 text-amber-100">
                          {match}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_220px]">
                  <form action="/console/inbox/resolve" method="post" className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
                    <input type="hidden" name="namespace_id" value={namespaceId} />
                    <input type="hidden" name="candidate_id" value={item.candidateId} />
                    <input type="hidden" name="target_role" value={item.targetRole} />
                    <label className="grid gap-1 text-sm text-slate-100">
                      <span>{item.ambiguityType === "place_grounding" ? "Link or create place" : "Canonical name"}</span>
                      <Input
                        name="canonical_name"
                        defaultValue={item.suggestedMatches[0] ?? item.rawText}
                        placeholder={item.ambiguityType === "place_grounding" ? "Chiang Mai" : "Benjamin Williams"}
                        required
                      />
                    </label>
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="grid gap-1 text-sm text-slate-100">
                        <span>Entity type</span>
                        <Input name="entity_type" defaultValue={defaultEntityType(item.ambiguityType)} required />
                      </label>
                      <label className="grid gap-1 text-sm text-slate-100">
                        <span>Extra aliases</span>
                        <Input name="aliases_csv" placeholder="Steven, Stephen Park" />
                      </label>
                    </div>
                    <label className="grid gap-1 text-sm text-slate-100">
                      <span>Note</span>
                      <Input name="note" placeholder="why this resolution is correct" />
                    </label>
                    <button
                      type="submit"
                      className="inline-flex w-fit items-center rounded-2xl bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                    >
                      Link and reprocess
                    </button>
                  </form>

                  <form action="/console/inbox/ignore" method="post" className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
                    <input type="hidden" name="namespace_id" value={namespaceId} />
                    <input type="hidden" name="candidate_id" value={item.candidateId} />
                    <label className="grid gap-1 text-sm text-slate-100">
                      <span>Ignore note</span>
                      <Input name="note" placeholder="not useful / leave raw only" />
                    </label>
                    <button
                      type="submit"
                      className="inline-flex w-fit items-center rounded-2xl border border-white/15 px-4 py-2.5 text-sm font-medium text-white hover:bg-white/8"
                    >
                      Ignore
                    </button>
                  </form>
                </div>
              </section>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="border-white/10 bg-white/5 text-white">
        <CardHeader>
          <CardDescription>Identity conflicts</CardDescription>
          <CardTitle>Potential duplicate people, places, orgs, and projects</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {identityConflicts.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-white/12 bg-white/5 p-8 text-sm text-slate-200">
              No high-confidence identity conflicts detected in this namespace.
            </div>
          ) : (
            identityConflicts.map((conflict) => (
              <section key={`${conflict.left.entityId}:${conflict.right.entityId}`} className="rounded-[28px] border border-white/10 bg-white/5 p-5 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{conflict.left.entityType}</Badge>
                  {conflict.crossLane ? (
                    <Badge variant="outline" className="border-cyan-300/20 bg-cyan-300/10 text-cyan-100">
                      cross-lane
                    </Badge>
                  ) : null}
                  <StatusBadge value={`confidence ${conflict.confidence.toFixed(2)}`} />
                  <StatusBadge value={`canonical ${conflict.suggestedCanonicalName}`} />
                </div>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  {[conflict.left, conflict.right].map((entity) => (
                    <div key={entity.entityId} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-lg font-semibold text-white">{entity.name}</h3>
                        <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                          {entity.entityType}
                        </Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-300">
                        <span>{laneLabel(entity.namespaceId)}</span>
                        <span>mentions {entity.mentionCount}</span>
                        <span>relationships {entity.relationshipCount}</span>
                        {entity.identityProfileId ? <span>profile linked</span> : null}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {entity.aliases.map((alias) => (
                          <Badge key={alias} variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                            {alias}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 space-y-2 text-sm text-slate-200">
                  {conflict.reasons.length > 0 ? (
                    <p>{conflict.reasons.join(" · ")}</p>
                  ) : null}
                  {conflict.sharedPredicates.length > 0 ? (
                    <p className="text-slate-300">shared predicates: {conflict.sharedPredicates.join(", ")}</p>
                  ) : null}
                  {conflict.sharedNeighborNames.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {conflict.sharedNeighborNames.slice(0, 6).map((neighbor) => (
                        <Badge key={neighbor} variant="outline" className="border-emerald-300/20 bg-emerald-300/10 text-emerald-100">
                          {neighbor}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="mt-5 flex flex-wrap gap-3">
                  <form action="/console/inbox/keep-separate" method="post">
                    <input type="hidden" name="namespace_id" value={namespaceId} />
                    <input type="hidden" name="left_entity_id" value={conflict.left.entityId} />
                    <input type="hidden" name="right_entity_id" value={conflict.right.entityId} />
                    <input type="hidden" name="note" value="confirmed as different identities" />
                    <button
                      type="submit"
                      className="inline-flex w-fit items-center rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-2.5 text-sm font-medium text-amber-100 hover:bg-amber-300/15"
                    >
                      These are different
                    </button>
                  </form>
                </div>
                <div className="mt-5 grid gap-4 lg:grid-cols-2">
                  <form action="/console/inbox/identity-resolve" method="post" className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
                    <input type="hidden" name="namespace_id" value={namespaceId} />
                    <input type="hidden" name="source_entity_id" value={conflict.right.entityId} />
                    <input type="hidden" name="target_entity_id" value={conflict.left.entityId} />
                    <input type="hidden" name="entity_type" value={conflict.left.entityType} />
                    <label className="grid gap-1 text-sm text-slate-100">
                      <span>Canonical name</span>
                      <Input name="canonical_name" defaultValue={conflict.suggestedCanonicalName} required />
                    </label>
                    <label className="grid gap-1 text-sm text-slate-100">
                      <span>Extra aliases</span>
                      <Input
                        name="aliases_csv"
                        defaultValue={Array.from(new Set([...conflict.left.aliases, ...conflict.right.aliases])).join(", ")}
                        placeholder="Gumee, Gumi"
                      />
                    </label>
                    <label className="grid gap-1 text-sm text-slate-100">
                      <span>Note</span>
                      <Input name="note" placeholder="why these should be merged" />
                    </label>
                    <label className="flex items-center gap-2 text-sm text-slate-200">
                      <input type="checkbox" name="preserve_aliases" defaultChecked className="size-4 rounded border-white/20 bg-white/5" />
                      <span>Keep prior names as aliases</span>
                    </label>
                    <button
                      type="submit"
                      className="inline-flex w-fit items-center rounded-2xl bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                    >
                      {conflict.crossLane ? `Link to ${conflict.left.name}` : `Merge into ${conflict.left.name}`}
                    </button>
                  </form>

                  <form action="/console/inbox/identity-resolve" method="post" className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
                    <input type="hidden" name="namespace_id" value={namespaceId} />
                    <input type="hidden" name="source_entity_id" value={conflict.left.entityId} />
                    <input type="hidden" name="target_entity_id" value={conflict.right.entityId} />
                    <input type="hidden" name="entity_type" value={conflict.right.entityType} />
                    <label className="grid gap-1 text-sm text-slate-100">
                      <span>Canonical name</span>
                      <Input name="canonical_name" defaultValue={conflict.suggestedCanonicalName} required />
                    </label>
                    <label className="grid gap-1 text-sm text-slate-100">
                      <span>Extra aliases</span>
                      <Input
                        name="aliases_csv"
                        defaultValue={Array.from(new Set([...conflict.left.aliases, ...conflict.right.aliases])).join(", ")}
                        placeholder="Gumee, Gumi"
                      />
                    </label>
                    <label className="grid gap-1 text-sm text-slate-100">
                      <span>Note</span>
                      <Input name="note" placeholder="why these should be merged" />
                    </label>
                    <label className="flex items-center gap-2 text-sm text-slate-200">
                      <input type="checkbox" name="preserve_aliases" defaultChecked className="size-4 rounded border-white/20 bg-white/5" />
                      <span>Keep prior names as aliases</span>
                    </label>
                    <button
                      type="submit"
                      className="inline-flex w-fit items-center rounded-2xl border border-white/15 px-4 py-2.5 text-sm font-medium text-white hover:bg-white/8"
                    >
                      {conflict.crossLane ? `Link to ${conflict.right.name}` : `Merge into ${conflict.right.name}`}
                    </button>
                  </form>
                </div>
              </section>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="border-white/10 bg-white/5 text-white">
        <CardHeader>
          <CardDescription>Resolved decisions</CardDescription>
          <CardTitle>Recent identity review history</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {identityHistory.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-white/12 bg-white/5 p-8 text-sm text-slate-200">
              No recorded identity decisions for this namespace yet.
            </div>
          ) : (
            identityHistory.map((item) => (
              <div key={item.decisionId} className="rounded-[24px] border border-white/10 bg-white/5 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{item.decision === "merge" ? "merged" : "kept separate"}</Badge>
                  {item.canonicalName ? (
                    <Badge variant="outline" className="border-cyan-300/20 bg-cyan-300/10 text-cyan-100">
                      canonical {item.canonicalName}
                    </Badge>
                  ) : null}
                  <span className="text-xs text-slate-400">{new Date(item.updatedAt).toLocaleString()}</span>
                </div>
                <p className="mt-3 text-sm text-slate-100">
                  {item.left.name} <span className="text-slate-400">({laneLabel(item.left.namespaceId)})</span> and {item.right.name}{" "}
                  <span className="text-slate-400">({laneLabel(item.right.namespaceId)})</span>
                </p>
                {item.note ? <p className="mt-2 text-sm leading-6 text-slate-300">{item.note}</p> : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </ConsoleShell>
  );
}
