import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface SetupStepGuideProps {
  readonly step: string;
  readonly title: string;
  readonly whatToDo: string;
  readonly whyItMatters: string;
  readonly nextLabel?: string;
  readonly nextHref?: string;
  readonly statusLabel?: string;
}

export function SetupStepGuide({
  step,
  title,
  whatToDo,
  whyItMatters,
  nextLabel,
  nextHref,
  statusLabel
}: SetupStepGuideProps) {
  return (
    <Card className="overflow-hidden border-cyan-300/18 bg-[radial-gradient(circle_at_top_right,_rgba(103,232,249,0.12),_transparent_24%),linear-gradient(180deg,_rgba(15,27,37,0.98)_0%,_rgba(9,13,22,0.98)_100%)] shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-cyan-100/75">{step}</p>
            <CardTitle className="mt-3 max-w-2xl text-[1.5rem] leading-tight text-white sm:text-[1.85rem]">{title}</CardTitle>
          </div>
          {statusLabel ? (
            <Badge variant="outline" className="border-cyan-300/25 bg-cyan-300/12 px-3 py-1 text-cyan-50">
              {statusLabel}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 pt-2 lg:grid-cols-[1.05fr_1fr_auto] lg:items-stretch">
        <div className="rounded-[22px] border border-white/8 bg-[linear-gradient(180deg,_rgba(255,255,255,0.07)_0%,_rgba(255,255,255,0.04)_100%)] p-5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-300">What To Do Here</p>
          <p className="mt-3 text-[15px] leading-8 text-slate-100">{whatToDo}</p>
        </div>
        <div className="rounded-[22px] border border-white/8 bg-[linear-gradient(180deg,_rgba(255,255,255,0.07)_0%,_rgba(255,255,255,0.04)_100%)] p-5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-300">Why It Matters</p>
          <p className="mt-3 text-[15px] leading-8 text-slate-100">{whyItMatters}</p>
        </div>
        {nextHref && nextLabel ? (
          <div className="flex lg:h-full lg:items-end lg:justify-end">
            <Link
              href={nextHref}
              className="inline-flex min-h-11 items-center rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-5 py-3 text-sm font-medium text-cyan-50 shadow-[0_12px_34px_rgba(34,211,238,0.12)] hover:border-cyan-300/35 hover:bg-cyan-300/16"
            >
              {nextLabel}
            </Link>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
