export type QuestionType = "判断" | "单选" | "多选";

export interface Bank {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  color?: string;
  folderId?: string;
  sortOrder?: number;
  updatedAt?: string;
  deviceId?: string;
  syncEventId?: string;
  questionCount: number;
  importedAt: string;
}

export interface BankFolder {
  id: string;
  name: string;
  description: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deviceId: string;
  syncEventId?: string;
}

export interface Question {
  id: string;
  bankId: string;
  bankName: string;
  sortOrder: number;
  stem: string;
  normalizedStem: string;
  answer: string;
  options: string[];
  type: QuestionType;
  tags: string[];
  favorite?: boolean;
  userUpdatedAt?: string;
  userUpdatedBy?: string;
  syncEventId?: string;
}

export type PracticeMode = "random30" | "randomCustom" | "sequential" | "randomAll" | "wrong" | "favorite" | "difficult" | "tag" | "advanced";

export interface PracticeAnswerState {
  selected: string[];
  submitted: boolean;
  correct?: boolean;
  updatedAt?: string;
  deviceId?: string;
  eventId?: string;
}

/**
 * Transient view state for the practice screen. PracticeRun is the only
 * persisted source of truth; this shape only adds the question currently
 * visible in React.
 */
export interface ActivePractice {
  id: "active";
  runId: string;
  bankId: string;
  bankIds?: string[];
  bankName: string;
  mode: PracticeMode;
  modeLabel: string;
  questionIds: string[];
  questionTypes?: Record<string, QuestionType>;
  currentIndex: number;
  lastAnsweredIndex?: number;
  answers: Record<string, PracticeAnswerState>;
  shuffleOptions?: boolean;
  optionOrders?: Record<string, number[]>;
  startedAt: string;
  updatedAt: string;
  revision: number;
}

export type PracticeRunStatus = "in_progress" | "completed" | "abandoned";

export interface PracticeRun {
  id: string;
  bankId: string;
  bankIds: string[];
  bankName: string;
  mode: PracticeMode;
  modeLabel: string;
  questionIds: string[];
  questionTypes: Record<string, QuestionType>;
  answers: Record<string, PracticeAnswerState>;
  shuffleOptions: boolean;
  optionOrders: Record<string, number[]>;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  abandonedAt?: string;
  status: PracticeRunStatus;
  revision: number;
  lastAnsweredIndex?: number;
  syncDeviceId?: string;
  syncEventId?: string;
  /** Local/remote checkpoint marker; the immutable v5 definition is already published. */
  definitionSynced?: boolean;
}

/** Immutable, potentially large part of a practice run stored once by Sync v5. */
export type PracticeRunDefinition = Pick<PracticeRun,
  "id" | "bankId" | "bankIds" | "bankName" | "mode" | "modeLabel" | "questionIds" |
  "questionTypes" | "shuffleOptions" | "optionOrders" | "startedAt"
>;

export interface PracticeRunDefinitionReference {
  definition: SyncHeadDescriptorV5;
}

export interface PracticeAnswerSyncPayload {
  runId: string;
  questionId: string;
  answer: PracticeAnswerState;
}

export interface PracticeRunStatusSyncPayload {
  id: string;
  status: PracticeRunStatus;
  updatedAt: string;
  revision: number;
  lastAnsweredIndex?: number;
  completedAt?: string;
  abandonedAt?: string;
}

export interface PracticeRunStats {
  bankId: string;
  total: number;
  completed: number;
  inProgress: number;
  abandoned: number;
  latestUpdatedAt: string;
}

export interface PracticeFilter {
  bankIds: string[];
  mode: PracticeMode;
  types: QuestionType[];
  tags: string[];
  tagMatch: "any" | "all";
  status: "all" | "unanswered" | "wrong" | "favorite";
  order: "sequential" | "random" | "difficulty";
  limit: number | null;
  keyword: string;
  keywordMode: "plain" | "regex";
  totalAttemptsMin: number | null;
  totalAttemptsMax: number | null;
  wrongAttemptsMin: number | null;
  wrongAttemptsMax: number | null;
  difficultyMin: number | null;
  difficultyMax: number | null;
  lastAttemptFrom: string;
  lastAttemptTo: string;
}

export interface Attempt {
  id: string;
  runId: string;
  questionId: string;
  bankId: string;
  selected: string;
  correct: boolean;
  elapsedMs: number;
  createdAt: string;
  deviceId: string;
}

export interface AttemptStats {
  questionId: string;
  bankId: string;
  total: number;
  correct: number;
  wrong: number;
  giveUps: number;
  totalElapsedMs: number;
  firstAttemptAt: string;
  firstAttemptCorrect: boolean;
  latestAttemptAt: string;
  hasBeenWrong: boolean;
  correctStreakAfterWrong: number;
  currentCorrectStreak: number;
  recentOutcomes: Array<{ id: string; createdAt: string; correct: boolean }>;
}

export interface AttemptDailyStats {
  key: string;
  date: string;
  questionId: string;
  bankId: string;
  total: number;
  correct: number;
  wrong: number;
  giveUps: number;
  totalElapsedMs: number;
}

export interface SyncMeta {
  key: string;
  value: unknown;
  updatedAt: string;
}

export type SyncArchiveEntryKind = "attempts" | "practice-runs";

