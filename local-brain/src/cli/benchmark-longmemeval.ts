import { closePool } from "../db/client.js";
import { runLongMemEvalBenchmarkCli } from "../benchmark/longmemeval.js";

try {
  await runLongMemEvalBenchmarkCli();
} finally {
  await closePool();
}
