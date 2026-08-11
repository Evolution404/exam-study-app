import type { PracticeRun, QuestionType } from "./types";

/** The question kinds currently supported by the v6 content model. */
export type QuestionTypeV6 = QuestionType;

export interface TextContentBlock {
  id: string;
  type: "text";
  text: string;
}

export interface ImageContentBlock {
  id: string;
  type: "image";
  assetId: string;
  alt?: string;
  caption?: string;
}

export type ContentBlock = TextContentBlock | ImageContentBlock;

/**
 * A question is content-addressed independently of the bank(s) that contain
 * it.  Bank membership is represented by BankQuestionMembership below.
 */
export interface QuestionV6 {
  id: string;
  type: QuestionTypeV6;
  content: ContentBlock[];
  options: ContentBlock[][];
  answer: string;
  tags: string[];
  favorite: boolean;
  contentFingerprint: string;
  updatedAt: string;
  deviceId: string;
}

export interface BankQuestionMembership {
  key: string;
  bankId: string;
  questionId: string;
  sortOrder: number;
  addedAt: string;
  updatedAt: string;
  deviceId: string;
}

export interface AttemptV6 {
  id: string;
  runId: string;
  questionId: string;
  selected: string;
  correct: boolean;
  elapsedMs: number;
  createdAt: string;
  deviceId: string;
  sourceBankId?: string;
}

export type ReviewRoundStatus = "active" | "completed" | "archived";

export interface ReviewRound {
  id: string;
  name: string;
  bankIds: string[];
  startedAt: string;
  status: ReviewRoundStatus;
  completedAt?: string;
  finalQuestionIds?: string[];
  createdAt: string;
  updatedAt: string;
  deviceId: string;
}

export interface ReviewRoundProgress {
  key: string;
  roundId: string;
  questionId: string;
  attempts: number;
  correct: number;
  wrong: number;
  firstAttemptAt: string;
  latestAttemptAt: string;
}

/** v6 only adds an optional review-round association to the existing run. */
export type PracticeRunV6 = PracticeRun & { reviewRoundId?: string };

/**
 * A remote image is an immutable blob-addressed object in the sync vault.
 * `blob` is the local browser cache and is deliberately not part of the
 * remote descriptor.
 */
export interface ImageAssetRemoteDescriptor {
  path: string;
  blobSha: string;
  sha256: string;
  size: number;
}

export interface ImageAsset {
  id: string;
  mimeType: "image/webp" | "image/jpeg" | "image/png";
  size: number;
  width: number;
  height: number;
  remote?: ImageAssetRemoteDescriptor;
  blob?: Blob;
}
