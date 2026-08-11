export type NoticeTone = "success" | "error";

const ERROR_NOTICE_PATTERN = /失败|错误|无效|不存在|已被删除|拒绝|invalid|missing|denied|forbidden|unauthorized|failed|\b(?:401|403|409|422)\b/i;

/** Keep status copy simple while ensuring failures never look successful. */
export function classifyNoticeTone(message: string): NoticeTone {
  return ERROR_NOTICE_PATTERN.test(message) ? "error" : "success";
}
