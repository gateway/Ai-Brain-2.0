import { closePool } from "../db/client.js";
import { runAnswerShapingPackCli } from "../benchmark/answer-shaping-pack.js";

let exitCode = 0;
try {
  await runAnswerShapingPackCli();
} catch (error) {
  exitCode = 1;
  throw error;
} finally {
  await closePool();
}
process.exit(exitCode);
