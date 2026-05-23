import { runReleaseCleanupReadinessPackCli } from "../benchmark/release-cleanup-readiness-pack.js";

runReleaseCleanupReadinessPackCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
