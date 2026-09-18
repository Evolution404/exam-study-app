/**
 * The local-first database.
 *
 * This module is deliberately a separate namespace from `lib/db.ts`. It
 * exposes only the current IndexedDB schema and domain operations.
 *
 * This file is a barrel over the `db-*` implementation modules. Keep the
 * facade intentionally narrow: only exports used by application/runtime code
 * belong here; tests and implementation modules should import siblings
 * directly when they need lower-level helpers.
 */
export {
  DATABASE_NAME,
  getDeviceId,
  studyDb,
  studyDbReady,
  resetDatabase,
} from "./db-core";
export type {
  PracticeAnswer,
  QuestionDraft,
  RestoreState,
} from "./db-core";

export {
  enqueueChangeSet,
  listChangeSets,
  claimPendingChangeSets,
  blockChangeSetSnapshot,
  commitChangeSetSnapshot,
  releaseChangeSetClaim,
  commitChangeSetClaim,
  discardPendingChangeSet,
} from "./db-change-sets";
export type {
  ChangeSetQueueRecord,
} from "./db-change-sets";

export {
  createBank,
  updateBank,
  reorderBanks,
  saveBankFolder,
  deleteBankFolder,
  getBankQuestionJoins,
  getBankQuestions,
  getQuestionsForBanks,
  listBankReadModels,
  deleteBank,
} from "./db-bank";

export {
  createQuestion,
  updateQuestion,
  updateQuestions,
  splitQuestion,
  addMembership,
  addMemberships,
  setQuestionMemberships,
  removeMembership,
  removeMemberships,
  deleteQuestions,
  deleteQuestion,
  deleteBankWithExclusiveQuestions,
  importQuestionBank,
  saveNote,
  saveQuestionGroup,
  listQuestionGroups,
  deleteQuestionGroup,
  toggleQuestionFavorite,
} from "./db-question";

export {
  savePracticeRun,
  savePracticeProgress,
  savePracticeDraft,
  getReviewRoundQuestionIds,
  createReviewRound,
  updateReviewRound,
  completeReviewRound,
  archiveReviewRound,
  setPracticeRunStatus,
  recordPracticeAnswer,
} from "./db-practice";

export {
  createPracticeRun,
} from "./db-practice-run-create";

export {
  getPracticeRun,
  bulkGetPracticeRuns,
} from "./practice-run-store";

export {
  getReviewRound,
  listReviewRounds,
} from "./review-round-store";

export {
  deletePracticeRun,
} from "./db-practice-delete";

export {
  putImageAsset,
  putImageAssetDescriptor,
  putImageAssetBlob,
  getImageAssetDescriptor,
  getImageAssetBlob,
  getImageCacheSize,
  clearImageCache,
} from "./db-images";

export {
  restoreLocalCheckpoint,
} from "./db-restore";
export type {
  ChangeSetQueueGuard,
} from "./db-restore";

export {
  reconcileProjection,
} from "./db-reconcile";
