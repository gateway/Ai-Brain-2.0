import { runRetrievalLatencyProfileCli } from "../benchmark/retrieval-latency-profile.js";

runRetrievalLatencyProfileCli()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
