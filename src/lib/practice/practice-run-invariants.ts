import type { PracticeRun } from "../db/types";

type PracticeRunMappings = Pick<PracticeRun, "questionTypes" | "answers" | "optionOrders"> & { questionIds: readonly string[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(value: unknown): boolean {
  return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

export function restrictPracticeRunMappings(run: PracticeRun): PracticeRun {
  const questionIds = new Set(run.questionIds);
  return {
    ...run,
    questionTypes: Object.fromEntries(Object.entries(run.questionTypes).filter(([questionId]) => questionIds.has(questionId))),
    answers: Object.fromEntries(Object.entries(run.answers).filter(([questionId]) => questionIds.has(questionId))),
    optionOrders: Object.fromEntries(Object.entries(run.optionOrders).filter(([questionId]) => questionIds.has(questionId))),
  };
}

export function practiceRunMappingIssue(run: PracticeRunMappings): { field: "questionTypes" | "answers" | "optionOrders"; questionId: string } | undefined {
  const questionIds = new Set(run.questionIds);
  for (const field of ["questionTypes", "answers", "optionOrders"] as const) {
    for (const questionId of Object.keys(run[field])) if (!questionIds.has(questionId)) return { field, questionId };
  }
  return undefined;
}

export function practiceRunPayloadIssue(value: Record<string, unknown>, questionIds: readonly string[]): string | undefined {
  if (!isRecord(value.questionTypes)) return "questionTypes must be an object";
  if (!isRecord(value.answers)) return "answers must be an object";
  if (typeof value.shuffleOptions !== "boolean" || !isRecord(value.optionOrders)) return "option state is invalid";
  const mappingIssue = practiceRunMappingIssue({
    questionIds,
    questionTypes: value.questionTypes as PracticeRun["questionTypes"],
    answers: value.answers as PracticeRun["answers"],
    optionOrders: value.optionOrders as PracticeRun["optionOrders"],
  });
  if (mappingIssue) return `${mappingIssue.field} key ${mappingIssue.questionId} is outside questionIds`;
  if (!validDate(value.startedAt)) return "startedAt must be an ISO timestamp";
  if (!validDate(value.updatedAt)) return "updatedAt must be an ISO timestamp";
  if (!["in_progress", "completed", "abandoned"].includes(String(value.status))) return "status is invalid";
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return "revision must be a safe integer >= 0";
  if (value.completedAt !== undefined && !validDate(value.completedAt)) return "completedAt must be an ISO timestamp";
  if (value.abandonedAt !== undefined && !validDate(value.abandonedAt)) return "abandonedAt must be an ISO timestamp";
  return undefined;
}
