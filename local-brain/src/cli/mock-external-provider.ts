import { startMockExternalProvider } from "../mock/external-provider.js";

function parseArgs(argv: string[]): { host: string; port: number } {
  let host = "127.0.0.1";
  let port = 8090;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!arg.startsWith("--")) {
      continue;
    }
    if (value === undefined) {
      throw new Error(`Missing value for ${arg}`);
    }
    if (arg === "--host") {
      host = value;
    } else if (arg === "--port") {
      port = Number(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
    index += 1;
  }

  return { host, port };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await startMockExternalProvider(options);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

