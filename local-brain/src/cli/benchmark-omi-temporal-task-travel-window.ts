import { closePool } from "../db/client.js";
import {
  runOmiTemporalTaskTravelWindowBenchmark,
  writeOmiTemporalTaskTravelWindowReport
} from "../benchmark/omi-temporal-task-travel-window.js";

async function main(): Promise<void> {
  const namespaceId = process.argv[2] ?? "personal";
  const report = await runOmiTemporalTaskTravelWindowBenchmark(namespaceId);
  const paths = await writeOmiTemporalTaskTravelWindowReport(report);
  console.log(JSON.stringify({ report, paths }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => undefined);
  });
