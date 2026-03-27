import { runAndWriteMultimodalWorkerSmokeBenchmark } from "../benchmark/multimodal-worker-smoke.js";

const { report, output } = await runAndWriteMultimodalWorkerSmokeBenchmark();
console.log(JSON.stringify({ passed: report.passed, output }, null, 2));
process.exit(report.passed ? 0 : 1);
