export type QuestionType = "判断" | "单选" | "多选" | "计算";

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
  imageUrl?: string;
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
  /** Local/remote checkpoint marker; the immutable run definition is already published. */
  definitionSynced?: boolean;
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

export interface SyncFile {
  path: string;
  sha: string;
  appliedAt: string;
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
export interface GitHubSettings {
  owner: string;
  repo: string;
  branch: string;
}
