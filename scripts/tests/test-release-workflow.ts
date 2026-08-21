import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file: string) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const makefile = read("Makefile");
const release = read("scripts/tools/release.mjs");

for (const target of ["doctor", "status", "verify", "release-check", "release", "publish"]) {
  assert.match(makefile, new RegExp(`^${target}:`, "m"), `Makefile 应提供 ${target} 入口`);
}
assert.match(makefile, /make release MSG="fix: \.\.\."/, "帮助页应给出一键发布示例");
assert.match(makefile, /node scripts\/tools\/release\.mjs/, "Makefile 发布入口应委托可测试的发布脚本");
assert.doesNotMatch(makefile + release, /git add (?:-A|--all|\.)/, "一键发布不得使用无边界 git add");

assert.match(release, /branch !== "main"/, "发布必须限制在 main 分支");
assert.match(release, /git\(\["diff", "--name-only", "-z"\]\)/, "发布应枚举已跟踪改动");
assert.match(release, /git\(\["ls-files", "--others", "--exclude-standard", "-z"\]\)/, "发布应显式枚举未跟踪文件");
assert.match(release, /const beforeSnapshot = await worktreeSnapshot\(\)/, "发布前必须锁定工作区状态快照");
assert.match(release, /worktreeSnapshot\(\) !== beforeSnapshot/, "验证期间工作区变化时必须停止发布");
assert.match(release, /run\("git", \["add", "--", \.\.\.before\]\)/, "发布只能暂存最初已展示的精确文件列表");
assert.match(release, /\["run", "test:full"\]/, "发布前必须执行全量测试");
assert.match(release, /\["run", "test:pwa-smoke"\]/, "发布前必须执行真实 PWA smoke");
assert.match(release, /\["push", "origin", "main"\]/, "发布应推送 main");
assert.match(release, /run\) => run\.head_sha === sha/, "发布必须等待当前提交对应的部署任务");
assert.match(release, /const deployedVersion = sha\.slice\(0, 12\)/, "线上版本探针应匹配构建产物实际保留的 12 位提交版本");
assert.match(release, /source\.includes\(deployedVersion\)/, "发布必须核验线上构建包含当前提交版本");
assert.doesNotMatch(release, /source\.includes\(sha\)/, "线上版本探针不得要求已被构建器常量折叠移除的完整 SHA");
assert.match(release, /RELEASE_DRY_RUN/, "发布应支持无外部写入的预检模式");

console.log("release workflow assertions passed: bounded staging, full verification, push and deployment checks");
