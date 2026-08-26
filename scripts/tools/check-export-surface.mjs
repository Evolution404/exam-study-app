import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let unusedExportsBudget = 119;
let unusedTypesBudget = 38;

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, ["knip", "--include", "exports,types"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
});

if (result.error) throw result.error;
if (result.status !== 0 && result.status !== 1) {
  throw new Error(`Knip export audit failed unexpectedly with exit code ${result.status}.\n${result.stdout}\n${result.stderr}`);
}

const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const count = (pattern) => Number(output.match(pattern)?.[1] ?? 0);
const unusedExports = count(/Unused exports \((\d+)\)/);
const unusedTypes = count(/Unused exported types \((\d+)\)/);

if (unusedExports > unusedExportsBudget || unusedTypes > unusedTypesBudget) {
  console.error(output.trim());
}
if (unusedExports > unusedExportsBudget) {
  throw new Error(`Unused exports increased from budget ${unusedExportsBudget} to ${unusedExports}.`);
}
if (unusedTypes > unusedTypesBudget) {
  throw new Error(`Unused exported types increased from budget ${unusedTypesBudget} to ${unusedTypes}.`);
}

if (unusedExports < unusedExportsBudget || unusedTypes < unusedTypesBudget) {
  const selfPath = fileURLToPath(import.meta.url);
  let self = fs.readFileSync(selfPath, "utf8");
  self = self
    .replace(/unusedExportsBudget = \d+;/, `unusedExportsBudget = ${unusedExports};`)
    .replace(/unusedTypesBudget = \d+;/, `unusedTypesBudget = ${unusedTypes};`);
  fs.writeFileSync(selfPath, self);
  console.log(`Export budget ratchet tightened: exports=${unusedExports}, types=${unusedTypes}. Commit the updated baseline.`);
}

console.log(`Export surface check passed: unused exports ${unusedExports}/${unusedExportsBudget}; unused exported types ${unusedTypes}/${unusedTypesBudget}.`);
