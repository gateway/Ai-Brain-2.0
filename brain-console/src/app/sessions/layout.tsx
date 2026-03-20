import type { ReactNode } from "react";
import { requireSetupComplete } from "@/lib/setup-gating";

export const dynamic = "force-dynamic";

export default async function SessionsLayout({ children }: { readonly children: ReactNode }) {
  await requireSetupComplete("/sessions");
  return children;
}
