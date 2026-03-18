import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default function ConsoleLayout({ children }: { readonly children: ReactNode }) {
  return children;
}
