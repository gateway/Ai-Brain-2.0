import { runTemporalDifferentialBenchmarkCli } from "../benchmark/temporal-differential.js";

runTemporalDifferentialBenchmarkCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
