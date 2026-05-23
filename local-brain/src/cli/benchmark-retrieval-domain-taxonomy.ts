import { runRetrievalDomainTaxonomyCli } from "../benchmark/retrieval-domain-taxonomy.js";

runRetrievalDomainTaxonomyCli().catch((error) => {
  console.error(error);
  process.exit(1);
});
