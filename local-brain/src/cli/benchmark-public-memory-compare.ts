import { closePool } from "../db/client.js";
import { runPublicMemoryCompareBenchmarkCli } from "../benchmark/public-memory-compare.js";

try {
  await runPublicMemoryCompareBenchmarkCli();
} finally {
  await closePool();
}
