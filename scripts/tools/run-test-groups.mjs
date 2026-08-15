import { spawn } from "node:child_process";
import { testGroups, groupConcurrency } from "./test-groups.mjs";

const args = process.argv.slice(2);
const options = { concurrency: Number(process.env.TEST_CONCURRENCY) || 0, keepGoing: false };
const names = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--serial") options.concurrency = 1;
  else if (arg === "--keep-going") options.keepGoing = true;
  else if (arg === "--concurrency") {
    options.concurrency = Number(args[index + 1]);
    index += 1;
  } else names.push(arg);
}
const scripts = names.flatMap((name) => testGroups[name] ?? [name]);
if (scripts.length === 0) {
  console.error("用法：node scripts/tools/run-test-groups.mjs [分组名或 npm script...] [--concurrency n] [--serial] [--keep-going]");
  process.exit(1);
}
if (!Number.isFinite(options.concurrency) || options.concurrency <= 0) {
  const selected = names.filter((name) => groupConcurrency[name]).map((name) => groupConcurrency[name]);
  options.concurrency = selected.length ? Math.min(...selected) : 4;
}

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
      console.error(`[run-test-groups] 启动 ${script} 失败：${error.message}`);
      resolve({ script, code: 1 });
    });
  });
}

const queue = [...scripts];
const running = new Set();
const results = [];
let stopped = false;

await new Promise((resolve) => {
  function pump() {
    while (!stopped && running.size < options.concurrency && queue.length) {
      const script = queue.shift();
      running.add(script);
      run(script).then((result) => {
        running.delete(script);
        results.push(result);
        if (result.code !== 0 && !options.keepGoing) stopped = true;
        pump();
        if (running.size === 0) resolve();
      });
    }
    if (running.size === 0) resolve();
  }
  pump();
});

const failed = results.filter((result) => result.code !== 0);
if (results.length) {
  console.log(`测试汇总：成功 ${results.length - failed.length} 个，失败 ${failed.length} 个`);
}
if (failed.length) {
  console.log("失败列表：");
  for (const result of failed) console.log(`  ${result.script} 退出码 ${result.code}`);
  process.exitCode = 1;
}
