/** Format completion as a percentage with one fixed decimal place. */
export function questionOverviewProgress(answered: number, total: number): string {
  return `${(total > 0 ? answered / total * 100 : 0).toFixed(1)}%`;
}