/** A bounded local index of archive rows already materialised in the vault. */
export interface SyncArchiveEntry {
  key: string;
  kind: SyncArchiveEntryKind;
  id: string;
}

export interface Note {
  questionId: string;
  content: string;
  revision: number;
  updatedAt: string;
  deviceId: string;
  syncEventId?: string;
}

export type QuestionGroupType = "易混" | "相似" | "前置" | "重复" | "专题" | "自定义";

export interface QuestionGroupItem {
  questionId: string;
  note: string;
}

export interface QuestionGroup {
  id: string;
  name: string;
  type: QuestionGroupType;
  description: string;
  items: QuestionGroupItem[];
  createdAt: string;
  updatedAt: string;
  deviceId: string;
  syncEventId?: string;
}

export interface SyncEvent {
  id: string;
  type: "bank.imported" | "bank.updated" | "bank.deleted" | "bankFolder.saved" | "bankFolder.deleted" | "attempt.created" | "note.upserted" | "question.created" | "question.updated" | "question.deleted" | "practice.run.created" | "practice.answer.saved" | "practice.run.status.changed" | "practice.run.deleted" | "questionGroup.saved" | "questionGroup.deleted";
  payload: unknown;
  deviceId: string;
  sequence: number;
  createdAt: string;
  synced: 0 | 1;
}

export interface SyncFile {
  path: string;
  sha: string;
  appliedAt: string;
  remoteCache?: SyncCheckpointCache;
}

export interface SyncFileMarker {
  path: string;
  sha: string;
  appliedAt: string;
}

/**
 * A validated, bounded checkpoint kept for the instant local-restore path.
 *
 * `snapshot` is deliberately the checkpoint object that was already built by
 * the sync operation.  Restore code must not regenerate it by scanning every
 * local table just to populate this cache.
 */
export interface SyncCheckpointCache {
  owner: string;
  repo: string;
  branch: string;
  cachedAt: string;
  snapshot: SyncCheckpointV5;
  markers: SyncFileMarker[];
}

export type SyncEntityType = "bank" | "bankFolder" | "question" | "practiceRun" | "questionGroup";

export interface SyncTombstone {
  key: string;
  entityType: SyncEntityType;
  entityId: string;
  deletedAt: string;
  deviceId: string;
  eventId: string;
}

/**
 * An immutable v5 history segment.  The Git blob id (`blobSha`) identifies
 * the object in the remote store while `sha256` identifies the decoded bytes
 * and is also embedded in ordinary v5 paths.
 */
export interface SyncArchiveSegmentV5 {
  path: string;
  blobSha: string;
  sha256: string;
  size: number;
  month: string;
  count: number;
  firstId: string;
  lastId: string;
  firstCreatedAt: string;
  lastCreatedAt: string;
}

/** Immutable v5 catalog containing bounded attempt and practice-run history. */
export interface SyncArchiveCatalogV5 {
  formatVersion: 5;
  generatedAt: string;
  attemptSegments: SyncArchiveSegmentV5[];
  practiceRunSegments: SyncArchiveSegmentV5[];
  counts: {
    attempts: number;
    practiceRuns: number;
  };
}

export interface SyncCheckpointV5 {
  formatVersion: 5;
  generatedAt: string;
  state: {
    banks: Bank[];
    bankFolders: BankFolder[];
    questions: Question[];
    attemptStats: AttemptStats[];
    recentAttemptDailyStats: AttemptDailyStats[];
    recentAttempts: Attempt[];
    notes: Note[];
    recentPracticeRuns: PracticeRun[];
    practiceRunStats: PracticeRunStats[];
    questionGroups: QuestionGroup[];
    tombstones: SyncTombstone[];
  };
  cursors: Record<string, number>;
  retention: {
    recentAttemptLimit: number;
    recentPracticeRunLimit: number;
    dailyStatsDays: number;
    oldestRecentAttemptAt: string | null;
  };
  counts: {
    banks: number;
    bankFolders: number;
    questions: number;
    totalAttempts: number;
    recentAttempts: number;
    notes: number;
    totalPracticeRuns: number;
    recentPracticeRuns: number;
    questionGroups: number;
    tombstones: number;
  };
}

/**
 * The v5 hot index is the only mutable sync object.  Every object named by a
 * descriptor is immutable; publishing a new head therefore only changes the
 * small descriptor list below.  `blobSha` is the Git blob id while `sha256`
 * is the digest of the decoded file bytes.
 */
export interface SyncHeadDescriptorV5 {
  path: string;
  blobSha: string;
  sha256: string;
  size: number;
}

export interface SyncEventPageDescriptorV5 extends SyncHeadDescriptorV5 {
  count: number;
  /** Highest event sequence included from each device in this page. */
  deviceCursors: Record<string, number>;
}

export interface SyncHeadV5 {
  formatVersion: 5;
  generatedAt: string;
  checkpoint: SyncHeadDescriptorV5;
  archiveCatalog: SyncHeadDescriptorV5;
  eventPages: SyncEventPageDescriptorV5[];
}

/** Alias used by callers that refer to the v5 head as a manifest. */
export type SyncManifestV5 = SyncHeadV5;

export interface GitHubSettings {
  owner: string;
  repo: string;
  branch: string;
}
