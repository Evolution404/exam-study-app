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

export type PracticeMode = "random30" | "sequential" | "randomAll" | "wrong" | "favorite" | "difficult" | "tag" | "advanced";

export interface PracticeAnswerState {
  selected: string[];
  submitted: boolean;
  correct?: boolean;
}

export interface PracticeSession {
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
  type: "bank.imported" | "bank.updated" | "bank.deleted" | "bankFolder.saved" | "bankFolder.deleted" | "attempt.created" | "note.upserted" | "question.created" | "question.updated" | "question.deleted" | "practice.run.saved" | "practice.run.deleted" | "questionGroup.saved" | "questionGroup.deleted";
  payload: unknown;
  deviceId: string;
  createdAt: string;
  synced: 0 | 1;
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

export interface SyncSnapshotV2 {
  formatVersion: 2;
  generatedAt: string;
  state: {
    banks: Bank[];
    bankFolders: BankFolder[];
    questions: Question[];
    attempts: Attempt[];
    notes: Note[];
    practiceRuns: PracticeRun[];
    questionGroups: QuestionGroup[];
    tombstones: SyncTombstone[];
  };
  counts: {
    banks: number;
    bankFolders: number;
    questions: number;
    attempts: number;
    notes: number;
    practiceRuns: number;
    questionGroups: number;
    tombstones: number;
  };
}

export interface SyncManifestV2 {
  formatVersion: 2;
  generatedAt: string;
  snapshot: {
    path: string;
    sha256: string;
  };
  eventPrefix: string;
}

export interface GitHubSettings {
  owner: string;
  repo: string;
  branch: string;
}
