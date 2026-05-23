import { runTemporalNormitComparisonBenchmarkCli } from "../benchmark/temporal-normit-comparison.js";

runTemporalNormitComparisonBenchmarkCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
