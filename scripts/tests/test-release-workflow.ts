import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file: string) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const makefile = read("Makefile");
const release = read("scripts/tools/release.mjs");
const deployWorkflow = read(".github/workflows/deploy-pages.yml");

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

// The deploy workflow must publish the current artifact before any expensive
// verification. The two post-deploy jobs deliberately share only the deploy
// dependency so they can run at the same time.
const buildJob = deployWorkflow.slice(
  deployWorkflow.indexOf("  build:"),
  deployWorkflow.indexOf("  deploy:", deployWorkflow.indexOf("  build:")),
);
const fastCheckJob = deployWorkflow.slice(
  deployWorkflow.indexOf("  fast_check:"),
  deployWorkflow.indexOf("  pwa_smoke:", deployWorkflow.indexOf("  fast_check:")),
);
const pwaSmokeJob = deployWorkflow.slice(
  deployWorkflow.indexOf("  pwa_smoke:"),
  deployWorkflow.indexOf("  ios_release:", deployWorkflow.indexOf("  pwa_smoke:")),
);

assert.match(buildJob, /name: Upload current artifact[\s\S]*?name: current/, "部署前构建必须上传 current 产物");
assert.doesNotMatch(buildJob, /test:fast|test:pwa-smoke/, "current 构建不得在部署前等待 fast-check 或 PWA smoke");
assert.match(deployWorkflow, /name: Deploy current Pages artifact[\s\S]*?artifact_name: current/, "首次 Pages 部署必须使用 current 产物");
assert.match(fastCheckJob, /needs: deploy\n/, "fast-check 必须依赖部署完成");
assert.match(pwaSmokeJob, /needs: deploy\n/, "PWA smoke 必须依赖部署完成");
assert.doesNotMatch(fastCheckJob, /needs: \[/, "fast-check 不得串行依赖 PWA smoke");
assert.doesNotMatch(pwaSmokeJob, /needs: \[/, "PWA smoke 不得串行依赖 fast-check");

assert.match(deployWorkflow, /rollback_sha: \$\{\{ steps\.rollback-ref\.outputs\.sha \}\}/, "部署必须输出回退提交");
assert.match(deployWorkflow, /EVENT_BEFORE: \$\{\{ github\.event\.before \}\}/, "push 必须优先使用 github.event.before 回退");
assert.match(deployWorkflow, /git rev-parse HEAD\^/, "workflow_dispatch 必须可靠回退到 HEAD^ ");
assert.match(deployWorkflow, /name: Upload rollback artifact[\s\S]*?name: rollback/, "回退必须上传独立 rollback 产物");
assert.match(deployWorkflow, /name: Build rollback artifact[\s\S]*?GITHUB_SHA: \$\{\{ needs\.build\.outputs\.rollback_sha \}\}/, "回退构建必须注入 rollback SHA");
assert.match(deployWorkflow, /name: Deploy rollback artifact[\s\S]*?artifact_name: rollback/, "回退 Pages 部署必须使用 rollback 产物");
assert.match(deployWorkflow, /if: \$\{\{ always\(\) && needs\.deploy\.result == 'success' && \(needs\.fast_check\.result == 'failure' \|\| needs\.pwa_smoke\.result == 'failure'\) \}\}/, "只有部署成功且验证失败时才回退 Pages");
assert.match(deployWorkflow, /previous_deployment_id: \$\{\{ steps\.record-production\.outputs\.deployment_id \}\}/, "Cloudflare 部署必须输出此前 production deployment ID");
assert.match(deployWorkflow, /\/accounts\/\$\{CLOUDFLARE_ACCOUNT_ID\}\/pages\/projects\/\$\{CLOUDFLARE_PROJECT_NAME\}\/deployments\/\$\{PREVIOUS_DEPLOYMENT_ID\}\/rollback/, "Cloudflare 回退必须调用官方 rollback API");
assert.match(deployWorkflow, /purge_cache/, "Cloudflare 当前部署和回退后都必须清理边缘缓存");
assert.match(deployWorkflow, /CLOUDFLARE_API_TOKEN != '' && env\.CLOUDFLARE_ACCOUNT_ID != ''/, "Cloudflare 凭据缺失时必须安全跳过 API 步骤");

console.log("release workflow assertions passed: bounded staging, deploy-first verification, rollback and deployment checks");
