import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const navigation = [
  { href: "/console", label: "Overview" },
  { href: "/console/query", label: "Query" },
  { href: "/console/timeline", label: "Timeline" },
  { href: "/console/relationships", label: "Relationships" },
  { href: "/console/eval", label: "Eval" },
  { href: "/console/benchmark", label: "Benchmark" },
  { href: "/console/jobs", label: "Jobs" }
] as const;

export interface ConsoleShellProps {
  readonly title: string;
  readonly subtitle: string;
  readonly currentPath: string;
  readonly children: ReactNode;
}

export function ConsoleShell({ title, subtitle, currentPath, children }: ConsoleShellProps) {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(255,183,77,0.22),_transparent_25%),radial-gradient(circle_at_top_right,_rgba(79,209,197,0.18),_transparent_28%),linear-gradient(180deg,_#f6f1e8_0%,_#eadfcd_52%,_#e6dac5_100%)] text-slate-950">
      <div className="pointer-events-none fixed inset-0 opacity-50 [background-image:linear-gradient(rgba(15,23,42,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.03)_1px,transparent_1px)] [background-size:26px_26px]" />
      <div className="mx-auto grid min-h-screen max-w-[1500px] gap-6 px-4 py-5 lg:grid-cols-[265px_1fr] lg:px-6">
        <aside className="relative overflow-hidden rounded-[32px] border border-slate-900/10 bg-[linear-gradient(180deg,_rgba(15,23,42,0.97)_0%,_rgba(24,37,58,0.96)_100%)] p-5 text-white shadow-[0_24px_80px_rgba(27,31,44,0.35)]">
          <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-amber-200/50 to-transparent" />
          <div className="space-y-3">
            <Badge variant="outline" className="border-amber-300/30 bg-amber-200/10 text-amber-100">
              Brain 2.0 Operator Console
            </Badge>
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.35em] text-slate-400">Operator Surface</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Local Cognitive Atlas</h1>
            </div>
            <p className="text-sm leading-6 text-slate-300">
              A visual control room for memory, timelines, relationships, provenance, and retrieval quality.
            </p>
          </div>
          <div className="my-6 h-px w-full bg-white/10" />
          <nav className="space-y-2.5">
            {navigation.map((item) => {
              const active = item.href === currentPath;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center justify-between rounded-[20px] px-4 py-3 text-sm transition-all",
                    active
                      ? "bg-white text-slate-950 shadow-[0_18px_40px_rgba(15,23,42,0.25)]"
                      : "text-slate-300 hover:bg-white/6 hover:text-white"
                  )}
                >
                  <span>{item.label}</span>
                  {active ? <span className="font-mono text-[10px] uppercase tracking-[0.35em] text-slate-500">open</span> : null}
                </Link>
              );
            })}
          </nav>
          <div className="my-6 h-px w-full bg-white/10" />
          <div className="space-y-2 rounded-[22px] border border-white/10 bg-white/5 p-4 text-sm text-slate-300">
            <p className="font-medium text-white">Why this exists</p>
            <p>
              Keep the brain observable while TMT, relationships, and derivation workers keep maturing.
            </p>
          </div>
        </aside>

        <main className="space-y-6 rounded-[36px] border border-slate-900/10 bg-[linear-gradient(180deg,_rgba(255,255,255,0.82)_0%,_rgba(251,248,241,0.88)_100%)] p-5 shadow-[0_24px_80px_rgba(70,56,22,0.18)] backdrop-blur lg:p-7">
          <header className="flex flex-col gap-4 border-b border-slate-900/10 pb-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.38em] text-slate-500">{currentPath}</p>
              <h2 className="mt-2 text-4xl font-semibold tracking-tight text-slate-950">{title}</h2>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">{subtitle}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="border-emerald-500/25 bg-emerald-50/90 text-emerald-900">
                Local-first
              </Badge>
              <Badge variant="outline" className="border-sky-500/25 bg-sky-50/90 text-sky-900">
                Postgres-centered
              </Badge>
              <Badge variant="outline" className="border-amber-500/25 bg-amber-50/90 text-amber-900">
                Temporal memory
              </Badge>
            </div>
          </header>
          {children}
        </main>
      </div>
    </div>
  );
}
