#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const LOCAL_BRAIN_DIR = path.resolve(SCRIPT_DIR, "..");
const CONFIG_PATH = path.join(SCRIPT_DIR, "service-boundaries.json");

function usage() {
  console.error("usage: node scripts/guard-service-boundaries.mjs --check | --write-baseline");
  process.exit(1);
}

function relativePosix(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseSource(filePath) {
  return ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function collectTopLevelSymbols(sourceFile) {
  const symbols = [];
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      symbols.push(statement.name.text);
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      symbols.push(statement.name.text);
      continue;
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
      symbols.push(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, symbols);
      }
    }
  }
  return [...new Set(symbols)].sort();
}

function collectBindingNames(nameNode, target) {
  if (ts.isIdentifier(nameNode)) {
    target.push(nameNode.text);
    return;
  }
  if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const element of nameNode.elements) {
      if (ts.isBindingElement(element)) {
        collectBindingNames(element.name, target);
      }
    }
  }
}

function fileLineCount(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/u).length;
}

function findFunctionDeclaration(sourceFile, functionName) {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === functionName) {
      return statement;
    }
  }
  return null;
}

function functionCallsIdentifier(functionDeclaration, identifierName) {
  let found = false;
  function visit(node) {
    if (found) {
      return;
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === identifierName) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  if (functionDeclaration.body) {
    visit(functionDeclaration.body);
  }
  return found;
}

function collectTypeScriptFiles(rootPath) {
  const results = [];
  function walk(currentPath) {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        results.push(entryPath);
      }
    }
  }
  if (fs.existsSync(rootPath)) {
    walk(rootPath);
  }
  return results.sort();
}

function matchesGlobLike(relativePath, pattern) {
  if (!pattern.includes("*")) {
    return relativePath === pattern;
  }
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*\*/gu, "::DOUBLE_STAR::")
    .replace(/\*/gu, "[^/]*")
    .replace(/::DOUBLE_STAR::/gu, ".*");
  return new RegExp(`^${escaped}$`, "u").test(relativePath);
}

function resolveCap(relativePath, caps) {
  for (const [pattern, maxLines] of Object.entries(caps)) {
    if (matchesGlobLike(relativePath, pattern)) {
      return Number(maxLines);
    }
  }
  return null;
}

function buildBaselineConfig() {
  const servicePath = path.join(LOCAL_BRAIN_DIR, "src/retrieval/service.ts");
  const supportObjectsPath = path.join(LOCAL_BRAIN_DIR, "src/retrieval/support-objects.ts");
  const searchRoot = path.join(LOCAL_BRAIN_DIR, "src/retrieval/search");
  const retrievalRoot = path.join(LOCAL_BRAIN_DIR, "src/retrieval");
  const serviceSource = parseSource(servicePath);
  const fileCaps = {
    "src/retrieval/service.ts": fileLineCount(servicePath),
    "src/retrieval/support-objects.ts": fileLineCount(supportObjectsPath),
    "src/retrieval/search/runtime.ts": 2000,
    "src/retrieval/search/**/*.ts": 1500,
    "src/retrieval/candidate-assembly/**/*.ts": 1200,
    "src/retrieval/typed-contract-registry.ts": 1200,
    "src/retrieval/typed-contract-completeness.ts": 1500,
    "src/retrieval/typed-backfill-engine.ts": 1000,
    "src/retrieval/artifact-derivation-search.ts": 1000,
    "src/retrieval/book-list-support.ts": 1000,
    "src/retrieval/typed-render-contracts.ts": 1500,
    "src/retrieval/typed-backfill-policy.ts": 1500,
    "src/retrieval/typed-support-extractors.ts": 1200,
    "src/retrieval/contract-first-runtime-policy.ts": 1000,
    "src/retrieval/retrieval-controller.ts": 1500,
    "src/retrieval/retrieval-controller-types.ts": 1000,
    "src/retrieval/planner-intent-budgets.ts": 1000,
    "src/retrieval/profile-contracts.ts": 1000,
    "src/retrieval/location-history/**/*.ts": 1000,
    "src/retrieval/temporal/pair-event-gating.ts": 1000
  };
  return {
    serviceFile: "src/retrieval/service.ts",
    maxLines: fileLineCount(servicePath),
    supportObjectsFile: "src/retrieval/support-objects.ts",
    maxSupportObjectsLines: fileLineCount(supportObjectsPath),
    allowedTopLevelSymbols: collectTopLevelSymbols(serviceSource),
    delegationRequirements: {
      searchMemoryMustCall: "runSearchMemory"
    },
    fileCaps,
    trackedRetrievalFiles: collectTypeScriptFiles(retrievalRoot)
      .map((filePath) => relativePosix(LOCAL_BRAIN_DIR, filePath))
      .filter((relativePath) => resolveCap(relativePath, fileCaps) !== null)
  };
}

