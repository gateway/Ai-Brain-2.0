import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface ConsoleSectionProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

export function ConsoleSection({ eyebrow, title, description, action, children, className }: ConsoleSectionProps) {
  return (
    <Card
      className={cn(
        "overflow-hidden border-border/70 bg-[linear-gradient(180deg,_rgba(13,18,31,0.96)_0%,_rgba(8,11,20,0.98)_100%)] shadow-[0_24px_80px_rgba(0,0,0,0.26)] backdrop-blur",
        className
      )}
    >
      <CardHeader className="border-b border-white/6 pb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <CardDescription className="font-mono text-[11px] uppercase tracking-[0.34em] text-slate-400">{eyebrow}</CardDescription>
            <CardTitle className="text-2xl font-semibold tracking-tight text-white">{title}</CardTitle>
            {description ? <p className="max-w-4xl text-sm leading-7 text-slate-300">{description}</p> : null}
          </div>
          {action ? <div className="flex flex-wrap justify-end gap-2">{action}</div> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">{children}</CardContent>
    </Card>
  );
}

interface ConsoleEntryCardProps {
  readonly href: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly meta?: string;
  readonly badge?: string;
}

export function ConsoleEntryCard({ href, eyebrow, title, description, meta, badge }: ConsoleEntryCardProps) {
  return (
    <Link
      href={href}
      className={cn(
        "group relative overflow-hidden rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,_rgba(15,23,42,0.96)_0%,_rgba(8,12,22,0.98)_100%)] p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-cyan-400/30 hover:shadow-[0_22px_60px_rgba(0,0,0,0.28)]"
      )}
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/12 to-transparent" />
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="font-mono text-[11px] uppercase tracking-[0.34em] text-slate-500">{eyebrow}</p>
          <h3 className="text-xl font-semibold tracking-tight text-white">{title}</h3>
          <p className="max-w-md text-sm leading-6 text-slate-300">{description}</p>
        </div>
        {badge ? (
          <Badge variant="outline" className="border-cyan-400/20 bg-cyan-400/10 text-cyan-100">
            {badge}
          </Badge>
        ) : null}
      </div>
      <div className="mt-6 flex items-center justify-between text-xs uppercase tracking-[0.28em] text-slate-500">
        <span>{meta ?? "open panel"}</span>
        <span className="font-mono text-slate-300 transition group-hover:text-white">↗</span>
      </div>
    </Link>
  );
}
