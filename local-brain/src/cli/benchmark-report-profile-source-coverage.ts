import { closePool } from "../db/client.js";
import { runReportProfileSourceCoverageCli } from "../benchmark/report-profile-source-coverage.js";

runReportProfileSourceCoverageCli()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
