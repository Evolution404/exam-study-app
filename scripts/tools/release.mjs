import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dryRun = process.env.RELEASE_DRY_RUN === "1";
const skipDeployWait = process.env.RELEASE_SKIP_DEPLOY_WAIT === "1";
const message = (process.env.RELEASE_MESSAGE || "chore: publish verified updates").trim();
const deployTimeoutMs = Number(process.env.RELEASE_TIMEOUT_MS || 15 * 60_000);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} 失败（${code}）${stderr ? `\n${stderr.trim()}` : ""}`));
    });
  });
}

const git = (args) => run("git", args, { capture: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function nulPaths(output) {
  return output.split("\0").filter(Boolean);
}

async function changedPaths() {
  const [unstaged, staged, untracked] = await Promise.all([
    git(["diff", "--name-only", "-z"]),
    git(["diff", "--cached", "--name-only", "-z"]),
    git(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set([...nulPaths(unstaged), ...nulPaths(staged), ...nulPaths(untracked)])].sort();
}

async function worktreeSnapshot() {
  return git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
}

function githubRepository(remoteUrl) {
  const match = remoteUrl.trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return match ? { owner: match[1], repo: match[2] } : null;
}

async function githubJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "exam-study-app-release",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function waitForDeployment(repository, sha) {
  const api = `https://api.github.com/repos/${repository.owner}/${repository.repo}/actions/workflows/deploy-pages.yml/runs?branch=main&per_page=20`;
  const deadline = Date.now() + deployTimeoutMs;
  let announcedUrl = "";
  while (Date.now() < deadline) {
    const data = await githubJson(api);
    const workflow = data.workflow_runs?.find((run) => run.head_sha === sha);
    if (!workflow) {
      process.stdout.write("等待 GitHub Actions 创建部署任务…\r");
    } else {
      if (workflow.html_url !== announcedUrl) {
        announcedUrl = workflow.html_url;
        console.log(`部署任务：${workflow.html_url}`);
      }
      if (workflow.status === "completed") {
        if (workflow.conclusion !== "success") throw new Error(`部署失败：${workflow.conclusion}（${workflow.html_url}）`);
        return workflow.html_url;
      }
      process.stdout.write(`部署状态：${workflow.status}…\r`);
    }
    await wait(12_000);
  }
  throw new Error(`等待部署超过 ${Math.round(deployTimeoutMs / 60_000)} 分钟`);
}

async function verifyGitHubPages(repository, sha) {
  const baseUrl = `https://${repository.owner.toLowerCase()}.github.io/${repository.repo}/`;
  // The production bundler constant-folds __APP_COMMIT_SHA__.slice(0, 12), so
  // the emitted bundle intentionally contains the displayed short SHA rather
  // than the complete 40-character value.
  const deployedVersion = sha.slice(0, 12);
  const deadline = Date.now() + 2 * 60_000;
  while (Date.now() < deadline) {
    const cacheBust = `release=${sha.slice(0, 12)}-${Date.now()}`;
    const response = await fetch(`${baseUrl}?${cacheBust}`, { headers: { "Cache-Control": "no-cache" } });
    if (response.ok) {
      const html = await response.text();
      const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((match) => new URL(match[1], baseUrl));
      const sources = await Promise.all(scripts.map(async (url) => {
        const asset = await fetch(`${url.href}${url.search ? "&" : "?"}${cacheBust}`, { headers: { "Cache-Control": "no-cache" } });
        return asset.ok ? asset.text() : "";
      }));
      const sw = await fetch(`${baseUrl}sw.js?${cacheBust}`, { headers: { "Cache-Control": "no-cache" } });
      if (sources.some((source) => source.includes(deployedVersion)) && sw.ok) return baseUrl;
    }
    await wait(10_000);
  }
  throw new Error(`部署任务成功，但线上版本未在 2 分钟内更新到 ${sha.slice(0, 12)}`);
}

async function main() {
  if (!message || /[\r\n]/.test(message)) throw new Error("RELEASE_MESSAGE/MSG 必须是单行非空提交说明");
  if (!Number.isFinite(deployTimeoutMs) || deployTimeoutMs < 60_000) throw new Error("RELEASE_TIMEOUT_MS 至少为 60000");

  const branch = (await git(["branch", "--show-current"])).trim();
  if (branch !== "main") throw new Error(`一键发布只能从 main 执行，当前分支为 ${branch || "detached HEAD"}`);

  await run("git", ["fetch", "origin", "main"]);
  const [aheadText, behindText] = (await git(["rev-list", "--left-right", "--count", "HEAD...origin/main"])).trim().split(/\s+/);
  const ahead = Number(aheadText);
  const behind = Number(behindText);
  if (behind > 0) throw new Error(`本地 main 落后 origin/main ${behind} 个提交，请先同步再发布`);

  const before = await changedPaths();
  const beforeSnapshot = await worktreeSnapshot();
  if (!before.length && ahead === 0) throw new Error("没有待提交或待推送的改动");
  if (before.length) {
    console.log("本次发布文件：");
    for (const file of before) console.log(`  - ${file}`);
  } else {
    console.log(`本地已有 ${ahead} 个提交待推送。`);
  }

  const browserPort = String(await availablePort());
  const pwaPort = String(await availablePort());
  console.log(`\n发布级验证：browser=${browserPort}，pwa=${pwaPort}`);
  await run("npm", ["run", "test:full"], { env: { BROWSER_PORT: browserPort, BROWSER_HEADLESS: process.env.BROWSER_HEADLESS || "1" } });
  await run("npm", ["run", "test:pwa-smoke"], { env: { PWA_PREVIEW_PORT: pwaPort } });

  await run("git", ["fetch", "origin", "main"]);
  const [, latestBehindText] = (await git(["rev-list", "--left-right", "--count", "HEAD...origin/main"])).trim().split(/\s+/);
  if (Number(latestBehindText) > 0) throw new Error("测试期间 origin/main 已更新，停止发布以避免覆盖远端提交");
  if (await worktreeSnapshot() !== beforeSnapshot) throw new Error("测试期间工作区发生变化，停止发布；请确认新增改动后重新执行");

  if (dryRun) {
    console.log("\n发布预检通过；RELEASE_DRY_RUN=1，未提交、未推送。 ");
    return;
  }

  if (before.length) {
    await run("git", ["add", "--", ...before]);
    await run("git", ["diff", "--cached", "--check"]);
    await run("git", ["commit", "-m", message]);
  }
  const sha = (await git(["rev-parse", "HEAD"])).trim();
  await run("git", ["push", "origin", "main"]);
  console.log(`已推送 ${sha.slice(0, 12)} 到 origin/main。`);

  if (skipDeployWait) {
    console.log("RELEASE_SKIP_DEPLOY_WAIT=1，跳过部署等待。 ");
    return;
  }
  const repository = githubRepository(await git(["remote", "get-url", "origin"]));
  if (!repository) throw new Error("无法从 origin 识别 GitHub 仓库，提交已推送但未核验部署");
  await waitForDeployment(repository, sha);
  const pageUrl = await verifyGitHubPages(repository, sha);
  console.log(`发布完成：${pageUrl}（${sha.slice(0, 12)}）`);
}

main().catch((error) => {
  console.error(`\n发布停止：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
