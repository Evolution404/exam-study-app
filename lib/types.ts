export type QuestionType = "判断" | "单选" | "多选";

export interface Bank {
  id: string;
  name: string;
  questionCount: number;
  importedAt: string;
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
}

export interface Attempt {
  id: string;
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
}

export interface Relation {
  id: string;
  fromQuestionId: string;
  toQuestionId: string;
  type: "易混" | "相似" | "前置" | "重复";
  createdAt: string;
  deviceId: string;
}

export interface SyncEvent {
  id: string;
  type: "bank.imported" | "attempt.created" | "note.upserted" | "relation.created";
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

export interface GitHubSettings {
  owner: string;
  repo: string;
  branch: string;
}
