import { closePool } from "../db/client.js";
import { runRetrievalQuestionAuditCli } from "../benchmark/retrieval-question-audit.js";

let exitCode = 0;
try {
  await runRetrievalQuestionAuditCli();
} catch (error) {
  exitCode = 1;
  throw error;
} finally {
  await closePool();
}
process.exit(exitCode);
