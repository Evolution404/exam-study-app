import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileBytes, repoPath, root, sourceExtensions, walk } from "./code-size-utils.mjs";

const baseline = JSON.parse(readFileSync(join(root, "scripts/tools/code-size-baseline.json"), "utf8"));
const failures = [];

for (const [path, maxBytes] of Object.entries(baseline.tracked)) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) continue;
  const actual = fileBytes(absolute);
  if (actual > maxBytes) failures.push(`${path}: ${actual} > tracked baseline ${maxBytes}`);
}

const tracked = new Set(Object.keys(baseline.tracked));
for (const path of walk(join(root, "src"))) {
  if (!sourceExtensions.has(extname(path))) continue;
  const name = repoPath(path);
  if (!tracked.has(name) && fileBytes(path) > baseline.thresholds.newSourceMaxBytes) {
    failures.push(`${name}: ${fileBytes(path)} exceeds new-source ceiling ${baseline.thresholds.newSourceMaxBytes}`);
  }
}

for (const path of walk(join(root, "scripts", "tests"))) {
  if (!sourceExtensions.has(extname(path))) continue;
  const name = repoPath(path);
  if (fileBytes(path) > baseline.thresholds.newTestMaxBytes) {
    failures.push(`${name}: ${fileBytes(path)} exceeds test ceiling ${baseline.thresholds.newTestMaxBytes}`);
  }
}

for (const path of walk(join(root, "src"))) {
  if (extname(path) !== ".css") continue;
  const name = repoPath(path);
  if (fileBytes(path) > baseline.thresholds.newCssMaxBytes) {
    failures.push(`${name}: ${fileBytes(path)} exceeds CSS ceiling ${baseline.thresholds.newCssMaxBytes}`);
  }
}

if (failures.length) {
  console.error("Code-size ratchet failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log("Code-size ratchet passed.");
