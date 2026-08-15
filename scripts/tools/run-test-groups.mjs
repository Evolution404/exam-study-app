import { spawn } from "node:child_process";

const groups = process.argv.slice(2);
if (groups.length === 0) {
  console.error("usage: node scripts/tools/run-test-groups.mjs <script>...");
  process.exit(1);
}

const results = await Promise.all(groups.map((script) => run(script)));

for (const { script, code } of results) {
  if (code !== 0) {
    console.error(`[run-test-groups] ${script} exited with ${code}`);
    process.exitCode = code ?? 1;
  }
}

function run(script) {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", script], { stdio: "inherit" });
    child.on("close", (code) => resolve({ script, code }));
    child.on("error", (error) => {
      console.error(`[run-test-groups] failed to start ${script}: ${error.message}`);
      resolve({ script, code: 1 });
    });
  });
}
