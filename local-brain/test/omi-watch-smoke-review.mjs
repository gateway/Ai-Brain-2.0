import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { omiWatchFixtureFiles, omiWatchFixtureRoot, prepareOmiWatchFixtureRoot } from "../dist/benchmark/omi-watch-fixture.js";

test("OMI watch fixture root is prepared as a bounded real-note subset", async () => {
  const prepared = await prepareOmiWatchFixtureRoot();

  assert.equal(prepared.rootPath, omiWatchFixtureRoot());
  assert.equal(prepared.fileCount, omiWatchFixtureFiles().length);

  await access(path.join(prepared.rootPath, ".DS_Store"));
  await access(path.join(prepared.rootPath, "2026/03/21/2026-03-21T11-09-33Z__omi__5501c431-8b0b-42ed-875b-16fc83cce027.md"));
  await access(path.join(prepared.rootPath, "2026/03/28/2026-03-28T08-52-32Z__omi__a6effac2-e74d-43b9-8b59-4bda0869c1d8.md"));
});
