import { runGlinerRelexPromotionDryRun } from "../benchmark/gliner-relex-promotion-dry-run.js";
import { shutdownRelationIeSidecarWorker } from "../relationships/external-ie.js";

try {
  const report = await runGlinerRelexPromotionDryRun();
  console.log(JSON.stringify({ passed: report.passed, artifactPath: report.artifactPath }, null, 2));
  process.exitCode = report.passed ? 0 : 1;
} finally {
  await shutdownRelationIeSidecarWorker();
}

