import fs from "node:fs";

const replace = (file, before, after, label) => {
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes(before)) throw new Error(`split-style test migration: missing ${label} in ${file}`);
  source = source.replace(before, after);
  fs.writeFileSync(file, source);
};

replace(
  "scripts/tests/test-sync-event-ui.ts",
  'import { readFile } from "node:fs/promises";',
  'import { readdir, readFile } from "node:fs/promises";',
  "promises import",
);
replace(
  "scripts/tests/test-sync-event-ui.ts",
  'const componentsCss = await readFile(new URL("../../src/app/styles/components.css", import.meta.url), "utf8");',
  'const splitStyleNames = (await readdir(new URL("../../src/app/styles/", import.meta.url))).filter((file) => file.endsWith(".css")).sort();\nconst componentsCss = (await Promise.all(splitStyleNames.map((file) => readFile(new URL(`../../src/app/styles/${file}`, import.meta.url), "utf8")))).join("\\n");',
  "sync event components.css reader",
);

replace(
  "scripts/tests/test-v7-ui-data-flow.ts",
  'import { readFileSync } from "node:fs";',
  'import { readdirSync, readFileSync } from "node:fs";',
  "sync fs import",
);
replace(
  "scripts/tests/test-v7-ui-data-flow.ts",
  'const componentStyles = readFileSync(new URL("../../src/app/styles/components.css", import.meta.url), "utf8");',
  'const splitStyleNames = readdirSync(new URL("../../src/app/styles/", import.meta.url)).filter((file) => file.endsWith(".css")).sort();\nconst componentStyles = splitStyleNames.map((file) => readFileSync(new URL(`../../src/app/styles/${file}`, import.meta.url), "utf8")).join("\\n");',
  "v7 UI components.css reader",
);
replace(
  "scripts/tests/test-v7-ui-data-flow.ts",
  'const primaryRule = componentStyles.match(/\\.primary\\s*\\{[^}]*\\}/)?.[0] ?? "";',
  'const primaryRule = componentStyles.match(/\\.primary\\s*\\{[^}]*min-height:\\s*42px[^}]*\\}/)?.[0] ?? "";',
  "base primary rule lookup",
);

for (const file of fs.readdirSync("scripts/tests").filter((name) => /\.(?:ts|mjs)$/.test(name))) {
  const source = fs.readFileSync(`scripts/tests/${file}`, "utf8");
  if (source.includes('src/app/styles/components.css')) {
    throw new Error(`split-style test migration: stale direct components.css reader remains in ${file}`);
  }
}

fs.rmSync("scripts/tools/fix-split-style-tests-once.mjs");
console.log("remaining split-style test readers migrated; no test directly reads components.css");
