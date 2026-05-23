import { runIngestionDbCoverageCli } from "../benchmark/ingestion-db-coverage.js";

runIngestionDbCoverageCli().catch((error) => {
  console.error(error);
  process.exit(1);
});
