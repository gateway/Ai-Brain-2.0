import { runAndWriteLexicalBenchmark } from "../benchmark/lexical.js";

async function main(): Promise<void> {
  const result = await runAndWriteLexicalBenchmark();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

