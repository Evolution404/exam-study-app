import assert from "node:assert/strict";
import { classifyNoticeTone } from "../../lib/notice-tone";

// Every sync-layer error message (Chinese and English) must classify as "error"
// so the toast never renders a failure in the success (green) colour. These
// strings are sampled from the actual throw sites in github-v7-remote.ts,
// github-sync-v7.ts, sync-v7-head.ts and sync-v6-checkpoint.ts.
const SYNC_ERRORS: string[] = [
  "v7 head vault identity does not match this remote",
  "v7 append vault identity mismatch",
  "v7 publication vault identity mismatch",
  "v7 segment vault identity mismatch",
  "v7 segment vault identity does not match head",
  "path digest mismatch",
  "v7 初始化冲突，请重试。",
  "无法初始化 v7 远端。",
  "v7 远端缺少初始化检查点。",
  "v7 远端索引丢失。",
  "远端变更集 cs-1 与本地锁定版本不一致。",
  "远端变更集 cs-1 完整性校验失败。",
  "远端持续发生并发更新，本地变更已保留，请稍后重试。",
  "同步失败，请检查令牌和网络",
  "定期拉取失败：远端不可达",
  "GitHub request timed out",
  "GitHub network request failed",
  "GitHub did not return the blob SHA",
  "GitHub did not return an existing blob SHA",
  "GitHub read v7 head failed (404)",
  "GitHub put immutable sync/v7/objects/abc.json failed (422)",
  "v7 segments exceed the aggregate hot-window byte limit; compact explicitly first",
  "v7 segments exceed the bounded index limit",
  "v7 replay contains duplicate generation/ordinal",
  "v7 segment generation mismatch",
  "v7 segment ordinal mismatch",
  "immutable v7 file content differs at sync/v7/objects/abc.json",
  "v7 blob size mismatch: expected 1024, received 2048",
  "v7 blob sha256 mismatch: expected aaaa, received bbbb",
  "object ref path digest must equal sha256",
  "invalid v7 segment envelope",
  "invalid v7 segment JSON",
  "远程 v6 检查点不是有效 JSON。",
  "正则表达式格式不正确，请检查后重试",
  "题库导入失败",
  "本地缓存恢复失败",
];

for (const message of SYNC_ERRORS) {
  assert.equal(classifyNoticeTone(message), "error", `应判为错误色：${message}`);
}

// Success / informational copy must keep the success colour (regression guard
// against an over-broad failure pattern).
const SUCCESSES: string[] = [
  "同步完成：上传 2 组操作",
  "云端和本机已经一致",
  "同步完成，3 组操作需要处理",
  "已从 Excel 导入「基础题库」的 100 道题",
  "正在识别并校验题库…",
  "v7 远端恢复完成",
  "本地数据恢复完成",
  "已收藏这道题",
  "已恢复上次练习",
  "已到最后一题，可以回顾或查看本次结果",
  // Guidance / positively-phrased guards (no failure signal) stay neutral/green.
  "请先选择一个题库",
  "题库中没有可导入的有效题目。",
];

for (const message of SUCCESSES) {
  assert.equal(classifyNoticeTone(message), "success", `应判为成功色：${message}`);
}

console.log(`notice tone tests passed: ${SYNC_ERRORS.length} 条错误判红、${SUCCESSES.length} 条成功判绿`);
