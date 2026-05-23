import { closePool } from "../db/client.js";
import { runLongMemWarmProofCli } from "../benchmark/longmem-warm-proof.js";

let exitCode = 0;
try {
  await runLongMemWarmProofCli();
} catch (error) {
  exitCode = 1;
  throw error;
} finally {
  await closePool();
}
process.exit(exitCode);
