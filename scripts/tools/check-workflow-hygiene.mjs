import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const workflowsDir = join(root, ".github", "workflows");
const previewDir = join(root, ".preview");
const errors = [];

const bannedWorkflowName = /(?:^|[-_.])pr\d+(?:[-_.]|$)|acceptance/i;
const bannedWorkflowMarkers = [
  "sync/v7-live-gc",
  "sync/v8-history-archive",
  "acceptance-v8",
];

if (existsSync(workflowsDir)) {
  for (const name of readdirSync(workflowsDir)) {
    const path = join(workflowsDir, name);
    if (!statSync(path).isFile()) continue;
    if (bannedWorkflowName.test(name)) {
      errors.push(`one-off workflow filename is not allowed: .github/workflows/${name}`);
    }
    const source = readFileSync(path, "utf8");
    for (const marker of bannedWorkflowMarkers) {
      if (source.includes(marker)) {
        errors.push(`legacy workflow marker ${JSON.stringify(marker)} remains in .github/workflows/${name}`);
      }
    }
  }
}

if (existsSync(previewDir)) {
  const committedState = readdirSync(previewDir, { recursive: true })
    .map((entry) => String(entry))
    .filter(Boolean);
  if (committedState.length > 0) {
    errors.push(`.preview must not contain committed acceptance/deploy state: ${committedState.join(", ")}`);
  }
}

if (errors.length > 0) {
  console.error("Workflow hygiene check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Workflow hygiene OK (${relative(root, workflowsDir)} has no one-off PR/acceptance workflows or legacy Sync v7/v8 markers).`);
