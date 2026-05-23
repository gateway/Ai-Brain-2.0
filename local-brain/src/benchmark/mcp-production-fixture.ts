import path from "node:path";
import { fileURLToPath } from "node:url";

const MCP_PRODUCTION_OMI_RELATIVE_FILES = [
  "2026/03/21/2026-03-21T13-00-09Z__omi__3e3c9cfb-aa5a-43c9-aeb2-3a7254fcafc8.md",
  "2026/03/21/2026-03-21T13-08-01Z__omi__6113df6e-edf1-4bc1-b97e-7be19d046679.md",
  "2026/03/21/2026-03-21T16-41-27Z__omi__c1960ba3-9e0a-4a46-aeed-9c9f832c32da.md",
  "2026/03/27/2026-03-27T03-36-47Z__omi__73f02876-22d9-485c-964f-6e4a92152b71.md",
  "2026/03/27/2026-03-27T03-39-39Z__omi__bc4abaa1-170d-4cb0-bb29-ed3484ee39e8.md",
  "2026/03/27/2026-03-27T03-44-24Z__omi__97364493-9f90-46ac-b414-1062c729fc90.md",
  "2026/03/27/2026-03-27T03-55-31Z__omi__3e1e19c6-2d94-426a-bfa2-3ddcb06e8227.md",
  "2026/03/27/2026-03-27T07-41-31Z__omi__19fdfdfb-d639-423b-be65-9edd11f727a3.md",
  "2026/03/27/2026-03-27T09-26-00Z__omi__5bbdc452-3df3-44b3-b315-1c69366fab54.md",
  "2026/03/27/2026-03-27T11-44-14Z__omi__90c30a66-d896-40c9-9bea-3939c5129570.md",
  "2026/03/28/2026-03-28T01-29-10Z__omi__ce78791a-9a8b-4949-88b6-15d6a6f2598c.md",
  "2026/03/28/2026-03-28T06-37-19Z__omi__8b01a9dd-50e9-4eee-8df7-756bc0c7048d.md",
  "2026/03/28/2026-03-28T08-52-32Z__omi__a6effac2-e74d-43b9-8b59-4bda0869c1d8.md",
  "2026/03/28/2026-03-28T09-43-07Z__omi__eb86d6a9-8a10-430b-a30a-ee4df85b4f8d.md"
] as const;

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

function repoRoot(): string {
  return path.resolve(localBrainRoot(), "..");
}

function omiNormalizedRoot(): string {
  return path.resolve(repoRoot(), "data/inbox/omi/normalized");
}

export function mcpProductionOmiRelativeFiles(): readonly string[] {
  return MCP_PRODUCTION_OMI_RELATIVE_FILES;
}

export function mcpProductionOmiFixtureFiles(): readonly string[] {
  return MCP_PRODUCTION_OMI_RELATIVE_FILES.map((entry) => path.join(omiNormalizedRoot(), entry));
}

export function capturedAtFromOmiRelativePath(relativePath: string): string {
  const stamp = path.basename(relativePath).split("__")[0] ?? "";
  return stamp.replace(/T(\d{2})-(\d{2})-(\d{2})Z$/u, "T$1:$2:$3Z");
}
