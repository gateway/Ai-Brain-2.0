import {
  cleanupStaleBenchmarkJobs,
  readBenchmarkJobRecordById,
  listBenchmarkJobRecords,
  type BenchmarkJobRecord
} from "../benchmark/benchmark-jobs.js";

function parseRunId(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--run-id") {
      return argv[index + 1] ?? null;
    }
  }
  return null;
}

const runId = parseRunId(process.argv.slice(2));
const cleanup = await cleanupStaleBenchmarkJobs();
let records: readonly BenchmarkJobRecord[];
if (runId) {
  const record = await readBenchmarkJobRecordById(runId);
  records = record ? [record] : [];
} else {
  records = await listBenchmarkJobRecords();
}

process.stdout.write(
  `${JSON.stringify(
    {
      cleanup,
      jobs: records
    },
    null,
    2
  )}\n`
);
