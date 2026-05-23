import { closePool } from "../db/client.js";
import { rebuildRepoProcedureProjection } from "../retrieval/repo-corpus-reader.js";

try {
  const projection = await rebuildRepoProcedureProjection();
  process.stdout.write(
    `${JSON.stringify(
      {
        projectionVersion: projection.projectionVersion,
        generatedAt: projection.generatedAt,
        documentCount: projection.documents.length,
        packageScriptCount: projection.packageScripts.length
      },
      null,
      2
    )}\n`
  );
} finally {
  await closePool();
}
