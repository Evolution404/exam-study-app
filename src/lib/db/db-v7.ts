/**
 * The v7 local-first database.
 *
 * This module is deliberately a separate namespace from `lib/db.ts`.  It
 * never imports the legacy database (doing so would construct the old
 * Dexie instance) and it does not contain an upgrade or migration path.
 * Consumers can opt into v7 incrementally while the v5 UI continues to use
 * its own database.
 *
 * This file is now a barrel: the implementation is split into the `db-v7-*`
 * sibling modules while the public surface stays identical.
 */
export {
  V7_DATABASE_NAME,
  makeV7Id,
  getV7DeviceId,
  dbV7,
  v7Db,
  dbV7Ready,
  V7StudyDatabase,
  resetV7Database,
} from "./db-v7-core";
export type {
  PracticeAnswerV7,
  PracticeAnswerInputV7,
  QuestionDraftV7,
  BankQuestionJoinV7,
  CreatePracticeRunInputV7,
  V7RestoreState,
} from "./db-v7-core";

export {
  enqueueChangeSetV7,
  listChangeSetsV7,
  claimPendingChangeSetsV7,
  releaseChangeSetClaimV7,
  commitChangeSetClaimV7,
  discardPendingChangeSetV7,
} from "./db-v7-change-sets";
export type {
  ChangeSetQueueStateV7,
  ChangeSetQueueRecordV7,
} from "./db-v7-change-sets";

export {
  createBankV7,
  updateBankV7,
  reorderBanksV7,
  saveBankFolderV7,
  deleteBankFolderV7,
  getBankQuestionJoinsV7,
  getBankQuestionMembershipsV7,
  getBankQuestionsV7,
  getQuestionsForBanksV7,
  queryBankQuestionsV7,
  listBankQuestionsV7,
  deleteBankV7,
  deleteBankOnlyV7,
} from "./db-v7-bank";

export {
  createQuestionV7,
  updateQuestionV7,
  updateSharedQuestionV7,
  splitQuestionV7,
  splitQuestion,
  removeMembershipV7,
  removeMembershipsV7,
  deleteQuestionsV7,
  deleteQuestionV7,
  deleteQuestionGlobalV7,
  deleteBankWithExclusiveQuestionsV7,
  importQuestionBankV7,
  importTextJsonBankV7,
  importBankV7,
  saveNoteV7,
  upsertNoteV7,
  saveQuestionGroupV7,
  deleteQuestionGroupV7,
  toggleQuestionFavoriteV7,
} from "./db-v7-question";

export {
  createPracticeRunV7,
  savePracticeRunV7,
  savePracticeProgressV7,
  getReviewRoundQuestionIdsV7,
  getRoundQuestionIdsV7,
  createReviewRoundV7,
  updateReviewRoundV7,
  completeReviewRoundV7,
  archiveReviewRoundV7,
  archiveRoundV7,
  setPracticeRunStatusV7,
  deletePracticeRunV7,
  recordPracticeAnswerV7,
} from "./db-v7-practice";

export {
  putImageAssetV7,
  putImageAssetDescriptorV7,
  putImageAssetBlobV7,
  getImageAssetV7,
  getImageAssetDescriptorV7,
  getImageAssetBlobV7,
  getImageCacheSizeV7,
  clearImageCacheV7,
  putImageAssetDescriptor,
  putImageAssetBlob,
  getImageAssetDescriptor,
  getImageAssetBlob,
  getImageCacheSize,
  clearImageCache,
} from "./db-v7-images";

export {
  restoreV7Checkpoint,
} from "./db-v7-restore";
