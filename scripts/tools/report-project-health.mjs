import { existsSync } from "node:fs";
import { dirname, extname, join, sep } from "node:path";
import { fileMetrics, root, sourceExtensions, walk } from "./code-size-utils.mjs";

function top(rows, limit = 20) {
  return [...rows].sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

function totals(rows) {
  return rows.reduce((sum, row) => ({
    files: sum.files + 1,
    bytes: sum.bytes + row.bytes,
    lines: sum.lines + row.lines,
  }), { files: 0, bytes: 0, lines: 0 });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function printFileTable(title, rows) {
  console.log(`\n## ${title}`);
  console.log("| bytes | lines | path |");
  console.log("| ---: | ---: | --- |");
  for (const row of rows) console.log(`| ${row.bytes} | ${row.lines} | \`${row.path}\` |`);
}

function printSummaryTable(groups) {
  console.log("\n## Repository code totals");
  console.log("| scope | files | bytes | size | lines | >= 20 KiB | >= 15 KiB |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const [name, rows] of groups) {
    const total = totals(rows);
    console.log(`| ${name} | ${total.files} | ${total.bytes} | ${formatBytes(total.bytes)} | ${total.lines} | ${rows.filter((row) => row.bytes >= 20 * 1024).length} | ${rows.filter((row) => row.bytes >= 15 * 1024).length} |`);
  }
}

function directoryKey(path, depth = 3) {
  const parts = dirname(path).split(sep).filter(Boolean);
  return parts.slice(0, depth).join("/") || ".";
}

function aggregateDirectories(rows, depth = 3) {
  const groups = new Map();
  for (const row of rows) {
    const key = directoryKey(row.path, depth);
    const current = groups.get(key) ?? { path: key, files: 0, bytes: 0, lines: 0 };
    current.files += 1;
    current.bytes += row.bytes;
    current.lines += row.lines;
    groups.set(key, current);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
}

function printDirectoryTable(title, rows, limit = 20) {
  console.log(`\n## ${title}`);
  console.log("| bytes | size | lines | files | directory |");
  console.log("| ---: | ---: | ---: | ---: | --- |");
  for (const row of rows.slice(0, limit)) {
    console.log(`| ${row.bytes} | ${formatBytes(row.bytes)} | ${row.lines} | ${row.files} | \`${row.path}\` |`);
  }
}

const codeFiles = (dir) => walk(join(root, dir)).filter((path) => sourceExtensions.has(extname(path))).map(fileMetrics);
const source = codeFiles("src");
const tests = codeFiles(join("scripts", "tests"));
const tools = codeFiles(join("scripts", "tools"));
const css = walk(join(root, "src")).filter((path) => extname(path) === ".css").map(fileMetrics);
const workflows = walk(join(root, ".github", "workflows")).filter((path) => /\.ya?ml$/i.test(path)).map(fileMetrics);

console.log("# Project health size report");
console.log("Report-only visibility: this command intentionally does not introduce arbitrary hard size limits. Existing CSS/export/dependency ratchets remain authoritative gates.");
printSummaryTable([
  ["src code", source],
  ["tests", tests],
  ["tools", tools],
  ["src CSS", css],
  ["workflows", workflows],
]);
printDirectoryTable("Largest source directory concentrations", aggregateDirectories(source));
printDirectoryTable("Largest test directory concentrations", aggregateDirectories(tests));
printFileTable("Largest source files", top(source));
printFileTable("Largest test files", top(tests));
printFileTable("Largest CSS files", top(css));
printFileTable("Workflow size", top(workflows, workflows.length));

const focus = [
  "src/app/shell/app-shell.tsx",
  "scripts/tests/test-browser-visible.mjs",
  "src/app/search/search-view.tsx",
  "src/app/practice/practice-setup.tsx",
  "src/app/shell/views/practice.tsx",
  "src/lib/io/xlsx-import.ts",
  "src/lib/sync/change-set-v7-codec.ts",
  "src/lib/sync/change-set-v7-planning.ts",
  "src/lib/sync/change-set-v7-reducer.ts",
  "src/lib/sync/sync-v7-checkpoint-validation.ts",
  "src/lib/sync/sync-v7-checkpoint-store.ts",
  "src/lib/sync/sync-v7-head-validation.ts",
  "src/lib/sync/sync-v7-head-operations.ts",
  "src/lib/sync/sync-v7-orchestrator.ts",
  "src/lib/sync/github-v7-remote.ts",
  "src/lib/sync/image-asset-pack.ts",
  ".github/workflows/deploy-pages.yml",
];
const focusRows = focus.map((path) => join(root, path)).filter(existsSync).map(fileMetrics);
printFileTable("Tracked refactor focus", focusRows);
