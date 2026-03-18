import { runAndWriteNarrativeBenchmark } from "../benchmark/narrative-quality.js";

async function main(): Promise<void> {
  const result = await runAndWriteNarrativeBenchmark();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
