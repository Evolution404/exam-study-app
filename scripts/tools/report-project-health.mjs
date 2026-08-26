import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();

function walk(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function metrics(path) {
  const text = readFileSync(path, "utf8");
  return {
    path: relative(root, path),
    bytes: statSync(path).size,
    lines: text === "" ? 0 : text.split("\n").length,
  };
}

function top(paths, limit = 20) {
  return paths.map(metrics).sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

function printTable(title, rows) {
  console.log(`\n## ${title}`);
  console.log("| bytes | lines | path |");
  console.log("| ---: | ---: | --- |");
  for (const row of rows) console.log(`| ${row.bytes} | ${row.lines} | \`${row.path}\` |`);
}

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"]);
const source = walk(join(root, "src")).filter((path) => sourceExtensions.has(extname(path)));
const tests = walk(join(root, "scripts", "tests")).filter((path) => sourceExtensions.has(extname(path)));
const workflows = walk(join(root, ".github", "workflows")).filter((path) => /\.ya?ml$/i.test(path));

console.log("# Project health size report");
console.log("Report-only visibility: this command intentionally does not introduce arbitrary hard size limits. Existing CSS/export/dependency ratchets remain authoritative gates.");
printTable("Largest source files", top(source));
printTable("Largest test files", top(tests));
printTable("Workflow size", top(workflows, workflows.length));

const focus = [
  "src/app/shell/app-shell.tsx",
  "scripts/tests/test-browser-visible.mjs",
  "src/lib/sync/change-set-v7.ts",
  "src/lib/sync/change-set-v7-codec.ts",
  "src/lib/sync/change-set-v7-planning.ts",
  "src/lib/sync/sync-v7-checkpoint.ts",
  "src/lib/sync/sync-v7-checkpoint-validation.ts",
  "src/lib/sync/sync-v7-checkpoint-store.ts",
  "src/lib/sync/sync-v7-head.ts",
  "src/lib/sync/sync-v7-head-validation.ts",
  "src/lib/sync/sync-v7-head-operations.ts",
  "src/lib/sync/sync-v7-orchestrator.ts",
  "src/lib/sync/github-v7-remote.ts",
  "src/lib/sync/image-asset-pack.ts",
  ".github/workflows/deploy-pages.yml",
];
const focusRows = focus.map((path) => join(root, path)).filter(existsSync).map(metrics);
printTable("Tracked refactor focus", focusRows);
