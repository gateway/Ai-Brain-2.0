import { closePool } from "../db/client.js";
import { runAdversarialNegativeAnswerPackCli } from "../benchmark/adversarial-negative-answer-pack.js";

try {
  await runAdversarialNegativeAnswerPackCli();
} finally {
  await closePool();
}
