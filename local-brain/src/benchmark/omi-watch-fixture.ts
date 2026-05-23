import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_RELATIVE_FILES = [
  "2026/03/22/2026-03-22T11-36-47Z__omi__a6282ad4-b06b-4384-99d3-e3fc7cc57c5d.md",
  "2026/03/21/2026-03-21T11-09-33Z__omi__5501c431-8b0b-42ed-875b-16fc83cce027.md",
  "2026/03/21/2026-03-21T11-41-56Z__omi__fa0bf310-64a2-4f55-a4fc-c8eb5a41aecc.md",
  "2026/03/21/2026-03-21T13-00-09Z__omi__3e3c9cfb-aa5a-43c9-aeb2-3a7254fcafc8.md",
  "2026/03/21/2026-03-21T13-06-28Z__omi__6dfddedf-a29b-48fe-ba4f-4284e7dda1c9.md",
  "2026/03/21/2026-03-21T13-08-01Z__omi__6113df6e-edf1-4bc1-b97e-7be19d046679.md",
  "2026/03/21/2026-03-21T16-41-27Z__omi__c1960ba3-9e0a-4a46-aeed-9c9f832c32da.md",
  "2026/03/27/2026-03-27T03-39-39Z__omi__bc4abaa1-170d-4cb0-bb29-ed3484ee39e8.md",
  "2026/03/27/2026-03-27T03-43-33Z__omi__c267ad28-741c-4f46-8b5f-e8b9c6464f03.md",
  "2026/03/27/2026-03-27T03-44-24Z__omi__97364493-9f90-46ac-b414-1062c729fc90.md",
  "2026/03/27/2026-03-27T09-26-00Z__omi__5bbdc452-3df3-44b3-b315-1c69366fab54.md",
  "2026/03/27/2026-03-27T11-44-14Z__omi__90c30a66-d896-40c9-9bea-3939c5129570.md",
  "2026/03/28/2026-03-28T01-29-10Z__omi__ce78791a-9a8b-4949-88b6-15d6a6f2598c.md",
  "2026/03/28/2026-03-28T08-52-32Z__omi__a6effac2-e74d-43b9-8b59-4bda0869c1d8.md"
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

function sourceRoot(): string {
  return path.resolve(repoRoot(), "data/inbox/omi/normalized");
}

export function omiWatchFixtureRoot(): string {
  return path.resolve(localBrainRoot(), "benchmark-fixtures/omi-watch-smoke");
}

export function omiWatchFixtureFiles(): readonly string[] {
  return FIXTURE_RELATIVE_FILES.map((entry) => path.join(sourceRoot(), entry));
}

export async function prepareOmiWatchFixtureRoot(): Promise<{
  readonly rootPath: string;
  readonly fileCount: number;
}> {
  const fixtureRoot = omiWatchFixtureRoot();
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });
  await writeFile(path.join(fixtureRoot, ".DS_Store"), "fixture\n", "utf8");

  for (const relativePath of FIXTURE_RELATIVE_FILES) {
    const sourcePath = path.join(sourceRoot(), relativePath);
    const targetPath = path.join(fixtureRoot, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
  }

  return {
    rootPath: fixtureRoot,
    fileCount: FIXTURE_RELATIVE_FILES.length
  };
}
