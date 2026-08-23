#!/usr/bin/env node
/** One-shot migration from the complete Sync v7 namespace to the current wire protocol. */
import { execFileSync } from "node:child_process";
import { migrateVaultToSyncV8Protocol } from "../../src/lib/sync/sync-v8-protocol-migration";

interface Args {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  apiBase?: string;
  verify: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--") || arg === "--verify") continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`参数 ${arg} 需要一个值`);
    values[arg.slice(2)] = value;
    index += 1;
  }
  if (!values.owner || !values.repo) {
    throw new Error("用法: npm run migrate:vault:v8 -- --owner <owner> --repo <repo> [--branch main] [--token <PAT>] [--api-base <url>] [--verify]");
  }
  const token = values.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  if (!token) throw new Error("未找到 GitHub token。");
  return {
    owner: values.owner,
    repo: values.repo,
    branch: values.branch || "main",
    token,
    verify: argv.includes("--verify"),
    ...(values["api-base"] ? { apiBase: values["api-base"] } : {}),
  };
}

const args = parseArgs(process.argv.slice(2));
console.log(`目标：${args.owner}/${args.repo}@${args.branch}`);
if (args.verify) console.log("只读预检：不会写入远端。\n");
const result = await migrateVaultToSyncV8Protocol(
  { owner: args.owner, repo: args.repo, branch: args.branch, ...(args.apiBase ? { apiBaseUrl: args.apiBase } : {}) },
  args.token,
  (label) => console.log(`  · ${label}`),
  { verifyOnly: args.verify },
);
console.log(JSON.stringify(result, null, 2));
