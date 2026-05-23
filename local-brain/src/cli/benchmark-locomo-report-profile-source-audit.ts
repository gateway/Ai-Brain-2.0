import { closePool } from "../db/client.js";
import { runLoCoMoReportProfileSourceAuditCli } from "../benchmark/locomo-report-profile-source-audit.js";

runLoCoMoReportProfileSourceAuditCli()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
