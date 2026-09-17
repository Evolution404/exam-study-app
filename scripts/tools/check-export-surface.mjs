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
