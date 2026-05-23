import { runOmiExtractionShadowBenchmarkCli } from "../benchmark/omi-extraction-shadow.js";

try {
  await runOmiExtractionShadowBenchmarkCli();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
