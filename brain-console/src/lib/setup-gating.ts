import { redirect } from "next/navigation";
import { getBootstrapState } from "@/lib/operator-workbench";

export async function requireSetupComplete(redirectFrom: string): Promise<void> {
  const bootstrap = await getBootstrapState().catch(() => null);
  if (!bootstrap?.progress.onboardingComplete) {
    redirect(`/setup?blocked_from=${encodeURIComponent(redirectFrom)}`);
  }
}

export async function getSetupGateState(): Promise<{
  readonly onboardingComplete: boolean;
  readonly bootstrapExists: boolean;
}> {
  const bootstrap = await getBootstrapState().catch(() => null);
  return {
    onboardingComplete: Boolean(bootstrap?.progress.onboardingComplete),
    bootstrapExists: Boolean(bootstrap)
  };
}
