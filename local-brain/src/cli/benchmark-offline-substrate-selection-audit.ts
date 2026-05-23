import { runOfflineSubstrateSelectionAuditCli } from "../benchmark/offline-substrate-selection-audit.js";

runOfflineSubstrateSelectionAuditCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
