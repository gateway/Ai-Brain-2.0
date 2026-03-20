"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { WorkbenchSession } from "@/lib/operator-workbench";
import { OperatorShell } from "@/components/operator-shell";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";

const sessionNavigation = [
  { href: "overview", label: "Overview" },
  { href: "intake", label: "Intake" },
  { href: "artifacts", label: "Artifacts" },
  { href: "text", label: "Text" },
  { href: "review", label: "Review" },
  { href: "clarifications", label: "Clarifications" },
  { href: "graph", label: "Graph" },
  { href: "timeline", label: "Timeline" },
  { href: "query", label: "Query" }
] as const;

export interface SessionShellProps {
  readonly session: WorkbenchSession;
  readonly title?: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
}

export function SessionShell({ session, title, subtitle, children }: SessionShellProps) {
  const currentPath = usePathname();
  const sessionBase = `/sessions/${session.id}`;

  return (
    <OperatorShell
      currentPath={currentPath}
      title={title ?? session.title}
      subtitle={subtitle ?? "Session-scoped intake, review, and correction flow on top of the AI Brain runtime."}
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4 rounded-[28px] border border-white/8 bg-white/4 p-5">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge status={session.status} />
              <span className="text-xs uppercase tracking-[0.22em] text-stone-400">{session.namespaceId}</span>
            </div>
            <div className="max-w-3xl text-sm leading-7 text-stone-300">
              {session.notes?.trim() || "No session notes yet. Use the intake page to add source material and start the review loop."}
            </div>
          </div>
          <div className="text-sm text-stone-400">
            <div>Created {new Date(session.createdAt).toLocaleString()}</div>
            <div>Updated {new Date(session.updatedAt).toLocaleString()}</div>
          </div>
        </div>

        <nav className="flex flex-wrap gap-2">
          {sessionNavigation.map((item) => {
            const href = `${sessionBase}/${item.href}`;
            const active = currentPath === href;
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "inline-flex items-center justify-center rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                  active
                    ? "border-emerald-300/30 bg-emerald-300/16 text-white"
                    : "border-white/10 bg-white/4 text-stone-300 hover:border-white/20 hover:bg-white/8 hover:text-white"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {children}
      </div>
    </OperatorShell>
  );
}
