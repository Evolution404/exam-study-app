import { dbV7, uniqueStrings } from "./db-v7-core";
import type { PracticeRunV7 } from "./v7-types";

/** internal：练习 run 的题库归属，按 bankIds 优先回退到 bankId。 */
function runBankIds(run: Pick<PracticeRunV7, "bankId" | "bankIds">): string[] {
  return uniqueStrings(run.bankIds?.length ? run.bankIds : [run.bankId]);
}

/** internal：在事务内维护 device-local bankPracticeStats。 */
export async function updatePracticeRunStatsInTx(previous: PracticeRunV7 | undefined, next: PracticeRunV7 | undefined): Promise<void> {
  const bankIds = new Set([...runBankIds(previous ?? { bankId: "", bankIds: [] }), ...runBankIds(next ?? { bankId: "", bankIds: [] })]);
  for (const bankId of bankIds) {
    if (!bankId) continue;
    const current = await dbV7.bankPracticeStats.get(bankId) ?? { bankId, total: 0, completed: 0, inProgress: 0, abandoned: 0, latestActivityAt: "" };
    if (previous && runBankIds(previous).includes(bankId)) {
      current.total = Math.max(0, current.total - 1);
      if (previous.status === "completed") current.completed = Math.max(0, current.completed - 1);
      else if (previous.status === "abandoned") current.abandoned = Math.max(0, current.abandoned - 1);
      else current.inProgress = Math.max(0, current.inProgress - 1);
    }
    if (next && runBankIds(next).includes(bankId)) {
      current.total += 1;
      if (next.status === "completed") current.completed += 1;
      else if (next.status === "abandoned") current.abandoned += 1;
      else current.inProgress += 1;
      current.latestActivityAt = current.latestActivityAt > next.updatedAt ? current.latestActivityAt : next.updatedAt;
    }
    if (current.total) await dbV7.bankPracticeStats.put(current);
    else await dbV7.bankPracticeStats.delete(bankId);
  }
}
