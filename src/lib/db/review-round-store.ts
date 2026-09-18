import { studyDb } from "./db-core";
import type { ReviewRound, ReviewRoundBank, ReviewRoundItem, ReviewRoundRecord } from "./types";

function sortedBanks(rows: ReviewRoundBank[]): ReviewRoundBank[] {
  return rows.sort((left, right) => left.position - right.position || left.bankId.localeCompare(right.bankId));
}

function sortedItems(rows: ReviewRoundItem[]): ReviewRoundItem[] {
  return rows.sort((left, right) => left.position - right.position || left.questionId.localeCompare(right.questionId));
}

export async function hydrateReviewRound(record: ReviewRoundRecord): Promise<ReviewRound> {
  const [banks, items] = await Promise.all([
    studyDb.reviewRoundBanks.where("roundId").equals(record.id).toArray(),
    studyDb.reviewRoundItems.where("roundId").equals(record.id).toArray(),
  ]);
  const finalQuestionIds = sortedItems(items).map((item) => item.questionId);
  return {
    ...record,
    bankIds: sortedBanks(banks).map((bank) => bank.bankId),
    ...(finalQuestionIds.length ? { finalQuestionIds } : {}),
  };
}

export async function hydrateReviewRounds(records: readonly ReviewRoundRecord[]): Promise<ReviewRound[]> {
  if (!records.length) return [];
  const ids = records.map((record) => record.id);
  const [banks, items] = await Promise.all([
    studyDb.reviewRoundBanks.where("roundId").anyOf(ids).toArray(),
    studyDb.reviewRoundItems.where("roundId").anyOf(ids).toArray(),
  ]);
  const banksByRound = new Map<string, ReviewRoundBank[]>();
  const itemsByRound = new Map<string, ReviewRoundItem[]>();
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

export async function getReviewRound(roundId: string): Promise<ReviewRound | undefined> {
  const record = await studyDb.reviewRounds.get(roundId);
  return record ? hydrateReviewRound(record) : undefined;
}

export async function listReviewRounds(): Promise<ReviewRound[]> {
  return hydrateReviewRounds(await studyDb.reviewRounds.orderBy("updatedAt").reverse().toArray());
}

export function reviewRoundBundle(round: ReviewRound): {
  record: ReviewRoundRecord;
  banks: ReviewRoundBank[];
  items: ReviewRoundItem[];
} {
  const { bankIds, finalQuestionIds, ...record } = round;
  return {
    record,
    banks: bankIds.map((bankId, position) => ({ roundId: round.id, bankId, position })),
    items: (finalQuestionIds ?? []).map((questionId, position) => ({ roundId: round.id, questionId, position })),
  };
}

export async function putReviewRoundInTx(
  round: ReviewRound,
  options: { replaceBanks?: boolean; replaceItems?: boolean } = {},
): Promise<void> {
  const bundle = reviewRoundBundle(round);
  await studyDb.reviewRounds.put(bundle.record);
  if (options.replaceBanks !== false) {
    await studyDb.reviewRoundBanks.where("roundId").equals(round.id).delete();
    if (bundle.banks.length) await studyDb.reviewRoundBanks.bulkPut(bundle.banks);
  }
  if (options.replaceItems ?? round.finalQuestionIds !== undefined) {
    await studyDb.reviewRoundItems.where("roundId").equals(round.id).delete();
    if (bundle.items.length) await studyDb.reviewRoundItems.bulkPut(bundle.items);
  }
}
