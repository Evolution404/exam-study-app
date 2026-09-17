import { studyDb, getBankQuestionJoins } from "./db";
import { getBankQuestionJoinsForBanks } from "./db-bank";
import { deriveContentText, deriveSearchText, summarizeContent } from "../question/question-content";
import type { BankQuestionMembership, Bank, Question } from "./types";
export { questionAnswerText } from "../question/question-answer-text";

/**
 * A presentation-only join. Bank identity and ordering remain membership
 * data; they are never copied onto the canonical Question row.
 */
export interface QuestionView {
  question: Question;
  memberships: BankQuestionMembership[];
  banks: Bank[];
  sourceBankId?: string;
}

export interface QuestionMembershipView {
  questionId: string;
  memberships: BankQuestionMembership[];
  banks: Bank[];
}

export interface QuestionPlainView {
  stem: string;
  options: string[];
  searchText: string;
  summary: string;
}

export function questionPlainView(question: Question): QuestionPlainView {
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

export async function getQuestionView(questionId: string, preferredBankId?: string): Promise<QuestionView | undefined> {
  const question = await studyDb.questions.get(questionId);
  if (!question) return undefined;
  const memberships = await studyDb.bankQuestionMemberships.where("questionId").equals(questionId).toArray();
  memberships.sort((left, right) => left.bankId.localeCompare(right.bankId) || left.sortOrder - right.sortOrder);
  const banks = (await studyDb.banks.bulkGet(memberships.map((item) => item.bankId))).filter(Boolean) as Bank[];
  const sourceBankId = preferredBankId && memberships.some((item) => item.bankId === preferredBankId)
    ? preferredBankId
    : memberships[0]?.bankId;
  return { question, memberships, banks, sourceBankId };
}

/** Batch membership read-model used by bank-management screens. */
export async function listQuestionMembershipViews(questionIds: readonly string[]): Promise<QuestionMembershipView[]> {
  const ids = [...new Set(questionIds.filter(Boolean))];
  if (!ids.length) return [];
  const memberships = await studyDb.bankQuestionMemberships.where("questionId").anyOf(ids).toArray();
  const bankIds = [...new Set(memberships.map((membership) => membership.bankId))];
  const bankMap = new Map((await studyDb.banks.bulkGet(bankIds)).filter(Boolean).map((bank) => [bank!.id, bank!]));
  const grouped = new Map<string, BankQuestionMembership[]>();
  for (const membership of memberships) grouped.set(membership.questionId, [...(grouped.get(membership.questionId) ?? []), membership]);
  return ids.map((questionId) => {
    const rows = [...(grouped.get(questionId) ?? [])].sort((left, right) => left.bankId.localeCompare(right.bankId) || left.sortOrder - right.sortOrder);
    return {
      questionId,
      memberships: rows,
      banks: rows.map((membership) => bankMap.get(membership.bankId)).filter((bank): bank is Bank => Boolean(bank)),
    };
  });
}

export async function listQuestionViewsForBank(bankId: string): Promise<QuestionView[]> {
  const rows = await getBankQuestionJoins(bankId);
  if (!rows.length) return [];
  const membershipViews = await listQuestionMembershipViews(rows.map((row) => row.question.id));
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
export async function listQuestionViewsAvailableFromOtherBanks(bankId: string): Promise<QuestionView[]> {
  const otherBanks = (await studyDb.banks.toArray()).filter((bank) => bank.id !== bankId);
  if (!otherBanks.length) return [];
  const sourceMemberships = await studyDb.bankQuestionMemberships.where("bankId").anyOf(otherBanks.map((bank) => bank.id)).toArray();
  const questionIds = [...new Set(sourceMemberships.map((membership) => membership.questionId))];
  if (!questionIds.length) return [];
  const [questions, membershipViews] = await Promise.all([
    studyDb.questions.bulkGet(questionIds),
    listQuestionMembershipViews(questionIds),
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
export async function listQuestionViewsForBanks(bankIds: readonly string[]): Promise<QuestionView[]> {
  const selected = [...new Set(bankIds)];
  const rows = await getBankQuestionJoinsForBanks(selected);
  const bankMap = new Map((await studyDb.banks.bulkGet(selected)).filter(Boolean).map((bank) => [bank!.id, bank!]));
  const views = new Map<string, QuestionView>();
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

export async function listUnfiledQuestions(): Promise<Question[]> {
  const [questionIds, memberships] = await Promise.all([
    studyDb.questions.toCollection().primaryKeys(),
    studyDb.bankQuestionMemberships.toArray(),
  ]);
  const attached = new Set(memberships.map((item) => item.questionId));
  const unfiledIds = questionIds.filter((id): id is string => typeof id === "string" && !attached.has(id));
  return (await studyDb.questions.bulkGet(unfiledIds)).filter((question): question is Question => Boolean(question));
}
