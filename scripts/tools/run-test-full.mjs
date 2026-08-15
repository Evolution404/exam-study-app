import { spawn } from "node:child_process";

const scripts = ["build", "test:fast"];

function prefixChunk(prefix, chunk) {
  return chunk.toString().split("\n").map((line) => line.length ? `${prefix}${line}` : line).join("\n");
}

function run(script) {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", script], { stdio: ["ignore", "pipe", "pipe"] });
    const prefix = `[${script}] `;
    child.stdout.on("data", (chunk) => process.stdout.write(prefixChunk(prefix, chunk)));
    child.stderr.on("data", (chunk) => process.stderr.write(prefixChunk(prefix, chunk)));
    child.on("close", (code) => resolve({ script, code }));
    child.on("error", (error) => {
      console.error(`[run-test-full] 启动 ${script} 失败：${error.message}`);
      resolve({ script, code: 1 });
    });
  });
}

const firstStage = await Promise.all(scripts.map(run));
const failed = firstStage.filter((result) => result.code !== 0);
if (failed.length) {
  console.error(`[run-test-full] 阶段一失败：${failed.map((item) => item.script).join(", ")}`);
  process.exit(1);
}

const browser = await run("test:browser");
if (browser.code !== 0) {
  console.error("[run-test-full] 浏览器测试失败");
  process.exit(1);
}
console.log("test-full 全部通过");
