import type { QueryContract } from "./query-contract-router.js";

export type QueryVectorPolicyMode = "preferred" | "assisted" | "guarded";

export function queryVectorPolicy(queryContract: Pick<QueryContract, "contractName" | "retrievalDomain">): QueryVectorPolicyMode {
  switch (queryContract.contractName) {
    case "document_lookup":
    case "project_definition":
    case "procedure_lookup":
    case "source_audit":
      return "preferred";
    case "current_state":
    case "list_set":
    case "task_list":
    case "profile_report":
      return "assisted";
    case "relationship_chronology":
    case "relationship_map":
    case "shared_social_graph":
    case "temporal_event":
    case "review_only":
    case "abstention":
    case "direct_fact":
    default:
      return "guarded";
  }
}
