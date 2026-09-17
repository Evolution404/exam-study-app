/** Practice-run deletion kept separate from the main answer/statistics module. */
import {
  dbV7,
  getV7DeviceId,
  makeV7Id,
  nextV7Sequence,
  nowIso,
  tombstoneKey,
} from "./db-v7-core";
import { enqueueChangeSetV7 } from "./db-v7-change-sets";
import { updatePracticeRunStatsInTx } from "./db-v7-practice-stats";
import { deletePracticeRunBundleInTx, getPracticeRunV7 } from "./practice-run-store-v7";

/** Remove the run projection without deleting global question learning stats. */
export async function deletePracticeRunV7(runId: string): Promise<boolean> {
  return dbV7.transaction("rw", [
    dbV7.practiceRuns,
    dbV7.practiceRunSources,
    dbV7.practiceRunItems,
    dbV7.attempts,
    dbV7.bankPracticeStats,
    dbV7.tombstones,
    dbV7.changeSets,
    dbV7.syncMeta,
  ], async () => {
    const current = await getPracticeRunV7(runId);
    if (!current) return false;
    const hasSubmittedAnswer = await dbV7.attempts.where("runId").equals(runId).count() > 0;
    const deletedAt = nowIso();
    const deviceId = getV7DeviceId();
    const runDeleteSequence = hasSubmittedAnswer ? await nextV7Sequence(deviceId) : undefined;
    await updatePracticeRunStatsInTx(current, undefined);
    await deletePracticeRunBundleInTx(runId);
    if (!hasSubmittedAnswer || runDeleteSequence === undefined) return true;
    await dbV7.tombstones.put({
      key: tombstoneKey("practiceRun", runId),
      entityType: "practiceRun",
      entityId: runId,
      deletedAt,
      deviceId,
      eventId: makeV7Id("run-delete"),
      sequence: runDeleteSequence,
    });
    await enqueueChangeSetV7(
      [{ kind: "practice.run.deleted", runId, deletedAt }],
      deletedAt,
      { localSequence: runDeleteSequence },
    );
    return true;
  });
}
