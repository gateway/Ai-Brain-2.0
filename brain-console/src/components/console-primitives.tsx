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
        "premium-panel overflow-hidden rounded-[32px] border-border/70 shadow-[0_24px_80px_rgba(0,0,0,0.24)] backdrop-blur-xl",
        className
      )}
    >
      <CardHeader className="border-b border-white/6 pb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <CardDescription className="premium-eyebrow text-slate-200">{eyebrow}</CardDescription>
            <CardTitle className="text-[1.75rem] font-semibold tracking-[-0.035em] text-white">{title}</CardTitle>
            {description ? <p className="max-w-4xl text-[15px] leading-8 text-slate-100">{description}</p> : null}
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
  readonly className?: string;
}

export function ConsoleEntryCard({ href, eyebrow, title, description, meta, badge, className }: ConsoleEntryCardProps) {
  return (
    <Link
      href={href}
      className={cn(
        "group relative overflow-hidden rounded-[30px] border border-white/8 bg-[linear-gradient(180deg,_rgba(17,24,39,0.94)_0%,_rgba(8,12,22,0.98)_100%)] p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-cyan-400/30 hover:shadow-[0_22px_50px_rgba(0,0,0,0.24)] sm:p-6",
        className
      )}
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/12 to-transparent" />
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="premium-eyebrow text-slate-200">{eyebrow}</p>
          <h3 className="text-[1.2rem] font-semibold tracking-[-0.03em] text-white">{title}</h3>
          <p className="max-w-md text-[15px] leading-7 text-slate-100">{description}</p>
        </div>
        {badge ? (
          <Badge variant="outline" className="border-cyan-400/20 bg-cyan-400/10 text-cyan-100">
            {badge}
          </Badge>
        ) : null}
      </div>
      <div className="mt-6 flex items-center justify-between text-xs uppercase tracking-[0.2em] text-slate-300">
        <span>{meta ?? "open panel"}</span>
        <span className="text-slate-100 transition group-hover:text-white">↗</span>
      </div>
    </Link>
  );
}
