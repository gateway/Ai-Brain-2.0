import Link from "next/link";
import type { ReactNode } from "react";
import { getBootstrapState } from "@/lib/operator-workbench";
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

export async function ConsoleShell({ title, subtitle, currentPath, children }: ConsoleShellProps) {
  const bootstrap = await getBootstrapState().catch(() => null);
  const onboardingOpen = !bootstrap?.progress.onboardingComplete;

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_right,_rgba(34,211,238,0.10),_transparent_20%),radial-gradient(circle_at_bottom_left,_rgba(99,102,241,0.10),_transparent_24%),linear-gradient(180deg,_#08090d_0%,_#0b0d12_42%,_#050608_100%)] text-slate-100">
      <div className="pointer-events-none fixed inset-0 opacity-16 [background-image:linear-gradient(rgba(255,255,255,0.022)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.022)_1px,transparent_1px)] [background-size:34px_34px]" />
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(255,255,255,0.06),transparent_18%),radial-gradient(circle_at_84%_18%,rgba(34,211,238,0.06),transparent_16%),radial-gradient(circle_at_90%_56%,rgba(255,255,255,0.06),transparent_14%)] opacity-70" />

      <div className="mx-auto flex min-h-screen max-w-[1880px] flex-col gap-4 px-3 py-3 lg:px-5 lg:py-4">
        <header className="overflow-hidden rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,_rgba(16,18,24,0.92)_0%,_rgba(10,12,16,0.9)_100%)] px-4 py-3 shadow-[0_20px_70px_rgba(0,0,0,0.34)] backdrop-blur-xl">
          <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/60 to-transparent" />
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-50">
                  Brain 2.0
                </div>
                <div className="min-w-0">
                  <p className="premium-eyebrow text-slate-300">Legacy console</p>
                  <h1 className="mt-1.5 text-[1.45rem] font-semibold tracking-[-0.04em] text-white sm:text-[1.7rem]">Local Cognitive Atlas</h1>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  href="/"
                  className="inline-flex min-h-10 items-center rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white hover:bg-white/10"
                >
                  Back to Workbench
                </Link>
                <Link
                  href="/setup"
                  className="inline-flex min-h-10 items-center rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-4 py-2 text-sm font-medium text-cyan-50 hover:border-cyan-300/35 hover:bg-cyan-300/16"
                >
                  Open setup
                </Link>
              </div>
            </div>

            {onboardingOpen ? (
              <div className="rounded-[18px] border border-cyan-300/25 bg-cyan-300/10 px-3 py-2 text-sm text-cyan-50">
                Initial setup is still open. Use <span className="font-medium text-white">Start Here</span> and <span className="font-medium text-white">Guided Setup</span> before relying on the legacy console as your main entry point.
              </div>
            ) : null}

            <details className="group md:hidden">
              <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white marker:content-none">
                <span>Console navigation</span>
                <span className="text-xs text-slate-300 transition group-open:rotate-180">⌄</span>
              </summary>
              <nav className="mt-2 grid gap-2 rounded-[22px] border border-white/8 bg-black/20 p-2">
                {navigation.map((item) => {
                  const active = item.href === currentPath;
                  return (
                    <Link
                      key={`mobile:${item.href}`}
                      href={item.href}
                      className={cn(
                        "inline-flex min-h-10 items-center rounded-2xl border px-4 py-2 text-sm font-medium transition-all",
                        active
                          ? "border-cyan-400/30 bg-cyan-400/12 text-white"
                          : "border-white/8 bg-white/5 text-slate-200 hover:border-white/12 hover:bg-white/8 hover:text-white"
                      )}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
            </details>

            <nav className="hidden w-full flex-wrap items-center justify-center gap-2 rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,_rgba(255,255,255,0.05)_0%,_rgba(255,255,255,0.03)_100%)] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_18px_50px_rgba(0,0,0,0.22)] md:flex">
              {navigation.map((item) => {
                const active = item.href === currentPath;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "inline-flex min-h-10 min-w-[108px] flex-1 items-center justify-center rounded-full px-3.5 py-2 text-[15px] font-medium tracking-[-0.01em] transition-all sm:flex-none",
                      active
                        ? "border border-cyan-400/30 bg-[linear-gradient(180deg,_rgba(34,211,238,0.18)_0%,_rgba(34,211,238,0.10)_100%)] text-white shadow-[0_14px_34px_rgba(8,145,178,0.18)]"
                        : "border border-transparent text-slate-100/95 hover:border-white/10 hover:bg-white/6 hover:text-white"
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        </header>

        <main className="flex-1 rounded-[36px] border border-white/8 bg-[linear-gradient(180deg,_rgba(13,15,20,0.9)_0%,_rgba(8,10,15,0.93)_100%)] p-4 shadow-[0_28px_110px_rgba(0,0,0,0.44)] backdrop-blur-xl lg:p-7">
          <header className="flex flex-col gap-4 border-b border-white/8 pb-6">
            <div>
              <p className="premium-eyebrow text-slate-300">{currentPath}</p>
              <h2 className="mt-3 text-[2.1rem] font-semibold tracking-[-0.04em] text-white lg:text-[2.9rem]">{title}</h2>
              <p className="mt-3 max-w-3xl text-base leading-8 text-slate-200">{subtitle}</p>
            </div>
          </header>
          {children}
        </main>
      </div>
    </div>
  );
}
