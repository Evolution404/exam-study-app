import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const baseline = JSON.parse(readFileSync(join(root, "scripts/tools/code-size-baseline.json"), "utf8"));
const failures = [];

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

function bytes(path) {
  return statSync(path).size;
}

function repoPath(path) {
  return relative(root, path).replaceAll("\\", "/");
}

for (const [path, maxBytes] of Object.entries(baseline.tracked)) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) continue;
  const actual = bytes(absolute);
  if (actual > maxBytes) failures.push(`${path}: ${actual} > tracked baseline ${maxBytes}`);
}

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"]);
const tracked = new Set(Object.keys(baseline.tracked));
for (const path of walk(join(root, "src"))) {
  if (!sourceExtensions.has(extname(path))) continue;
  const name = repoPath(path);
  if (!tracked.has(name) && bytes(path) > baseline.thresholds.newSourceMaxBytes) {
    failures.push(`${name}: ${bytes(path)} exceeds new-source ceiling ${baseline.thresholds.newSourceMaxBytes}`);
  }
}

for (const path of walk(join(root, "scripts", "tests"))) {
  if (!sourceExtensions.has(extname(path))) continue;
  const name = repoPath(path);
  if (bytes(path) > baseline.thresholds.newTestMaxBytes) {
    failures.push(`${name}: ${bytes(path)} exceeds test ceiling ${baseline.thresholds.newTestMaxBytes}`);
  }
}

for (const path of walk(join(root, "src"))) {
  if (extname(path) !== ".css") continue;
  const name = repoPath(path);
  if (bytes(path) > baseline.thresholds.newCssMaxBytes) {
    failures.push(`${name}: ${bytes(path)} exceeds CSS ceiling ${baseline.thresholds.newCssMaxBytes}`);
  }
}

if (failures.length) {
  console.error("Code-size ratchet failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log("Code-size ratchet passed.");
