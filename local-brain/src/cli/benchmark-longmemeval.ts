import { closePool } from "../db/client.js";
import { runLongMemEvalBenchmarkCli } from "../benchmark/longmemeval.js";

let exitCode = 0;
try {
  await runLongMemEvalBenchmarkCli();
} catch (error) {
  exitCode = 1;
  throw error;
} finally {
  await closePool();
}
process.exit(exitCode);
