import { deleteBankFolder as deleteBankFolderRecord, reorderBanks as reorderBankRecords, saveBankFolder as saveBankFolderRecord, updateBank } from "@/lib/db/db";
import { isBankEnabled, type AttemptStats as DbAttemptStats, type BankFolder as DbBankFolder, type Bank as DbBank, type Note as DbNote, type PracticeRun as DbPracticeRun, type QuestionType as DbQuestionType } from "@/lib/db/types";
import type { QuestionViewModel } from "@/app/bank/question-editor";

export type Bank = DbBank;
export type BankFolder = DbBankFolder;
export type Question = QuestionViewModel;
export type QuestionType = DbQuestionType;
export type Note = DbNote;
export type PracticeRun = DbPracticeRun;
export type AttemptStats = DbAttemptStats & { bankId: string };
export { isBankEnabled };

export type BankQuickMode = "random30" | "sequential" | "randomAll" | "wrong" | "favorite" | "difficult";

export function bankTitle(bank: Bank) { return bank.displayName?.trim() || bank.name; }
export function fullDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
export function sortedBanks(banks: Bank[]) { return [...banks].sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.importedAt.localeCompare(b.importedAt)); }

export type QuestionPreset = "all" | "attempted" | "unattempted" | "wrong" | "favorite" | "noted" | "tagged" | "mastered" | "difficult" | "repeatWrong" | "stubborn" | "favoriteUnanswered" | "wrongNoted" | "staleWrong";
export type ActivityRange = 1 | 7 | 30 | "custom";

export const PRESET_LABELS: Record<QuestionPreset, string> = {
  all: "全部题目", attempted: "已做题目", unattempted: "未做题目", wrong: "当前错题",
  favorite: "收藏题目", noted: "有解析题目", tagged: "有标签题目", mastered: "已掌握题目",
  difficult: "高难题", repeatWrong: "错两次及以上", stubborn: "反复出错", favoriteUnanswered: "收藏但未做",
  wrongNoted: "错题且有解析", staleWrong: "30 天未复习错题",
};

export function percent(part: number, total: number) { return total ? Math.round(part / total * 100) : 0; }
export function formatDateTime(value?: string) {
  if (!value) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
export function formatDuration(ms: number) {
  if (!ms) return "0 分钟";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`;
}
export function runAnswered(run: PracticeRun) { return Object.values(run.answers).filter((answer) => answer.submitted).length; }
export function runAccuracy(run: PracticeRun) {
  const answered = Object.values(run.answers).filter((answer) => answer.submitted);
  return percent(answered.filter((answer) => answer.correct).length, answered.length);
}

export async function reorderBanks(ids: string[], folderId?: string) { await reorderBankRecords(ids, folderId); }
export async function saveBank(id: string, changes: Partial<Pick<Bank, "name" | "displayName" | "description" | "color" | "folderId" | "sortOrder" | "enabled">>) { return updateBank(id, changes); }
export async function saveBankFolder(input: Partial<BankFolder>): Promise<BankFolder> { return saveBankFolderRecord({ id: input.id, name: input.name?.trim() || "未命名文件夹", description: input.description ?? "" }); }
export async function deleteBankFolder(id: string): Promise<void> { await deleteBankFolderRecord(id); }
