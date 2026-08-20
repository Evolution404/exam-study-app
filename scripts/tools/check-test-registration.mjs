import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testGroups } from "./test-groups.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const failures = [];
const registeredScripts = new Map();

for (const [group, scripts] of Object.entries(testGroups)) {
  for (const script of scripts) {
    if (!packageJson.scripts?.[script]) {
      failures.push(`${group}: test script is not defined in package.json: ${script}`);
      continue;
    }
    const previous = registeredScripts.get(script);
    if (previous) previous.push(group);
    else registeredScripts.set(script, [group]);
  }
}

const referencedFiles = new Map();
for (const [script, command] of Object.entries(packageJson.scripts ?? {})) {
  for (const match of command.matchAll(/scripts\/tests\/(test-[\w-]+\.(?:ts|tsx|mjs))/g)) {
    const file = match[1];
    const scripts = referencedFiles.get(file) ?? [];
    scripts.push(script);
    referencedFiles.set(file, scripts);
  }
}

const testFiles = readdirSync(path.join(root, "scripts/tests"))
  .filter((file) => /^test-[\w-]+\.(?:ts|tsx|mjs)$/.test(file))
  .sort();
for (const file of testFiles) {
  const scripts = referencedFiles.get(file) ?? [];
  if (!scripts.some((script) => registeredScripts.has(script))) {
    failures.push(`test file is not registered in testGroups: scripts/tests/${file}`);
  }
}

for (const [script, groups] of registeredScripts) {
  if (groups.length > 1 && !script.includes("integration")) {
    failures.push(`test script is registered in multiple groups (${groups.join(", ")}): ${script}`);
  }
}

if (failures.length) {
  console.error("测试清单检查失败：");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`测试清单检查通过：${testFiles.length} 个测试文件均已登记，${registeredScripts.size} 个 npm 测试脚本已映射到单一分组`);
