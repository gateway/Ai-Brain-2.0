import { closePool } from "../db/client.js";
import { runCorrectionReplaySurvivalPackCli } from "../benchmark/correction-replay-survival-pack.js";

try {
  await runCorrectionReplaySurvivalPackCli();
} finally {
  await closePool();
}
