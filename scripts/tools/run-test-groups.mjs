import { spawn } from "node:child_process";
import { testGroups } from "./test-groups.mjs";

const groups = process.argv.slice(2).flatMap((name) => testGroups[name] ?? [name]);
if (groups.length === 0) {
  console.error("用法：node scripts/tools/run-test-groups.mjs <分组名或 npm script>...");
  process.exit(1);
}

const results = await Promise.all(groups.map((script) => run(script)));

for (const { script, code } of results) {
  if (code !== 0) {
    console.error(`[run-test-groups] ${script} 退出码为 ${code}`);
    process.exitCode = code ?? 1;
  }
}

function run(script) {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", script], { stdio: "inherit" });
    child.on("close", (code) => resolve({ script, code }));
    child.on("error", (error) => {
      console.error(`[run-test-groups] 启动 ${script} 失败：${error.message}`);
      resolve({ script, code: 1 });
    });
  });
}
