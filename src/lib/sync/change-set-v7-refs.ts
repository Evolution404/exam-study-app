import type { PracticeRunV7 } from "../db/v7-types";
import type { ChangeSetEntityRefV7, ChangeSetMutationV7 } from "./change-set-v7-types";

export function mutationEntityRefs(mutation: ChangeSetMutationV7): ChangeSetEntityRefV7[] {
  const add = (type: string, id: string): ChangeSetEntityRefV7 => ({ type, id });
  switch (mutation.kind) {
    case "bank.create": case "bank.update": return [add("bank", mutation.bank.id)];
    case "bank.reorder": return mutation.bankIds.map((id) => add("bank", id));
    case "bank.delete": case "bank.delete.cascade": return [add("bank", mutation.bankId)];
    case "bankFolder.save": return [add("bankFolder", mutation.folder.id)];
    case "bankFolder.delete": return [add("bankFolder", mutation.folderId)];
    case "question.upsert": return [add("question", mutation.question.id), ...[...mutation.question.content, ...mutation.question.options.flat()].filter((block) => block.type === "image").map((block) => add("imageAsset", block.assetId))];
    case "question.delete": case "question.delete.cascade": return [add("question", mutation.questionId)];
    case "question.split": return [add("question", mutation.originalQuestionId), add("question", mutation.clone.id)];
    case "question.import": return [add("bank", mutation.bank.id), ...mutation.questions.map((item) => add("question", item.id)), ...mutation.memberships.map((item) => add("membership", item.key)), ...(mutation.images ?? []).map((item) => add("imageAsset", item.id))];
    case "question.bulk.upsert": return mutation.questions.map((item) => add("question", item.id));
    case "question.bulk.delete": return mutation.questionIds.map((id) => add("question", id));
    case "membership.save": return [add("membership", mutation.membership.key), add("bank", mutation.membership.bankId), add("question", mutation.membership.questionId)];
    case "membership.remove": return [add("membership", mutation.key ?? `${mutation.bankId}:${mutation.questionId}`), add("bank", mutation.bankId), add("question", mutation.questionId)];
    case "membership.bulk.save": return mutation.memberships.flatMap((item) => [add("membership", item.key), add("bank", item.bankId), add("question", item.questionId)]);
    case "membership.bulk.remove": return mutation.keys.map((id) => add("membership", id));
    case "image.asset.save": return [add("imageAsset", mutation.asset.id)];
    case "image.asset.delete": return [add("imageAsset", mutation.assetId)];
    case "attempt.create": case "attempt.update": return [add("attempt", mutation.attempt.id), add("question", mutation.attempt.questionId)];
    case "attempt.delete": return [add("attempt", mutation.attemptId)];
    case "practice.answer.submitted": case "practice.answer.updated": return [add("attempt", mutation.attempt.id), add("practiceRun", mutation.runId), add("question", mutation.questionId)];
    case "practice.answer.deleted": return [add("attempt", mutation.attemptId), add("practiceRun", mutation.runId), add("question", mutation.questionId)];
    case "practice.run.saved": case "practice.run.status.changed": return [add("practiceRun", mutation.run.id), ...runRefs(mutation.run)];
    case "practice.run.deleted": return [add("practiceRun", mutation.runId)];
    case "note.upserted": return [add("note", mutation.note.questionId), add("question", mutation.note.questionId)];
    case "note.deleted": return [add("note", mutation.questionId), add("question", mutation.questionId)];
    case "questionGroup.saved": return [add("questionGroup", mutation.group.id)];
    case "questionGroup.deleted": return [add("questionGroup", mutation.groupId)];
    case "review.round.saved": case "review.round.completed": case "review.round.archived": return [add("reviewRound", mutation.round.id), ...mutation.round.bankIds.map((id) => add("bank", id))];
  }
}

function runRefs(run: PracticeRunV7): ChangeSetEntityRefV7[] {
  return [...new Set([...(run.bankIds ?? []), run.bankId])].filter(Boolean).map((id) => ({ type: "bank", id }))
    .concat(run.questionIds.map((id) => ({ type: "question", id })));
}

