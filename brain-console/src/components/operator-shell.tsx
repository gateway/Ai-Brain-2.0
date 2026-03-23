import Link from "next/link";
import type { ReactNode } from "react";
import { getBootstrapState } from "@/lib/operator-workbench";
import { cn } from "@/lib/utils";

const fullNavigation = [
  { href: "/", label: "Dashboard" },
  { href: "/setup", label: "Start Here" },
  { href: "/bootstrap", label: "Guided Setup" },
  { href: "/help", label: "Docs" },
  { href: "/knowledge", label: "What It Knows" },
  { href: "/sessions", label: "Sessions" },
  { href: "/clarifications", label: "Clarifications" },
  { href: "/sources", label: "Sources" },
  { href: "/runtime", label: "Runtime" },
  { href: "/models", label: "Models" },
  { href: "/settings", label: "Settings" },
  { href: "/audit", label: "Audit" },
  { href: "/console", label: "Legacy Console" }
] as const;

const onboardingNavigation = [
  { href: "/", label: "Dashboard" },
  { href: "/setup", label: "Start Here" },
  { href: "/bootstrap", label: "Guided Setup" },
  { href: "/knowledge", label: "What It Knows" },
  { href: "/clarifications", label: "Clarifications" },
  { href: "/help", label: "Docs" },
  { href: "/settings", label: "Settings" }
] as const;

export interface OperatorShellProps {
  readonly title: string;
  readonly subtitle: string;
  readonly currentPath: string;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
}

export async function OperatorShell({ title, subtitle, currentPath, children, actions }: OperatorShellProps) {
  const bootstrap = await getBootstrapState().catch(() => null);
  const onboardingOpen = !bootstrap?.progress.onboardingComplete;
  const navigation = onboardingOpen ? onboardingNavigation : fullNavigation;

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(244,162,97,0.10),_transparent_18%),radial-gradient(circle_at_top_right,_rgba(42,157,143,0.12),_transparent_20%),linear-gradient(180deg,_#0c0f13_0%,_#11161b_38%,_#090b0f_100%)] text-stone-100">
      <div className="pointer-events-none fixed inset-0 opacity-15 [background-image:linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] [background-size:34px_34px]" />
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_16%_10%,rgba(255,255,255,0.06),transparent_18%),radial-gradient(circle_at_84%_16%,rgba(34,211,238,0.07),transparent_17%),radial-gradient(circle_at_60%_90%,rgba(245,158,11,0.05),transparent_18%)] opacity-70" />
      <div className="mx-auto flex min-h-screen max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-4 lg:px-6 lg:py-4">
        <header className="overflow-hidden rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,_rgba(14,16,20,0.88)_0%,_rgba(10,12,16,0.82)_100%)] px-4 py-3 shadow-[0_20px_60px_rgba(0,0,0,0.26)] backdrop-blur-xl sm:px-5">
          <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-cyan-200/55 to-transparent" />
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="premium-eyebrow text-stone-300">AI Brain 2.0</p>
                <h1 className="mt-1.5 text-[1.45rem] font-semibold tracking-[-0.04em] text-white sm:text-[1.7rem]">Operator Workbench</h1>
              </div>
              <div className="flex flex-wrap items-center gap-2">{actions}</div>
            </div>

            {onboardingOpen ? (
              <p className="text-sm text-cyan-50">
                Setup is still in progress. Start at <span className="font-medium text-white">Start Here</span>, then move through <span className="font-medium text-white">Guided Setup</span>.
              </p>
            ) : null}

            <details className="group md:hidden">
              <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white marker:content-none">
                <span>Navigation</span>
                <span className="text-xs text-stone-300 transition group-open:rotate-180">⌄</span>
              </summary>
              <nav className="mt-2 grid gap-2 rounded-[22px] border border-white/8 bg-black/20 p-2">
                {navigation.map((item) => {
                  const active = currentPath === item.href || (item.href !== "/" && currentPath.startsWith(item.href));
                  return (
                    <Link
                      key={`mobile:${item.href}`}
                      href={item.href}
                      className={cn(
                        "inline-flex min-h-10 items-center rounded-2xl border px-4 py-2 text-sm font-medium transition-all",
                        active
                          ? "border-amber-300/30 bg-amber-300/16 text-white"
                          : "border-white/8 bg-white/5 text-stone-300 hover:border-white/14 hover:bg-white/8 hover:text-white"
                      )}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
            </details>

            <nav className="hidden flex-wrap items-center gap-2 md:flex">
              {navigation.map((item) => {
                const active = currentPath === item.href || (item.href !== "/" && currentPath.startsWith(item.href));
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "inline-flex min-h-10 items-center justify-center rounded-full border px-3.5 py-2 text-sm font-medium transition-all",
                      active
                        ? "border-amber-300/30 bg-amber-300/16 text-white shadow-[0_12px_28px_rgba(245,158,11,0.12)]"
                        : "border-white/10 bg-white/4 text-stone-300 hover:border-white/20 hover:bg-white/8 hover:text-white"
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        </header>

        <main className="flex-1 rounded-[36px] border border-white/8 bg-[linear-gradient(180deg,_rgba(10,12,16,0.74)_0%,_rgba(7,8,12,0.68)_100%)] p-4 shadow-[0_28px_110px_rgba(0,0,0,0.42)] backdrop-blur-xl sm:p-5 lg:p-7">
          <header className="border-b border-white/8 pb-6">
            <p className="premium-eyebrow text-stone-400">{currentPath}</p>
            <h2 className="mt-3 text-[2rem] font-semibold tracking-[-0.04em] text-white lg:text-[2.8rem]">{title}</h2>
            <p className="mt-3 max-w-3xl text-[15px] leading-8 text-stone-300">{subtitle}</p>
          </header>
          <div className="pt-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
