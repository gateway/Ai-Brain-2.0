import { runIngestionTortureCorpusCli } from "../benchmark/ingestion-torture-corpus.js";

runIngestionTortureCorpusCli().catch((error) => {
  console.error(error);
  process.exit(1);
});
