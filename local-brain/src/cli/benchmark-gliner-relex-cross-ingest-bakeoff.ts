import { runGlinerRelexCrossIngestBakeoff } from "../benchmark/gliner-relex-bakeoff.js";
import { shutdownRelationIeSidecarWorker } from "../relationships/external-ie.js";

try {
  const report = await runGlinerRelexCrossIngestBakeoff();
  console.log(JSON.stringify({ passed: report.passed, artifactPath: report.artifactPath }, null, 2));
  process.exitCode = report.passed ? 0 : 1;
} finally {
  await shutdownRelationIeSidecarWorker();
}

