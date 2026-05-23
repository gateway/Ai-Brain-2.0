import { runProfileReportProjectionCoverageCli } from "../benchmark/profile-report-projection-coverage.js";

runProfileReportProjectionCoverageCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
