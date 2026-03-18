import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const localBrainRoot = path.resolve(process.cwd(), "../local-brain");

export async function runLocalBrainScript(script: "eval" | "benchmark:lexical"): Promise<void> {
  await execFileAsync("npm", ["run", script], {
    cwd: localBrainRoot,
    env: process.env
  });
}
