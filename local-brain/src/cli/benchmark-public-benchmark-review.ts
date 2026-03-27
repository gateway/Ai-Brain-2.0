import { closePool } from "../db/client.js";
import { runPublicBenchmarkReviewCli } from "../benchmark/public-benchmark-review.js";

try {
  await runPublicBenchmarkReviewCli();
} finally {
  await closePool();
}
