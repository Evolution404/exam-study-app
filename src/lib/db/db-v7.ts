/**
 * The v7 local-first database.
 *
 * This module is deliberately a separate namespace from `lib/db.ts`. It
 * never imports the legacy database (doing so would construct the old
 * Dexie instance) and it does not contain an upgrade or migration path.
 *
 * This file is a barrel over the `db-v7-*` implementation modules. Keep the
 * facade intentionally narrow: only exports used by application/runtime code
 * belong here; tests and implementation modules should import siblings
 * directly when they need lower-level helpers.
 */
export {
  V7_DATABASE_NAME,
  getV7DeviceId,
  dbV7,
  dbV7Ready,
  resetV7Database,
  dropLegacyLocalDatabases,
} from "./db-v7-core";
export type {
  PracticeAnswerV7,
  QuestionDraftV7,
  V7RestoreState,
} from "./db-v7-core";

export {
  enqueueChangeSetV7,
  listChangeSetsV7,
  claimPendingChangeSetsV7,
  blockChangeSetSnapshotV7,
  commitChangeSetSnapshotV7,
  releaseChangeSetClaimV7,
  commitChangeSetClaimV7,
  discardPendingChangeSetV7,
} from "./db-v7-change-sets";
export type {
  ChangeSetQueueRecordV7,
} from "./db-v7-change-sets";

export {
  createBankV7,
  updateBankV7,
  reorderBanksV7,
  saveBankFolderV7,
  deleteBankFolderV7,
  getBankQuestionJoinsV7,
  getBankQuestionsV7,
  getQuestionsForBanksV7,
  deleteBankV7,
} from "./db-v7-bank";

export {
  createQuestionV7,
  updateQuestionV7,
  splitQuestionV7,
  removeMembershipV7,
  removeMembershipsV7,
  deleteQuestionsV7,
  deleteQuestionV7,
  deleteBankWithExclusiveQuestionsV7,
  importQuestionBankV7,
  saveNoteV7,
  saveQuestionGroupV7,
  deleteQuestionGroupV7,
  toggleQuestionFavoriteV7,
} from "./db-v7-question";

export {
  createPracticeRunV7,
  savePracticeRunV7,
  savePracticeProgressV7,
  getReviewRoundQuestionIdsV7,
  createReviewRoundV7,
  updateReviewRoundV7,
  completeReviewRoundV7,
  archiveReviewRoundV7,
  setPracticeRunStatusV7,
  deletePracticeRunV7,
  recordPracticeAnswerV7,
  rebuildAttemptStatsFromAttemptsV7,
} from "./db-v7-practice";

export {
  putImageAssetV7,
  putImageAssetDescriptorV7,
  putImageAssetBlobV7,
  getImageAssetDescriptorV7,
  getImageAssetBlobV7,
  getImageCacheSizeV7,
  clearImageCacheV7,
} from "./db-v7-images";

export {
  restoreV7Checkpoint,
} from "./db-v7-restore";
export type {
  V7ChangeSetQueueGuard,
} from "./db-v7-restore";

export {
  reconcileV7Projection,
} from "./db-v7-reconcile";
export type {
  ReconcileV7ProjectionOptions,
  ReconcileV7ProjectionProgress,
} from "./db-v7-reconcile";
