import type { RecallResult } from "../types.js";
import { loadDirectWarmStartTopicResults } from "./direct-source-read-models.js";

export function loadWarmStartRecentContextResults(params: {
  readonly namespaceId: string;
  readonly limit: number;
}): Promise<readonly RecallResult[]> {
  return loadDirectWarmStartTopicResults(params);
}
