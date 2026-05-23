import { closePool } from "../db/client.js";
import { runLongMemCompilerCoverageCli } from "../benchmark/longmem-compiler-coverage.js";

let exitCode = 0;
try {
  await runLongMemCompilerCoverageCli();
} catch (error) {
  exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
} finally {
  await closePool();
}

process.exit(exitCode);
