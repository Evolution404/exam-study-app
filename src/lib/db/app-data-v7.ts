import { dbV7, getBankQuestionJoinsV7 } from "./db-v7";
import { deriveContentText, deriveSearchText, summarizeContent } from "../question/question-content";
import type { BankQuestionMembership, BankV7, QuestionV7 } from "./v7-types";
import { formatCalculationAnswers, stableQuestionOptionIds } from "../question/question-utils";

/**
 * A presentation-only join.  Bank identity and ordering remain membership
 * data; they are never copied onto the canonical QuestionV7 row.
 */
export interface QuestionViewV7 {
  question: QuestionV7;
  memberships: BankQuestionMembership[];
  banks: BankV7[];
  sourceBankId?: string;
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

export function questionAnswerTextV7(question: QuestionV7): string {
  const solution = question.solution;
  if (solution.kind === "choice") {
    const optionIds = stableQuestionOptionIds(question);
    return solution.correctOptionIds
      .map((id) => optionIds.indexOf(id))
      .filter((index) => index >= 0)
      .map((index) => deriveContentText(question.options[index] ?? []))
      .filter(Boolean)
      .join("、");
  }
  if (solution.kind === "calculation") {
    return formatCalculationAnswers(solution.blanks.map((blank) => String(blank.expected)));
  }
  if (solution.kind === "fill") {
    return solution.blanks
      .map((blank, index) => `第${index + 1}空：${blank.acceptedAnswers.join(" / ")}`)
      .join("；");
  }
  return solution.referenceText;
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

export async function listQuestionViewsForBankV7(bankId: string): Promise<QuestionViewV7[]> {
  const rows = await getBankQuestionJoinsV7(bankId);
  const bank = await dbV7.banks.get(bankId);
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
