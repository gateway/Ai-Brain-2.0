import { runGlinerRelexCacheProfile } from "../benchmark/gliner-relex-cache-profile.js";

const report = await runGlinerRelexCacheProfile();
console.log(JSON.stringify({ passed: report.passed, artifactPath: report.artifactPath }, null, 2));
process.exitCode = report.passed ? 0 : 1;

