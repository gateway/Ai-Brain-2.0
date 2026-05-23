import { runProductionReadinessBenchmarkCli } from "../benchmark/production-readiness.js";

runProductionReadinessBenchmarkCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
