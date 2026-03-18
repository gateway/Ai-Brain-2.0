import { ConsoleShell } from "@/components/console-shell";
import { StatusBadge } from "@/components/metric-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getClarificationInbox, getConsoleDefaults } from "@/lib/brain-runtime";

function ambiguityLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function defaultEntityType(ambiguityType: string): string {
  if (ambiguityType === "vague_place" || ambiguityType === "place_grounding") {
    return "place";
  }

  return "person";
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
  const inbox = await getClarificationInbox({
    namespaceId,
    limit: "40"
  });

  return (
    <ConsoleShell
      currentPath="/console/inbox"
      title="Clarification Inbox"
      subtitle="Resolve misspellings, undefined kinship roles, vague places, and alias collisions without touching the raw evidence layer."
    >
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="border-slate-900/10 bg-white/80">
          <CardHeader className="pb-2">
            <CardDescription>Namespace</CardDescription>
            <CardTitle className="text-lg">{namespaceId}</CardTitle>
          </CardHeader>
          <CardContent>
            <StatusBadge value={`${inbox.summary.total} pending`} />
          </CardContent>
        </Card>
        {Object.entries(inbox.summary.byType)
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, 3)
          .map(([type, total]) => (
            <Card key={type} className="border-slate-900/10 bg-white/80">
              <CardHeader className="pb-2">
                <CardDescription>Ambiguity Type</CardDescription>
                <CardTitle className="text-lg">{ambiguityLabel(type)}</CardTitle>
              </CardHeader>
              <CardContent>
                <StatusBadge value={`${total}`} />
              </CardContent>
            </Card>
          ))}
      </div>

      <Card className="border-slate-900/10 bg-white/80">
        <CardHeader>
          <CardDescription>Review queue</CardDescription>
          <CardTitle>Manual clarification keeps the graph honest</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {inbox.items.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-slate-900/15 bg-white/70 p-8 text-sm text-slate-600">
              No unresolved ambiguity items in this namespace.
            </div>
          ) : (
            inbox.items.map((item) => (
              <section key={item.candidateId} className="rounded-[28px] border border-slate-900/10 bg-white/90 p-5 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{ambiguityLabel(item.ambiguityType)}</Badge>
                  <Badge variant="outline">{item.targetRole}</Badge>
                  <StatusBadge value={`confidence ${item.confidence.toFixed(2)}`} />
                  <StatusBadge value={`prior ${item.priorScore.toFixed(2)}`} />
                </div>
                <div className="mt-3 space-y-2">
                  <h3 className="text-lg font-semibold text-slate-950">{item.rawText}</h3>
                  <p className="text-sm leading-6 text-slate-600">{item.ambiguityReason}</p>
                  {item.sceneText ? (
                    <div className="rounded-2xl border border-slate-900/10 bg-slate-50/90 p-4 text-sm leading-6 text-slate-700">
                      {item.sceneText}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                    <span>{new Date(item.occurredAt).toLocaleString()}</span>
                    {item.sourceUri ? <span>{item.sourceUri}</span> : null}
                    <span>{item.claimType}</span>
                    <span>{item.predicate}</span>
                  </div>
                  {item.suggestedMatches.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {item.suggestedMatches.map((match) => (
                        <Badge key={match} variant="outline" className="bg-amber-50 text-amber-950">
                          {match}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_220px]">
                  <form action="/console/inbox/resolve" method="post" className="grid gap-3 rounded-2xl border border-slate-900/10 bg-slate-50/80 p-4">
                    <input type="hidden" name="namespace_id" value={namespaceId} />
                    <input type="hidden" name="candidate_id" value={item.candidateId} />
                    <input type="hidden" name="target_role" value={item.targetRole} />
                    <label className="grid gap-1 text-sm text-slate-700">
                      <span>{item.ambiguityType === "place_grounding" ? "Link or create place" : "Canonical name"}</span>
                      <Input
                        name="canonical_name"
                        defaultValue={item.suggestedMatches[0] ?? item.rawText}
                        placeholder={item.ambiguityType === "place_grounding" ? "Chiang Mai" : "Benjamin Williams"}
                        required
                      />
                    </label>
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="grid gap-1 text-sm text-slate-700">
                        <span>Entity type</span>
                        <Input name="entity_type" defaultValue={defaultEntityType(item.ambiguityType)} required />
                      </label>
                      <label className="grid gap-1 text-sm text-slate-700">
                        <span>Extra aliases</span>
                        <Input name="aliases_csv" placeholder="Steven, Stephen Park" />
                      </label>
                    </div>
                    <label className="grid gap-1 text-sm text-slate-700">
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

                  <form action="/console/inbox/ignore" method="post" className="grid gap-3 rounded-2xl border border-slate-900/10 bg-white p-4">
                    <input type="hidden" name="namespace_id" value={namespaceId} />
                    <input type="hidden" name="candidate_id" value={item.candidateId} />
                    <label className="grid gap-1 text-sm text-slate-700">
                      <span>Ignore note</span>
                      <Input name="note" placeholder="not useful / leave raw only" />
                    </label>
                    <button
                      type="submit"
                      className="inline-flex w-fit items-center rounded-2xl border border-slate-900/15 px-4 py-2.5 text-sm font-medium text-slate-900 hover:bg-slate-50"
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
    </ConsoleShell>
  );
}
