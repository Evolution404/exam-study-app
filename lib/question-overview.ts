interface OverviewAnswerState {
  submitted?: boolean;
}

/** Choose the question row that should be brought into view when the overview opens. */
export function questionOverviewFocusIndex(
  questionIds: readonly string[],
  answers: Readonly<Record<string, OverviewAnswerState | undefined>>,
): number {
  const lastIndex = questionIds.length - 1;
  if (lastIndex < 0) return -1;
  if (!answers[questionIds[lastIndex]]?.submitted) return lastIndex;

  const firstUnanswered = questionIds.findIndex((id) => !answers[id]?.submitted);
  return firstUnanswered >= 0 ? firstUnanswered : lastIndex;
}

/** Format completion as a percentage with one fixed decimal place. */
export function questionOverviewProgress(answered: number, total: number): string {
  return `${(total > 0 ? answered / total * 100 : 0).toFixed(1)}%`;
}
