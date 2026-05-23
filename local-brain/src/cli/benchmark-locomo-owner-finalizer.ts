import { closePool } from "../db/client.js";
import { parseArtifactArg } from "../benchmark/locomo-diagnostics-utils.js";
import { runAndWriteLoCoMoOwnerFinalizer } from "../benchmark/locomo-owner-finalizer.js";

async function main(): Promise<void> {
  const { report, output } = await runAndWriteLoCoMoOwnerFinalizer({
    artifactPath: parseArtifactArg()
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        passed: report.passed,
        passRate: report.passRate,
        sourceStatus: report.sourceStatus,
        observedQuestionCount: report.observedQuestionCount,
        plannedQuestionCount: report.plannedQuestionCount,
        unknownOwnerCount: report.unknownOwnerCount,
        unsupportedNoEvidenceSuccessCount: report.unsupportedNoEvidenceSuccessCount,
        ownerBreakdown: report.ownerBreakdown,
        output
      },
      null,
      2
    )}\n`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
