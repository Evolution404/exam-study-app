import { dbV7, getBankQuestionJoinsV7 } from "./db-v7";
import { deriveContentText, deriveSearchText, summarizeContent } from "../question/question-content";
import type { BankQuestionMembership, BankV7, QuestionV7 } from "./v7-types";
export { questionAnswerTextV7 } from "../question/question-answer-text";

/**
 * A presentation-only join. Bank identity and ordering remain membership
 * data; they are never copied onto the canonical QuestionV7 row.
 */
export interface QuestionViewV7 {
  question: QuestionV7;
  memberships: BankQuestionMembership[];
  banks: BankV7[];
  sourceBankId?: string;
}

export interface QuestionMembershipViewV7 {
  questionId: string;
  memberships: BankQuestionMembership[];
  banks: BankV7[];
}

export interface QuestionPlainViewV7 {
  stem: string;
  options: string[];
  searchText: string;
  summary: string;
}

export function questionPlainViewV7(question: QuestionV7): QuestionPlainViewV7 {
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

export async function getQuestionViewV7(questionId: string, preferredBankId?: string): Promise<QuestionViewV7 | undefined> {
  const question = await dbV7.questions.get(questionId);
  if (!question) return undefined;
  const memberships = await dbV7.bankQuestionMemberships.where("questionId").equals(questionId).toArray();
  memberships.sort((left, right) => left.bankId.localeCompare(right.bankId) || left.sortOrder - right.sortOrder);
  const banks = (await dbV7.banks.bulkGet(memberships.map((item) => item.bankId))).filter(Boolean) as BankV7[];
  const sourceBankId = preferredBankId && memberships.some((item) => item.bankId === preferredBankId)
    ? preferredBankId
    : memberships[0]?.bankId;
  return { question, memberships, banks, sourceBankId };
}

/** Batch membership read-model used by bank-management screens. */
export async function listQuestionMembershipViewsV7(questionIds: readonly string[]): Promise<QuestionMembershipViewV7[]> {
  const ids = [...new Set(questionIds.filter(Boolean))];
  if (!ids.length) return [];
  const memberships = await dbV7.bankQuestionMemberships.where("questionId").anyOf(ids).toArray();
  const bankIds = [...new Set(memberships.map((membership) => membership.bankId))];
  const bankMap = new Map((await dbV7.banks.bulkGet(bankIds)).filter(Boolean).map((bank) => [bank!.id, bank!]));
  const grouped = new Map<string, BankQuestionMembership[]>();
  for (const membership of memberships) grouped.set(membership.questionId, [...(grouped.get(membership.questionId) ?? []), membership]);
  return ids.map((questionId) => {
    const rows = [...(grouped.get(questionId) ?? [])].sort((left, right) => left.bankId.localeCompare(right.bankId) || left.sortOrder - right.sortOrder);
    return {
      questionId,
      memberships: rows,
      banks: rows.map((membership) => bankMap.get(membership.bankId)).filter((bank): bank is BankV7 => Boolean(bank)),
    };
  });
}

export async function listQuestionViewsForBankV7(bankId: string): Promise<QuestionViewV7[]> {
  const rows = await getBankQuestionJoinsV7(bankId);
  if (!rows.length) return [];
  const membershipViews = await listQuestionMembershipViewsV7(rows.map((row) => row.question.id));
  const membershipMap = new Map(membershipViews.map((view) => [view.questionId, view]));
  return rows.map(({ question, membership }) => {
    const view = membershipMap.get(question.id);
    return {
      question,
      memberships: view?.memberships ?? [membership],
      banks: view?.banks ?? [],
      sourceBankId: bankId,
    };
  });
}

/**
 * Questions reusable from at least one bank other than the current bank.
 * Existing membership in the current bank is retained in each view so the UI
 * can mark already-added questions without cloning or fuzzy matching.
 */
export async function listQuestionViewsAvailableFromOtherBanksV7(bankId: string): Promise<QuestionViewV7[]> {
  const otherBanks = (await dbV7.banks.toArray()).filter((bank) => bank.id !== bankId);
  if (!otherBanks.length) return [];
  const sourceMemberships = await dbV7.bankQuestionMemberships.where("bankId").anyOf(otherBanks.map((bank) => bank.id)).toArray();
  const questionIds = [...new Set(sourceMemberships.map((membership) => membership.questionId))];
  if (!questionIds.length) return [];
  const [questions, membershipViews] = await Promise.all([
    dbV7.questions.bulkGet(questionIds),
    listQuestionMembershipViewsV7(questionIds),
  ]);
  const membershipMap = new Map(membershipViews.map((view) => [view.questionId, view]));
  return questions.flatMap((question) => {
    if (!question) return [];
    const view = membershipMap.get(question.id);
    if (!view) return [];
    const sourceBankId = view.memberships.find((membership) => membership.bankId !== bankId)?.bankId ?? view.memberships[0]?.bankId;
    return [{ question, memberships: view.memberships, banks: view.banks, sourceBankId }];
  });
}

/**
 * Preserve the selected bank order while de-duplicating shared questions.
 * Each view still carries every selected membership so edit/split UI can
 * explain exactly which banks will be affected.
 */
export async function listQuestionViewsForBanksV7(bankIds: readonly string[]): Promise<QuestionViewV7[]> {
  const selected = [...new Set(bankIds)];
  const rows = (await Promise.all(selected.map((bankId) => getBankQuestionJoinsV7(bankId)))).flat();
  const bankMap = new Map((await dbV7.banks.bulkGet(selected)).filter(Boolean).map((bank) => [bank!.id, bank!]));
  const views = new Map<string, QuestionViewV7>();
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

export async function listUnfiledQuestionsV7(): Promise<QuestionV7[]> {
  const [questions, memberships] = await Promise.all([
    dbV7.questions.toArray(),
    dbV7.bankQuestionMemberships.toArray(),
  ]);
  const attached = new Set(memberships.map((item) => item.questionId));
  return questions.filter((question) => !attached.has(question.id));
}
