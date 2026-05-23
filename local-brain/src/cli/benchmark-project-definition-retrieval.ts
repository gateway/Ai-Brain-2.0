import { runProjectDefinitionRetrievalCli } from "../benchmark/project-definition-retrieval.js";

runProjectDefinitionRetrievalCli().catch((error) => {
  console.error(error);
  process.exit(1);
});
