import { runNamespaceLocalSubstrateCoverageBenchmarkCli } from "../benchmark/namespace-local-substrate-coverage.js";

runNamespaceLocalSubstrateCoverageBenchmarkCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
