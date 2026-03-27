import { closePool } from "../db/client.js";
import { runLoCoMoBenchmarkCli } from "../benchmark/locomo.js";

try {
  await runLoCoMoBenchmarkCli();
} finally {
  await closePool();
}
