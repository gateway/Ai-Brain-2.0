import Link from "next/link";
import { ignoreOwnerClarificationAction, resolveOwnerClarificationAction } from "@/app/bootstrap/actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { OperatorShell } from "@/components/operator-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getBootstrapState, getNamespaceCatalog, getWorkbenchClarifications, type WorkbenchClarificationItem } from "@/lib/operator-workbench";
import { requireSetupComplete } from "@/lib/setup-gating";

function ambiguityLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function defaultEntityType(ambiguityType: string): string {
  if (ambiguityType === "vague_place" || ambiguityType === "place_grounding") {
    return "place";
  }
  if (ambiguityType === "organization_match") {
    return "organization";
  }
  return "person";
}

function formatDateTime(value?: string | null): string {
  if (!value) {
    return "not yet";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function confidenceTone(confidence?: number): string {
  if (confidence === undefined) {
    return "border-white/10 bg-white/5 text-slate-100";
  }
  if (confidence >= 0.85) {
    return "border-emerald-400/20 bg-emerald-400/10 text-emerald-100";
  }
  if (confidence >= 0.6) {
    return "border-amber-300/20 bg-amber-300/10 text-amber-100";
  }
  return "border-rose-400/20 bg-rose-400/10 text-rose-100";
}

function clarificationPriority(item: WorkbenchClarificationItem): {
  readonly label: string;
  readonly tone: string;
  readonly score: number;
} {
  const prior = item.priorScore ?? 0;
  const confidence = item.confidence ?? 0;
  const typeBoost =
    item.ambiguityType === "kinship_resolution" || item.ambiguityType === "place_grounding"
      ? 0.12
      : item.ambiguityType === "alias_collision" || item.ambiguityType === "possible_misspelling"
        ? 0.06
        : 0;
  const score = prior * 0.72 + confidence * 0.18 + typeBoost;

  if (score >= 0.78) {
    return {
      label: "Priority 1",
      tone: "border-rose-300/25 bg-rose-300/12 text-rose-50",
      score
    };
  }
  if (score >= 0.56) {
    return {
      label: "Priority 2",
      tone: "border-amber-300/25 bg-amber-300/12 text-amber-50",
      score
    };
  }
  return {
    label: "Priority 3",
    tone: "border-cyan-300/20 bg-cyan-300/10 text-cyan-50",
    score
  };
}

function searchValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

export default async function ClarificationsPage({
  searchParams
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  await requireSetupComplete("/clarifications");
  const params = await searchParams;
  const namespaceFilter = searchValue(params.namespace) ?? "all";
  const [bootstrap, catalog] = await Promise.all([getBootstrapState(), getNamespaceCatalog()]);
  const durableNamespaces = catalog.namespaces.filter((item) => item.category === "durable");
  const defaultNamespaceId = bootstrap.metadata.defaultNamespaceId ?? catalog.defaultNamespaceId ?? durableNamespaces[0]?.namespaceId ?? "personal";
  const selectedNamespaces =
    namespaceFilter === "all"
      ? durableNamespaces
      : durableNamespaces.filter((item) => item.namespaceId === namespaceFilter);

  const clarificationGroups = await Promise.all(
    selectedNamespaces.map(async (namespace) => ({
      namespace,
      clarifications: await getWorkbenchClarifications(namespace.namespaceId, 30).catch(() => null)
    }))
  );

  const rankedItems = clarificationGroups
    .flatMap(({ namespace, clarifications }) =>
      (clarifications?.items ?? []).map((item) => ({
        namespaceId: namespace.namespaceId,
        namespaceLabel: namespace.namespaceId,
        item,
        priority: clarificationPriority(item)
      }))
    )
    .sort((left, right) => {
      if (right.priority.score !== left.priority.score) {
        return right.priority.score - left.priority.score;
      }
      return new Date(right.item.occurredAt).getTime() - new Date(left.item.occurredAt).getTime();
    });

  const byType = rankedItems.reduce<Record<string, number>>((summary, entry) => {
    summary[entry.item.ambiguityType] = (summary[entry.item.ambiguityType] ?? 0) + 1;
    return summary;
  }, {});
  const highestNamespace =
    clarificationGroups
      .map(({ namespace, clarifications }) => ({
        namespaceId: namespace.namespaceId,
        total: clarifications?.summary.total ?? 0
      }))
      .sort((left, right) => right.total - left.total)[0] ?? null;
  const redirectPath = namespaceFilter === "all" ? "/clarifications" : `/clarifications?namespace=${encodeURIComponent(namespaceFilter)}`;

  return (
    <OperatorShell
      currentPath="/clarifications"
      title="Clarifications"
      subtitle="This is the list of things the brain does not know well enough yet. Work from the top down, keep the graph honest, and let the runtime propagate the fixes."
    >
      <div className="space-y-6">
        <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
          <Card className="border-white/8 bg-[radial-gradient(circle_at_top_right,_rgba(103,232,249,0.08),_transparent_28%),linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Operator queue</CardDescription>
              <CardTitle>Unknowns worth fixing first</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
              <p>These are ranked by the backend urgency signal, then lightly boosted for the kinds of ambiguity that tend to poison recall fastest, like kinship and vague places.</p>
              <div className="flex flex-wrap gap-2">
                <Link href="/clarifications" className={`rounded-full border px-3 py-1.5 text-xs ${namespaceFilter === "all" ? "border-amber-300/30 bg-amber-300/16 text-white" : "border-white/10 bg-white/5 text-slate-200"}`}>
                  All lanes
                </Link>
                {durableNamespaces.map((namespace) => (
                  <Link
                    key={namespace.namespaceId}
                    href={`/clarifications?namespace=${encodeURIComponent(namespace.namespaceId)}`}
                    className={`rounded-full border px-3 py-1.5 text-xs ${
                      namespaceFilter === namespace.namespaceId ? "border-amber-300/30 bg-amber-300/16 text-white" : "border-white/10 bg-white/5 text-slate-200"
                    }`}
                  >
                    {namespace.namespaceId}
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-1">
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader className="pb-2">
                <CardDescription>Open items</CardDescription>
                <CardTitle className="text-[1.6rem] text-white">{rankedItems.length}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-300">Still waiting on operator grounding.</CardContent>
            </Card>
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader className="pb-2">
                <CardDescription>Most loaded lane</CardDescription>
                <CardTitle className="text-lg text-white">{highestNamespace?.namespaceId ?? defaultNamespaceId}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-300">{highestNamespace?.total ?? 0} items need attention there.</CardContent>
            </Card>
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader className="pb-2">
                <CardDescription>Top ambiguity types</CardDescription>
                <CardTitle className="text-lg text-white">{Object.keys(byType).length}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {Object.entries(byType)
                  .sort((left, right) => right[1] - left[1])
                  .slice(0, 3)
                  .map(([type, total]) => (
                    <Badge key={type} variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                      {ambiguityLabel(type)} · {total}
                    </Badge>
                  ))}
              </CardContent>
            </Card>
          </div>
        </div>

        {rankedItems.length === 0 ? (
          <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardContent className="p-6 text-sm leading-7 text-slate-300">
              No open clarification items right now. This is suspiciously civilized.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {rankedItems.map(({ namespaceId, item, priority }) => (
              <section key={`${namespaceId}:${item.candidateId}`} className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={priority.tone}>
                    {priority.label}
                  </Badge>
                  <Badge variant="outline" className="border-white/10 bg-white/5 text-stone-200">
                    {namespaceId}
                  </Badge>
                  <Badge variant="outline" className="border-white/10 bg-white/5 text-stone-200">
                    {ambiguityLabel(item.ambiguityType)}
                  </Badge>
                  <Badge variant="outline" className="border-white/10 bg-white/5 text-stone-200">
                    {item.targetRole}
                  </Badge>
                  <Badge variant="outline" className={confidenceTone(item.confidence)}>
                    {item.confidence !== undefined ? `${Math.round(item.confidence * 100)}% confidence` : "confidence n/a"}
                  </Badge>
                  {item.priorScore !== undefined ? (
                    <Badge variant="outline" className="border-cyan-300/20 bg-cyan-300/10 text-cyan-50">
                      prior {item.priorScore.toFixed(2)}
                    </Badge>
                  ) : null}
                </div>

                <div className="mt-4 space-y-2">
                  <h3 className="text-lg font-semibold text-white">{item.rawText}</h3>
                  {item.ambiguityReason ? <p className="text-[15px] leading-7 text-slate-300">{item.ambiguityReason}</p> : null}
                  {item.sceneText ? (
                    <div className="rounded-2xl border border-white/8 bg-black/15 p-4 text-sm leading-7 text-slate-200">
                      {item.sceneText}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2 text-xs text-slate-400">
                    <span>{formatDateTime(item.occurredAt)}</span>
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
                  <form action={resolveOwnerClarificationAction} className="grid gap-3 rounded-2xl border border-white/10 bg-black/15 p-4">
                    <input type="hidden" name="namespace_id" value={namespaceId} />
                    <input type="hidden" name="candidate_id" value={item.candidateId} />
                    <input type="hidden" name="target_role" value={item.targetRole} />
                    <input type="hidden" name="redirect_path" value={redirectPath} />
                    <label className="grid gap-1 text-sm text-slate-100">
                      <span>{item.ambiguityType === "place_grounding" ? "Link or create place" : "Canonical name"}</span>
                      <Input
                        name="canonical_name"
                        defaultValue={item.suggestedMatches[0] ?? item.rawText}
                        placeholder={item.ambiguityType === "place_grounding" ? "Lake Tahoe, California" : "Joe Smith"}
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
                        <Input name="aliases_csv" placeholder="uncle Joe, Chiang Mai cabin" />
                      </label>
                    </div>
                    <label className="grid gap-1 text-sm text-slate-100">
                      <span>Note</span>
                      <Input name="note" placeholder="why this resolution is correct" />
                    </label>
                    <PendingSubmitButton
                      idleLabel="Link and reprocess"
                      pendingLabel="Resolving..."
                      className="inline-flex w-fit rounded-2xl bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                    />
                  </form>

                  <form action={ignoreOwnerClarificationAction} className="grid gap-3 rounded-2xl border border-white/10 bg-black/15 p-4">
                    <input type="hidden" name="namespace_id" value={namespaceId} />
                    <input type="hidden" name="candidate_id" value={item.candidateId} />
                    <input type="hidden" name="redirect_path" value={redirectPath} />
                    <label className="grid gap-1 text-sm text-slate-100">
                      <span>Ignore note</span>
                      <Input name="note" placeholder="not useful / leave raw only" />
                    </label>
                    <PendingSubmitButton
                      idleLabel="Ignore"
                      pendingLabel="Ignoring..."
                      variant="outline"
                      className="inline-flex w-fit rounded-2xl border border-white/15 px-4 py-2.5 text-sm font-medium text-white hover:bg-white/8"
                    />
                  </form>
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </OperatorShell>
  );
}
