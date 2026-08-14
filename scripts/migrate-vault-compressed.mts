#!/usr/bin/env node
/**
 * One-shot migration of the remote sync vault to the compressed storage
 * envelope (Part G).  Verify-first: the read-only validation phase must pass
 * before anything is written; any failure aborts with zero remote changes.
 *
 *   npm run migrate:vault -- --owner Evolution404 --repo exam-study-vault --token <PAT> [--api-base /api-github]
 */
import { migrateVaultToCompressed } from "../lib/github-sync-v7.ts";

interface Args {
  owner: string;
  repo: string;
  token: string;
  apiBase?: string;
  verify: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    if (arg === "--verify") continue; // 布尔旗标，无值
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`参数 --${key} 需要一个值`);
    args[key] = value;
    index += 1;
  }
  if (!args.owner || !args.repo || !args.token) {
    throw new Error("用法: npm run migrate:vault -- --owner <owner> --repo <repo> --token <PAT> [--api-base <url>] [--verify]");
  }
  return { owner: args.owner, repo: args.repo, token: args.token, verify: argv.includes("--verify"), ...(args["api-base"] ? { apiBase: args["api-base"] } : {}) };
}

const args = parseArgs(process.argv.slice(2));
console.log(`迁移目标：${args.owner}/${args.repo}（中转 ${args.apiBase ?? "https://api.github.com"}）`);
if (args.verify) console.log("只读验证模式：不会改动任何远端数据。\n");
const result = await migrateVaultToCompressed({ owner: args.owner, repo: args.repo, apiBaseUrl: args.apiBase ?? "https://api.github.com" }, args.token, (label) => console.log(`  · ${label}`), { verifyOnly: args.verify });

if (result.migrated) {
  const saved = result.bytesBefore > 0 ? Math.round((1 - result.bytesAfter / result.bytesBefore) * 100) : 0;
  console.log("迁移完成：");
  console.log(`  · 折叠热事件 ${result.hotEvents} 组为新检查点`);
  console.log(`  · 丢弃存量墓碑 ${result.droppedTombstones} 条（设备将从远端重建，无从复活）`);
  console.log(`  · 逻辑字节 ${(result.bytesBefore / 1024).toFixed(0)} KiB → ${(result.bytesAfter / 1024).toFixed(0)} KiB（${saved}% ↓，存储侧另有 DEFLATE 压缩）`);
  console.log("后续：各设备在 App 内正常同步即可拉取迁移后的数据。");
} else {
  console.log(result.verified ? `验证通过：${result.reason}` : `无需迁移：${result.reason}`);
  if (result.verified) {
    const counts = result.counts!;
    console.log("远端数据画像：");
    console.log(`  · 题目 ${counts.questions} · 题库 ${counts.banks} · 作答 ${counts.attempts} · 练习 ${counts.practiceRuns}`);
    console.log(`  · 热窗口事件 ${result.hotEvents} 组 · 存量墓碑 ${result.droppedTombstones} 条（迁移时丢弃）`);
    console.log(`  · 检查点+热窗口逻辑字节 ${(result.bytesBefore / 1024).toFixed(0)} KiB`);
    console.log("\n验证通过，可执行真实迁移：去掉 --verify 重跑。");
  }
}
