/** Practice-run deletion kept separate from the main answer/statistics module. */
import {
  studyDb,
  getDeviceId,
  makeId,
  nextSequence,
  nowIso,
  tombstoneKey,
} from "./db-core";
import { enqueueChangeSet } from "./db-change-sets";
import { updatePracticeRunStatsInTx } from "./db-practice-stats";
import { deletePracticeRunBundleInTx, getPracticeRun } from "./practice-run-store";

/** Remove the run projection without deleting global question learning stats. */
export async function deletePracticeRun(runId: string): Promise<boolean> {
  return studyDb.transaction("rw", [
    studyDb.practiceRuns,
    studyDb.practiceRunSources,
    studyDb.practiceRunItems,
    studyDb.practiceDrafts,
    studyDb.attempts,
    studyDb.bankPracticeStats,
    studyDb.bankPracticeRunIndex,
    studyDb.tombstones,
    studyDb.changeSets,
    studyDb.syncMeta,
  ], async () => {
    const current = await getPracticeRun(runId);
    if (!current) return false;
    const hasSubmittedAnswer = await studyDb.attempts.where("runId").equals(runId).count() > 0;
    const deletedAt = nowIso();
    const deviceId = getDeviceId();
    const runDeleteSequence = hasSubmittedAnswer ? await nextSequence(deviceId) : undefined;
    await updatePracticeRunStatsInTx(current, undefined);
    await deletePracticeRunBundleInTx(runId);
    if (!hasSubmittedAnswer || runDeleteSequence === undefined) return true;
    await studyDb.tombstones.put({
      key: tombstoneKey("practiceRun", runId),
      entityType: "practiceRun",
      entityId: runId,
      deletedAt,
      deviceId,
      eventId: makeId("run-delete"),
      sequence: runDeleteSequence,
    });
    await enqueueChangeSet(
      [{ kind: "practice.run.deleted", runId, deletedAt }],
      deletedAt,
      { localSequence: runDeleteSequence },
    );
    return true;
  });
}
