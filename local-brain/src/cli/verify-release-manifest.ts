import fs from "node:fs";
import path from "node:path";

type ExpectedField = {
  path: string;
  equals?: unknown;
  gte?: number;
  lte?: number;
};

type ManifestArtifact = {
  id: string;
  path: string;
  requiredFields?: string[];
  expectedFields?: ExpectedField[];
};

type ReleaseManifest = {
  artifactSchemaVersion: string;
  generatedAt: string;
  artifacts: ManifestArtifact[];
};

function parseArgs(): { manifestPath: string } {
  const manifestFlagIndex = process.argv.indexOf("--manifest");
  const manifestPath =
    manifestFlagIndex >= 0
      ? process.argv[manifestFlagIndex + 1]
      : "benchmark-results/release-manifest-phase0-baseline-2026-05-21.json";

  if (!manifestPath) {
    throw new Error("Missing value for --manifest");
  }

  return { manifestPath };
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getField(input: unknown, fieldPath: string): unknown {
  return fieldPath.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, input);
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function assertExpectedField(
  artifactId: string,
  artifactJson: unknown,
  expected: ExpectedField,
): string[] {
  const failures: string[] = [];
  const actual = getField(artifactJson, expected.path);

  if (actual === undefined) {
    return [`${artifactId}: expected field ${expected.path} is missing`];
  }

  if ("equals" in expected && actual !== expected.equals) {
    failures.push(
      `${artifactId}: expected ${expected.path}=${formatValue(expected.equals)}, got ${formatValue(actual)}`,
    );
  }

  if (expected.gte !== undefined) {
    if (typeof actual !== "number" || actual < expected.gte) {
      failures.push(`${artifactId}: expected ${expected.path} >= ${expected.gte}, got ${formatValue(actual)}`);
    }
  }

  if (expected.lte !== undefined) {
    if (typeof actual !== "number" || actual > expected.lte) {
      failures.push(`${artifactId}: expected ${expected.path} <= ${expected.lte}, got ${formatValue(actual)}`);
    }
  }

  return failures;
}

const { manifestPath } = parseArgs();
const cwd = process.cwd();
const resolvedManifestPath = path.resolve(cwd, manifestPath);
const manifest = readJson(resolvedManifestPath) as ReleaseManifest;

if (!Array.isArray(manifest.artifacts)) {
  throw new Error(`Manifest ${resolvedManifestPath} does not contain an artifacts array`);
}

const failures: string[] = [];
const manifestDir = path.dirname(resolvedManifestPath);

for (const artifact of manifest.artifacts) {
  const artifactPath = path.isAbsolute(artifact.path)
    ? artifact.path
    : path.resolve(manifestDir, artifact.path);

  if (!fs.existsSync(artifactPath)) {
    failures.push(`${artifact.id}: artifact file is missing: ${artifactPath}`);
    continue;
  }

  let artifactJson: unknown;
  try {
    artifactJson = readJson(artifactPath);
  } catch (error) {
    failures.push(`${artifact.id}: artifact JSON parse failed: ${(error as Error).message}`);
    continue;
  }

  for (const fieldPath of artifact.requiredFields ?? []) {
    if (getField(artifactJson, fieldPath) === undefined) {
      failures.push(`${artifact.id}: required field ${fieldPath} is missing`);
    }
  }

  for (const expected of artifact.expectedFields ?? []) {
    failures.push(...assertExpectedField(artifact.id, artifactJson, expected));
  }
}

if (failures.length > 0) {
  console.error(`Release manifest verification failed: ${failures.length} issue(s)`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Release manifest verified: ${manifest.artifacts.length} artifact(s), schema=${manifest.artifactSchemaVersion}, generatedAt=${manifest.generatedAt}`,
);

