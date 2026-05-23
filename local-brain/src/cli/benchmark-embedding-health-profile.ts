import { runEmbeddingHealthProfileCli } from "../benchmark/embedding-health-profile.js";

runEmbeddingHealthProfileCli().catch((error) => {
  console.error(error);
  process.exit(1);
});

