import { runSourceIndependentSubstrateAdmissionBenchmarkCli } from "../benchmark/source-independent-substrate-admission.js";

runSourceIndependentSubstrateAdmissionBenchmarkCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
