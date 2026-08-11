import { dbV6, getBankQuestionJoinsV6 } from "./db-v6";
import { deriveContentText, deriveSearchText, summarizeContent } from "./question-content";
import type { BankQuestionMembership, BankV6, ContentBlock, QuestionV6 } from "./v6-types";

/**
 * A presentation-only join.  Bank identity and ordering remain membership
 * data; they are never copied onto the canonical QuestionV6 row.
 */
export interface QuestionViewV6 {
  question: QuestionV6;
  memberships: BankQuestionMembership[];
  banks: BankV6[];
  sourceBankId?: string;
}

export interface QuestionPlainViewV6 {
  stem: string;
  options: string[];
  searchText: string;
  summary: string;
}

export function questionPlainViewV6(question: QuestionV6): QuestionPlainViewV6 {
  const stem = deriveContentText(question.content);
  const options = question.options.map((blocks) => deriveContentText(blocks));
  return {
    stem,
    options,
    searchText: [
      deriveSearchText(question.content),
      ...question.options.map((blocks) => deriveSearchText(blocks)),
      ...question.tags,
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
    summary: summarizeContent(question.content),
  };
}

export function questionAnswerTextV6(question: QuestionV6): string {
  if (question.type === "计算") return question.answer;
  return [...question.answer]
    .map((letter) => question.options[letter.charCodeAt(0) - 65])
    .filter((blocks): blocks is ContentBlock[] => Boolean(blocks))
    .map((blocks) => deriveContentText(blocks))
    .join("、");
}

export async function getQuestionViewV6(questionId: string, preferredBankId?: string): Promise<QuestionViewV6 | undefined> {
  const question = await dbV6.questions.get(questionId);
  if (!question) return undefined;
  const memberships = await dbV6.bankQuestionMemberships.where("questionId").equals(questionId).toArray();
  memberships.sort((left, right) => left.bankId.localeCompare(right.bankId) || left.sortOrder - right.sortOrder);
  const banks = (await dbV6.banks.bulkGet(memberships.map((item) => item.bankId))).filter(Boolean) as BankV6[];
  const sourceBankId = preferredBankId && memberships.some((item) => item.bankId === preferredBankId)
    ? preferredBankId
    : memberships[0]?.bankId;
  return { question, memberships, banks, sourceBankId };
}

export async function listQuestionViewsForBankV6(bankId: string): Promise<QuestionViewV6[]> {
  const rows = await getBankQuestionJoinsV6(bankId);
  const bank = await dbV6.banks.get(bankId);
  if (!bank) return [];
  return rows.map(({ question, membership }) => ({
    question,
    memberships: [membership],
    banks: [bank],
    sourceBankId: bankId,
  }));
}

/**
 * Preserve the selected bank order while de-duplicating shared questions.
 * Each view still carries every selected membership so edit/split UI can
 * explain exactly which banks will be affected.
 */
export async function listQuestionViewsForBanksV6(bankIds: readonly string[]): Promise<QuestionViewV6[]> {
  const selected = [...new Set(bankIds)];
  const rows = (await Promise.all(selected.map((bankId) => getBankQuestionJoinsV6(bankId)))).flat();
  const bankMap = new Map((await dbV6.banks.bulkGet(selected)).filter(Boolean).map((bank) => [bank!.id, bank!]));
  const views = new Map<string, QuestionViewV6>();
  for (const row of rows) {
    const bank = bankMap.get(row.membership.bankId);
    if (!bank) continue;
    const current = views.get(row.question.id);
    if (current) {
      current.memberships.push(row.membership);
      current.banks.push(bank);
    } else {
      views.set(row.question.id, {
        question: row.question,
        memberships: [row.membership],
        banks: [bank],
        sourceBankId: row.membership.bankId,
      });
    }
  }
  return [...views.values()];
}

export async function listUnfiledQuestionsV6(): Promise<QuestionV6[]> {
  const [questions, memberships] = await Promise.all([
    dbV6.questions.toArray(),
    dbV6.bankQuestionMemberships.toArray(),
  ]);
  const attached = new Set(memberships.map((item) => item.questionId));
  return questions.filter((question) => !attached.has(question.id));
}
