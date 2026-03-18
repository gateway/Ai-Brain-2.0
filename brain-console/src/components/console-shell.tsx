import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const navigation = [
  { href: "/console", label: "Overview" },
  { href: "/console/query", label: "Query" },
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
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(245,198,110,0.20),_transparent_28%),linear-gradient(180deg,_#f7f4ec_0%,_#eee7d6_52%,_#e9e1cf_100%)] text-slate-900">
      <div className="mx-auto grid min-h-screen max-w-7xl gap-6 px-4 py-6 lg:grid-cols-[240px_1fr] lg:px-6">
        <aside className="rounded-[28px] border border-slate-900/10 bg-white/80 p-5 shadow-[0_18px_60px_rgba(70,56,22,0.12)] backdrop-blur">
          <div className="space-y-3">
            <Badge variant="outline" className="border-amber-500/40 bg-amber-100/80 text-amber-900">
              Brain 2.0 Console
            </Badge>
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.35em] text-slate-500">Operator Surface</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">Local Brain Dashboard</h1>
            </div>
            <p className="text-sm leading-6 text-slate-600">
              Read-first runtime visibility for retrieval, provenance, temporal summaries, and evaluation.
            </p>
          </div>
          <div className="my-5 h-px w-full bg-slate-900/10" />
          <nav className="space-y-2">
            {navigation.map((item) => {
              const active = item.href === currentPath;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center justify-between rounded-2xl px-4 py-3 text-sm transition-colors",
                    active
                      ? "bg-slate-900 text-white shadow-[0_12px_30px_rgba(15,23,42,0.22)]"
                      : "text-slate-700 hover:bg-slate-900/5"
                  )}
                >
                  <span>{item.label}</span>
                  {active ? <span className="font-mono text-xs uppercase tracking-[0.25em] text-slate-300">live</span> : null}
                </Link>
              );
            })}
          </nav>
          <div className="my-5 h-px w-full bg-slate-900/10" />
          <div className="space-y-2 text-sm text-slate-600">
            <p className="font-medium text-slate-900">Why this exists</p>
            <p>
              Keep the brain observable while BM25, TMT, relationships, and derivation workers continue hardening.
            </p>
          </div>
        </aside>

        <main className="space-y-6 rounded-[32px] border border-slate-900/10 bg-white/75 p-5 shadow-[0_18px_60px_rgba(70,56,22,0.12)] backdrop-blur lg:p-7">
          <header className="flex flex-col gap-3 border-b border-slate-900/10 pb-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.35em] text-slate-500">{currentPath}</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">{title}</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{subtitle}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="border-emerald-500/30 bg-emerald-50 text-emerald-800">
                Local-first
              </Badge>
              <Badge variant="outline" className="border-sky-500/30 bg-sky-50 text-sky-800">
                Postgres-centered
              </Badge>
            </div>
          </header>
          {children}
        </main>
      </div>
    </div>
  );
}