function checkConfig(config) {
  const failures = [];
  const servicePath = path.join(LOCAL_BRAIN_DIR, config.serviceFile);
  const serviceSource = parseSource(servicePath);
  const serviceLineCount = fileLineCount(servicePath);
  if (serviceLineCount > Number(config.maxLines)) {
    failures.push(`${config.serviceFile} grew to ${serviceLineCount} lines (max ${config.maxLines})`);
  }
  const supportObjectsFile = config.supportObjectsFile;
  const maxSupportObjectsLines = Number(config.maxSupportObjectsLines ?? 0);
  if (supportObjectsFile && maxSupportObjectsLines > 0) {
    const supportObjectsPath = path.join(LOCAL_BRAIN_DIR, supportObjectsFile);
    const supportObjectsLineCount = fileLineCount(supportObjectsPath);
    if (supportObjectsLineCount > maxSupportObjectsLines) {
      failures.push(`${supportObjectsFile} grew to ${supportObjectsLineCount} lines (max ${maxSupportObjectsLines})`);
    }
  }

  const currentSymbols = collectTopLevelSymbols(serviceSource);
  const allowedSymbols = new Set(config.allowedTopLevelSymbols);
  const unexpectedSymbols = currentSymbols.filter((symbol) => !allowedSymbols.has(symbol));
  if (unexpectedSymbols.length > 0) {
    failures.push(`${config.serviceFile} has new top-level symbols: ${unexpectedSymbols.join(", ")}`);
  }

  const searchMemoryDecl = findFunctionDeclaration(serviceSource, "searchMemory");
  const requiredCallee = config.delegationRequirements?.searchMemoryMustCall;
  if (!searchMemoryDecl) {
    failures.push(`searchMemory function is missing from ${config.serviceFile}`);
  } else if (requiredCallee && !functionCallsIdentifier(searchMemoryDecl, requiredCallee)) {
    failures.push(`searchMemory must delegate to ${requiredCallee}`);
  }

  const retrievalFiles = collectTypeScriptFiles(path.join(LOCAL_BRAIN_DIR, "src/retrieval"));
  for (const filePath of retrievalFiles) {
    const relativePath = relativePosix(LOCAL_BRAIN_DIR, filePath);
    const maxLines = resolveCap(relativePath, config.fileCaps ?? {});
    if (maxLines !== null) {
      const count = fileLineCount(filePath);
      if (count > maxLines) {
        failures.push(`${relativePath} is ${count} lines (max ${maxLines})`);
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`[guard:service-boundaries] ${failure}`);
    }
    process.exit(1);
  }

  console.log("[guard:service-boundaries] ok");
}

const mode = process.argv[2];
if (mode === "--write-baseline") {
  writeJson(CONFIG_PATH, buildBaselineConfig());
  console.log(`[guard:service-boundaries] wrote baseline to ${CONFIG_PATH}`);
} else if (mode === "--check") {
  checkConfig(readJson(CONFIG_PATH));
} else {
  usage();
}
