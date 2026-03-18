import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const navigation = [
  { href: "/console", label: "Overview" },
  { href: "/console/query", label: "Query" },
  { href: "/console/timeline", label: "Timeline" },
  { href: "/console/relationships", label: "Relationships" },
  { href: "/console/inbox", label: "Inbox" },
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
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_right,_rgba(208,255,97,0.10),_transparent_20%),radial-gradient(circle_at_bottom_left,_rgba(64,150,255,0.10),_transparent_24%),linear-gradient(180deg,_#08090d_0%,_#0b0d12_42%,_#050608_100%)] text-slate-100">
      <div className="pointer-events-none fixed inset-0 opacity-30 [background-image:linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] [background-size:24px_24px]" />
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(255,255,255,0.08),transparent_18%),radial-gradient(circle_at_84%_18%,rgba(214,255,98,0.07),transparent_16%),radial-gradient(circle_at_90%_56%,rgba(255,255,255,0.08),transparent_14%)] opacity-70" />

      <div className="mx-auto flex min-h-screen max-w-[1800px] flex-col gap-5 px-3 py-4 lg:px-5">
        <header className="sticky top-4 z-20 overflow-hidden rounded-[32px] border border-white/8 bg-[linear-gradient(180deg,_rgba(16,18,24,0.98)_0%,_rgba(10,12,16,0.98)_100%)] px-4 py-4 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur">
          <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-lime-300/60 to-transparent" />
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
            <div className="flex min-w-0 items-start gap-3">
              <div className="rounded-2xl border border-lime-300/20 bg-lime-300/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.28em] text-lime-100">
                Brain 2.0
              </div>
              <div className="min-w-0">
                <p className="font-mono text-[11px] uppercase tracking-[0.34em] text-slate-500">Operator surface</p>
                <h1 className="mt-1 text-xl font-semibold tracking-tight text-white">Local Cognitive Atlas</h1>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
                  A dark control deck for memory, timelines, relationships, provenance, ambiguity, and retrieval quality.
                </p>
              </div>
            </div>

            <nav className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto rounded-[24px] border border-white/8 bg-white/5 p-1">
              {navigation.map((item) => {
                const active = item.href === currentPath;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "inline-flex shrink-0 items-center justify-center rounded-full px-4 py-2.5 text-sm transition-all",
                      active
                        ? "border border-cyan-400/20 bg-cyan-400/10 text-cyan-100 shadow-[0_12px_32px_rgba(0,0,0,0.22)]"
                        : "border border-transparent text-slate-400 hover:border-white/8 hover:bg-white/5 hover:text-white"
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            <div className="flex flex-wrap items-center gap-2 xl:justify-end">
              <Badge variant="outline" className="border-emerald-400/20 bg-emerald-400/10 text-emerald-100">
                Local-first
              </Badge>
              <Badge variant="outline" className="border-sky-400/20 bg-sky-400/10 text-sky-100">
                Postgres-centered
              </Badge>
              <Badge variant="outline" className="border-lime-300/20 bg-lime-300/10 text-lime-100">
                Temporal memory
              </Badge>
            </div>
          </div>
        </header>

        <main className="flex-1 rounded-[36px] border border-white/8 bg-[linear-gradient(180deg,_rgba(13,15,20,0.94)_0%,_rgba(8,10,15,0.96)_100%)] p-5 shadow-[0_24px_90px_rgba(0,0,0,0.45)] backdrop-blur lg:p-7">
          <header className="flex flex-col gap-4 border-b border-white/8 pb-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.34em] text-slate-500">{currentPath}</p>
              <h2 className="mt-2 text-4xl font-semibold tracking-tight text-white">{title}</h2>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-400">{subtitle}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="border-emerald-400/20 bg-emerald-400/10 text-emerald-100">
                Local-first
              </Badge>
              <Badge variant="outline" className="border-sky-400/20 bg-sky-400/10 text-sky-100">
                Postgres-centered
              </Badge>
              <Badge variant="outline" className="border-lime-300/20 bg-lime-300/10 text-lime-100">
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
