import { dbV7 } from "./db-v7-core";
import type { ReviewRound, ReviewRoundBankV7, ReviewRoundItemV7, ReviewRoundRecordV7 } from "./v7-types";

function sortedBanks(rows: ReviewRoundBankV7[]): ReviewRoundBankV7[] {
  return rows.sort((left, right) => left.position - right.position || left.bankId.localeCompare(right.bankId));
}

function sortedItems(rows: ReviewRoundItemV7[]): ReviewRoundItemV7[] {
  return rows.sort((left, right) => left.position - right.position || left.questionId.localeCompare(right.questionId));
}

export async function hydrateReviewRoundV7(record: ReviewRoundRecordV7): Promise<ReviewRound> {
  const [banks, items] = await Promise.all([
    dbV7.reviewRoundBanks.where("roundId").equals(record.id).toArray(),
    dbV7.reviewRoundItems.where("roundId").equals(record.id).toArray(),
  ]);
  const finalQuestionIds = sortedItems(items).map((item) => item.questionId);
  return {
    ...record,
    bankIds: sortedBanks(banks).map((bank) => bank.bankId),
    ...(finalQuestionIds.length ? { finalQuestionIds } : {}),
  };
}

export async function hydrateReviewRoundsV7(records: readonly ReviewRoundRecordV7[]): Promise<ReviewRound[]> {
  if (!records.length) return [];
  const ids = records.map((record) => record.id);
  const [banks, items] = await Promise.all([
    dbV7.reviewRoundBanks.where("roundId").anyOf(ids).toArray(),
    dbV7.reviewRoundItems.where("roundId").anyOf(ids).toArray(),
  ]);
  const banksByRound = new Map<string, ReviewRoundBankV7[]>();
  const itemsByRound = new Map<string, ReviewRoundItemV7[]>();
  for (const row of banks) {
    const bucket = banksByRound.get(row.roundId) ?? [];
    bucket.push(row);
    banksByRound.set(row.roundId, bucket);
  }
  for (const row of items) {
    const bucket = itemsByRound.get(row.roundId) ?? [];
    bucket.push(row);
    itemsByRound.set(row.roundId, bucket);
  }
  return records.map((record) => {
    const finalQuestionIds = sortedItems(itemsByRound.get(record.id) ?? []).map((item) => item.questionId);
    return {
      ...record,
      bankIds: sortedBanks(banksByRound.get(record.id) ?? []).map((bank) => bank.bankId),
      ...(finalQuestionIds.length ? { finalQuestionIds } : {}),
    };
  });
}

export async function getReviewRoundV7(roundId: string): Promise<ReviewRound | undefined> {
  const record = await dbV7.reviewRounds.get(roundId);
  return record ? hydrateReviewRoundV7(record) : undefined;
}

export async function listReviewRoundsV7(): Promise<ReviewRound[]> {
  return hydrateReviewRoundsV7(await dbV7.reviewRounds.orderBy("updatedAt").reverse().toArray());
}

export async function putReviewRoundInTx(
  round: ReviewRound,
  options: { replaceBanks?: boolean; replaceItems?: boolean } = {},
): Promise<void> {
  const { bankIds, finalQuestionIds, ...record } = round;
  await dbV7.reviewRounds.put(record);
  if (options.replaceBanks !== false) {
    await dbV7.reviewRoundBanks.where("roundId").equals(round.id).delete();
    if (bankIds.length) {
      await dbV7.reviewRoundBanks.bulkPut(bankIds.map((bankId, position) => ({ roundId: round.id, bankId, position })));
    }
  }
  if (options.replaceItems ?? finalQuestionIds !== undefined) {
    await dbV7.reviewRoundItems.where("roundId").equals(round.id).delete();
    if (finalQuestionIds?.length) {
      await dbV7.reviewRoundItems.bulkPut(finalQuestionIds.map((questionId, position) => ({ roundId: round.id, questionId, position })));
    }
  }
}
