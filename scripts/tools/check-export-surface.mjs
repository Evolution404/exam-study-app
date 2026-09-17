import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let unusedExportsBudget = 103;
let unusedTypesBudget = 33;

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
const unusedExports = Number(/Unused exports \((\d+)\)/.exec(output)?.[1] ?? 0);
const unusedTypes = Number(/Unused exported types \((\d+)\)/.exec(output)?.[1] ?? 0);

if (unusedExports > unusedExportsBudget || unusedTypes > unusedTypesBudget) {
  process.stdout.write(output);
  throw new Error(`Export budget exceeded: exports=${unusedExports}/${unusedExportsBudget}, types=${unusedTypes}/${unusedTypesBudget}. Remove obsolete exports instead of raising the budget.`);
}

let changed = false;
if (unusedExports < unusedExportsBudget) {
  unusedExportsBudget = unusedExports;
  changed = true;
}
if (unusedTypes < unusedTypesBudget) {
  unusedTypesBudget = unusedTypes;
  changed = true;
}
if (changed) {
  const file = fileURLToPath(import.meta.url);
  const source = fs.readFileSync(file, "utf8")
    .replace(/let unusedExportsBudget = \d+;/, `let unusedExportsBudget = ${unusedExportsBudget};`)
    .replace(/let unusedTypesBudget = \d+;/, `let unusedTypesBudget = ${unusedTypesBudget};`);
  fs.writeFileSync(file, source);
  console.log(`Export budget ratchet tightened: exports=${unusedExportsBudget}, types=${unusedTypesBudget}. Commit the updated baseline.`);
}
console.log(`Export surface check passed: unused exports ${unusedExports}/${unusedExportsBudget}; unused exported types ${unusedTypes}/${unusedTypesBudget}.`);
