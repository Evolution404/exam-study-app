export type NoticeTone = "success" | "error";

// Failure vocabulary drawn from the sync layer's actual error messages
// (github-v7-remote / github-sync-v7 / sync-v7-head / sync-v6-checkpoint) plus
// common UI error copy. A notice that reads as a failure must never render in
// the success colour.
const ERROR_NOTICE_PATTERN = /失败|错误|无效|不是有效|不存在|已被删除|拒绝|不匹配|不一致|不正确|无法|缺少|丢失|超时|超出|冲突|请稍后重试|invalid|missing|denied|forbidden|unauthorized|failed|mismatch|does not match|differs|timed out|exceed|duplicate|did not return|cannot|must equal|must be|\b(?:401|403|409|422)\b/i;

/** Keep status copy simple while ensuring failures never look successful. */
export function classifyNoticeTone(message: string): NoticeTone {
  return ERROR_NOTICE_PATTERN.test(message) ? "error" : "success";
}
