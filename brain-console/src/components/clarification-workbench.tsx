import { ignoreOwnerClarificationAction, resolveOwnerClarificationAction } from "@/app/bootstrap/actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { WorkbenchClarificationItem, WorkbenchClarifications } from "@/lib/operator-workbench";

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

export interface ClarificationWorkbenchProps {
  readonly namespaceId: string;
  readonly clarifications: WorkbenchClarifications | null;
  readonly redirectPath: string;
  readonly title?: string;
  readonly description?: string;
  readonly limit?: number;
  readonly compact?: boolean;
}

function ClarificationCard({
  item,
  namespaceId,
  redirectPath,
  compact
}: {
  readonly item: WorkbenchClarificationItem;
  readonly namespaceId: string;
  readonly redirectPath: string;
  readonly compact: boolean;
}) {
  return (
    <section className="rounded-[24px] border border-white/8 bg-white/5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="border-white/10 bg-white/5 text-stone-200">
          {ambiguityLabel(item.ambiguityType)}
        </Badge>
        <Badge variant="outline" className="border-white/10 bg-white/5 text-stone-200">
          {item.targetRole}
        </Badge>
        <Badge variant="outline" className={confidenceTone(item.confidence)}>
          {item.confidence !== undefined ? `${Math.round(item.confidence * 100)}%` : "n/a"}
        </Badge>
      </div>

      <div className="mt-3 space-y-2">
        <h3 className="text-base font-semibold text-white">{item.rawText}</h3>
        {item.ambiguityReason ? <p className="text-sm leading-7 text-slate-300">{item.ambiguityReason}</p> : null}
        {item.sceneText ? (
          <div className="rounded-2xl border border-white/8 bg-black/15 p-3 text-sm leading-7 text-slate-200">{item.sceneText}</div>
        ) : null}
        <div className="flex flex-wrap gap-2 text-xs text-slate-400">
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

      <div className={`mt-4 grid gap-4 ${compact ? "xl:grid-cols-[1fr_220px]" : "lg:grid-cols-[1fr_220px]"}`}>
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
              <Input name="aliases_csv" placeholder="uncle Joe, Steve's uncle" />
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
  );
}

export function ClarificationWorkbench({
  namespaceId,
  clarifications,
  redirectPath,
  title = "Clarification inbox",
  description = "Resolve ambiguous people, places, aliases, and grounded references without mutating raw evidence.",
  limit = 6,
  compact = false
}: ClarificationWorkbenchProps) {
  const items = (clarifications?.items ?? []).slice(0, limit);

  return (
    <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
      <CardHeader>
        <CardDescription>{namespaceId}</CardDescription>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-[18px] border border-white/8 bg-white/5 px-4 py-3 text-sm leading-7 text-slate-300">{description}</div>
        {items.length === 0 ? (
          <div className="rounded-[20px] border border-dashed border-white/12 bg-white/5 p-5 text-sm leading-7 text-slate-300">
            No unresolved clarification items are currently open for this namespace.
          </div>
        ) : (
          items.map((item) => (
            <ClarificationCard
              key={item.candidateId}
              item={item}
              namespaceId={namespaceId}
              redirectPath={redirectPath}
              compact={compact}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
