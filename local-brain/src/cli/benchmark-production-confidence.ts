import { runProductionConfidenceBenchmarkCli } from "../benchmark/production-confidence.js";

runProductionConfidenceBenchmarkCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
