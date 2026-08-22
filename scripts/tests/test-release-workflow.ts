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
// verification. GitHub Pages, Cloudflare Pages and IPA share only the common
// build dependency; all post-deploy checks share those three publish jobs.
const buildJob = deployWorkflow.slice(
  deployWorkflow.indexOf("  build:"),
  deployWorkflow.indexOf("  deploy:", deployWorkflow.indexOf("  build:")),
);
const iosReleaseJob = deployWorkflow.slice(
  deployWorkflow.indexOf("  ios_release:"),
  deployWorkflow.indexOf("  fast_check:", deployWorkflow.indexOf("  ios_release:")),
);
const fastCheckJob = deployWorkflow.slice(
  deployWorkflow.indexOf("  fast_check:"),
  deployWorkflow.indexOf("  pwa_smoke:", deployWorkflow.indexOf("  fast_check:")),
);
const pwaSmokeJob = deployWorkflow.slice(
  deployWorkflow.indexOf("  pwa_smoke:"),
  deployWorkflow.indexOf("  sidestore_smoke:", deployWorkflow.indexOf("  pwa_smoke:")),
);
const sideStoreSmokeJob = deployWorkflow.slice(
  deployWorkflow.indexOf("  sidestore_smoke:"),
  deployWorkflow.indexOf("  rollback_github_pages:", deployWorkflow.indexOf("  sidestore_smoke:")),
);

assert.match(buildJob, /name: Upload current artifact[\s\S]*?name: current/, "部署前构建必须上传 current 产物");
assert.doesNotMatch(buildJob, /test:fast|test:pwa-smoke/, "current 构建不得在部署前等待 fast-check 或 PWA smoke");
assert.match(deployWorkflow, /name: Deploy current Pages artifact[\s\S]*?artifact_name: current/, "首次 Pages 部署必须使用 current 产物");
assert.equal((deployWorkflow.match(/actions\/configure-pages@v6/g) ?? []).length, 2, "当前构建与回退构建必须使用 Node 24 configure-pages v6");
assert.equal((deployWorkflow.match(/actions\/upload-pages-artifact@v5/g) ?? []).length, 2, "当前构建与回退构建必须使用 Node 24 Pages artifact v5");
assert.equal((deployWorkflow.match(/actions\/deploy-pages@v5/g) ?? []).length, 2, "当前部署与回退部署必须使用 Node 24 deploy-pages v5");
assert.doesNotMatch(deployWorkflow, /actions\/(?:configure-pages@v5|upload-pages-artifact@v4|deploy-pages@v4)/, "Pages 发布链不得退回 Node 20 action 主版本");
assert.match(deployWorkflow, / {2}deploy:[\s\S]*?needs: build/, "GitHub Pages 必须只等待公共构建");
assert.match(deployWorkflow, / {2}deploy_cloudflare:[\s\S]*?needs: build/, "Cloudflare Pages 必须只等待公共构建");
assert.match(iosReleaseJob, /needs: build\n/, "IPA 必须只等待公共构建，不能等待网页或测试");
for (const [name, job] of [["fast-check", fastCheckJob], ["PWA smoke", pwaSmokeJob], ["SideStore smoke", sideStoreSmokeJob]] as const) {
  assert.match(job, /needs: \[deploy, deploy_cloudflare, ios_release\]/, `${name} 必须等待三端发布完成`);
  assert.doesNotMatch(job, /needs: \[[^\]]*(?:fast_check|pwa_smoke|sidestore_smoke)/, `${name} 不得串行依赖其他发布后测试`);
}

assert.match(deployWorkflow, /rollback_sha: \$\{\{ steps\.rollback-ref\.outputs\.sha \}\}/, "部署必须输出回退提交");
assert.match(deployWorkflow, /EVENT_BEFORE: \$\{\{ github\.event\.before \}\}/, "push 必须优先使用 github.event.before 回退");
assert.match(deployWorkflow, /git rev-parse HEAD\^/, "workflow_dispatch 必须可靠回退到 HEAD^ ");
assert.match(deployWorkflow, /name: Upload rollback artifact[\s\S]*?name: rollback/, "回退必须上传独立 rollback 产物");
assert.match(deployWorkflow, /name: Build rollback artifact[\s\S]*?GITHUB_SHA: \$\{\{ needs\.build\.outputs\.rollback_sha \}\}/, "回退构建必须注入 rollback SHA");
assert.match(deployWorkflow, /name: Deploy rollback artifact[\s\S]*?artifact_name: rollback/, "回退 Pages 部署必须使用 rollback 产物");
assert.match(deployWorkflow, /rollback_github_pages:[\s\S]*?if: \$\{\{ always\(\) && needs\.deploy\.result == 'success' && \(needs\.fast_check\.result == 'failure' \|\| needs\.pwa_smoke\.result == 'failure' \|\| needs\.sidestore_smoke\.result == 'failure'\) \}\}/, "三项验证任一失败时必须回退 Pages");
assert.match(deployWorkflow, /previous_deployment_id: \$\{\{ steps\.record-production\.outputs\.deployment_id \}\}/, "Cloudflare 部署必须输出此前 production deployment ID");
assert.match(deployWorkflow, /\/accounts\/\$\{CLOUDFLARE_ACCOUNT_ID\}\/pages\/projects\/\$\{CLOUDFLARE_PROJECT_NAME\}\/deployments\/\$\{PREVIOUS_DEPLOYMENT_ID\}\/rollback/, "Cloudflare 回退必须调用官方 rollback API");
assert.match(deployWorkflow, /purge_cache/, "Cloudflare 当前部署和回退后都必须清理边缘缓存");
assert.match(deployWorkflow, /CLOUDFLARE_API_TOKEN != '' && env\.CLOUDFLARE_ACCOUNT_ID != ''/, "Cloudflare 凭据缺失时必须安全跳过 API 步骤");
assert.match(deployWorkflow, /rollback_ios_release:[\s\S]*?gh release edit "\$PREVIOUS_RELEASE_TAG"[\s\S]*?--latest/, "测试失败时必须恢复此前 SideStore latest");
assert.match(deployWorkflow, /previous_release_tag: \$\{\{ steps\.previous-release\.outputs\.tag \}\}/, "IPA 发布必须输出此前 Release 标签供回退");

console.log("release workflow assertions passed: bounded staging, three-target parallel publish, post-deploy verification and rollback");
