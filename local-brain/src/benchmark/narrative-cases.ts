import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceType } from "../types.js";

export interface NarrativeBenchmarkFile {
  readonly path: string;
  readonly source_type: SourceType;
  readonly source_channel?: string;
  readonly captured_at?: string;
}

export interface NarrativeBenchmarkQueryExpectation {
  readonly name: string;
  readonly query: string;
  readonly time_start?: string;
  readonly time_end?: string;
  readonly expect_top_types?: readonly string[];
  readonly expect_top_includes?: readonly string[];
}

export interface NarrativeBenchmarkEdgeExpectation {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
}

export interface NarrativeBenchmarkProceduralExpectation {
  readonly state_type: string;
  readonly state_key: string;
  readonly field: string;
  readonly equals: string;
}

export interface NarrativeBenchmarkCase {
  readonly name: string;
  readonly namespace_seed: string;
  readonly files: readonly NarrativeBenchmarkFile[];
  readonly queries?: readonly NarrativeBenchmarkQueryExpectation[];
  readonly expected: {
    readonly entities_present?: readonly { readonly name: string; readonly type?: string }[];
    readonly entities_absent?: readonly string[];
    readonly graph_edges_present?: readonly NarrativeBenchmarkEdgeExpectation[];
    readonly graph_edges_absent?: readonly NarrativeBenchmarkEdgeExpectation[];
    readonly procedural_states?: readonly NarrativeBenchmarkProceduralExpectation[];
  };
}

export interface LoadedNarrativeBenchmarkCase {
  readonly directory: string;
  readonly definition: NarrativeBenchmarkCase;
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function fixtureRoot(): string {
  return path.resolve(thisDir(), "../../examples/golden-stories");
}

export async function loadNarrativeBenchmarkCases(): Promise<readonly LoadedNarrativeBenchmarkCase[]> {
  const root = fixtureRoot();
  const directories = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort();

  const cases: LoadedNarrativeBenchmarkCase[] = [];
  for (const directory of directories) {
    const casePath = path.join(directory, "case.json");
    const raw = await readFile(casePath, "utf8");
    cases.push({
      directory,
      definition: JSON.parse(raw) as NarrativeBenchmarkCase
    });
  }

  return cases;
}
