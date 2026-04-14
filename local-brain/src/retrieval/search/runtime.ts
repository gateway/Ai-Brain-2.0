import type { RecallQuery, RecallResponse } from "../types.js";
import { currentRuntimeRequestContext, runWithRuntimeRequestContext } from "./context.js";

export async function runSearchMemory(
  query: RecallQuery,
  executeSearchMemory: (query: RecallQuery) => Promise<RecallResponse>
): Promise<RecallResponse> {
  const runtimeContext = currentRuntimeRequestContext();
  if (runtimeContext) {
    return executeSearchMemory(query);
  }

  const runtimeRequestKey =
    query.runtimeRequestKey ??
    `${query.namespaceId}:${Date.now().toString(36)}:${Math.random().toString(16).slice(2, 10)}`;

  return runWithRuntimeRequestContext(runtimeRequestKey, () =>
    executeSearchMemory({
      ...query,
      runtimeRequestKey
    })
  );
}
