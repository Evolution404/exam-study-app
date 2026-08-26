import { sha256DigestHex } from "../crypto/sha256";
import {
  CHANGE_SET_V7_DIGEST_PATTERN,
  CHANGE_SET_V7_FORMAT,
  type ChangeSetKindV7,
  type ChangeSetMutationV7,
  type ChangeSetV7,
  type CreateChangeSetV7Input,
} from "./change-set-v7-types";
import { mutationEntityRefs } from "./change-set-v7-refs";

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`invalid v7 change-set: ${message}`);
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`);
}

function assertSafeInteger(value: unknown, field: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(`${field} must be an integer >= ${minimum}`);
}

function assertIsoDate(value: unknown, field: string): asserts value is string {
  assertNonEmptyString(value, field);
  if (!Number.isFinite(Date.parse(value))) fail(`${field} must be an ISO timestamp`);
}

function assertDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !CHANGE_SET_V7_DIGEST_PATTERN.test(value)) fail(`${field} must be a lowercase SHA-256 digest`);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

/** Stable JSON serialization. Object key order is canonical; arrays are semantic order. */
export function canonicalSerializeV7(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Canonical immutable bytes exclude the digest and any queue publication state. */
export function canonicalChangeSetV7(changeSet: Omit<ChangeSetV7, "digest"> | ChangeSetV7): string {
  const content = { ...changeSet } as Partial<ChangeSetV7>;
  delete content.digest;
  return canonicalSerializeV7(content);
}

async function sha256(value: Uint8Array): Promise<string> {
  return sha256DigestHex(value);
}

function generatedId(deviceId: string, sequence: number): string {
  const random = globalThis.crypto?.randomUUID?.();
  return `${deviceId}:${sequence}:${random ?? "v7"}`;
}

function normalizeMutation(mutation: ChangeSetMutationV7): ChangeSetMutationV7 {
  const value = structuredClone(mutation);
  // Drop optional fields left undefined by callers (e.g. question.split.note
  // when the source has no note). Undefined survives structuredClone and would
  // otherwise trip validateMutationShapeV7's `field in value` checks.
  for (const key of Object.keys(value)) {
    if ((value as Record<string, unknown>)[key] === undefined) delete (value as Record<string, unknown>)[key];
  }
  if ("bankIds" in value && value.bankIds) value.bankIds = [...value.bankIds].sort();
  if ("questionIds" in value && value.questionIds) value.questionIds = [...value.questionIds].sort();
  if ("keys" in value && value.keys) value.keys = [...value.keys].sort();
  if (value.kind === "question.bulk.upsert") value.questions = [...value.questions].sort((a, b) => a.id.localeCompare(b.id));
  if (value.kind === "question.import") value.questions = [...value.questions].sort((a, b) => a.id.localeCompare(b.id));
  if ("memberships" in value && value.memberships) value.memberships = [...value.memberships].sort((a, b) => a.key.localeCompare(b.key));
  if ("images" in value && value.images) value.images = [...value.images].sort((a, b) => a.id.localeCompare(b.id));
  return value;
}

const mutationKindsV7 = new Set<ChangeSetKindV7>([
  "bank.create", "bank.update", "bank.reorder", "bank.delete", "bank.delete.cascade",
  "bankFolder.save", "bankFolder.delete", "question.upsert", "question.delete", "question.delete.cascade",
  "question.split", "question.import", "question.bulk.upsert", "question.bulk.delete", "membership.save",
  "membership.remove", "membership.bulk.save", "membership.bulk.remove", "image.asset.save", "image.asset.delete",
  "attempt.create", "attempt.update", "attempt.delete", "practice.answer.submitted", "practice.answer.updated",
  "practice.answer.deleted", "practice.run.saved", "practice.run.status.changed", "practice.run.deleted",
  "note.upserted", "note.deleted", "questionGroup.saved", "questionGroup.deleted", "review.round.saved",
  "review.round.completed", "review.round.archived",
]);

function validateMutationShapeV7(value: Record<string, unknown>): value is ChangeSetMutationV7 {
  if (typeof value.kind !== "string" || !mutationKindsV7.has(value.kind as ChangeSetKindV7)) return false;
  const requiresObject = ["bank", "folder", "question", "clone", "membership", "attempt", "answer", "run", "note", "group", "round", "asset"];
  for (const field of requiresObject) {
    if (field in value && !isRecord(value[field])) return false;
  }
  const requiresId = ["bankId", "folderId", "questionId", "originalQuestionId", "assetId", "attemptId", "runId", "groupId"];
  for (const field of requiresId) {
    if (field in value && (typeof value[field] !== "string" || !(value[field]).trim())) return false;
  }
  for (const field of ["bankIds", "questionIds", "keys", "questions", "memberships", "images"]) {
    if (field in value && !Array.isArray(value[field])) return false;
  }
  const hasString = (field: string): boolean => typeof value[field] === "string" && Boolean((value[field]).trim());
  const hasObject = (field: string): boolean => isRecord(value[field]);
  const arrayOfStrings = (field: string): boolean => !Array.isArray(value[field]) || (value[field] as unknown[]).every((item) => typeof item === "string" && Boolean(item.trim()));
  if (value.kind === "bank.create" || value.kind === "bank.update") return hasObject("bank");
  if (value.kind === "bank.reorder") return arrayOfStrings("bankIds");
  if (value.kind === "bank.delete" || value.kind === "bank.delete.cascade") return hasString("bankId");
  if (value.kind === "bankFolder.save") return hasObject("folder");
  if (value.kind === "bankFolder.delete") return hasString("folderId");
  if (value.kind === "question.upsert") return hasObject("question");
  if (value.kind === "question.delete" || value.kind === "question.delete.cascade") return hasString("questionId");
  if (value.kind === "question.split") return hasString("originalQuestionId") && hasObject("clone") && Array.isArray(value.memberships);
  if (value.kind === "question.import") return hasObject("bank") && Array.isArray(value.questions) && Array.isArray(value.memberships);
  if (value.kind === "question.bulk.upsert") return Array.isArray(value.questions);
  if (value.kind === "question.bulk.delete") return arrayOfStrings("questionIds");
  if (value.kind === "membership.save") return hasObject("membership");
  if (value.kind === "membership.remove") return hasString("bankId") && hasString("questionId");
  if (value.kind === "membership.bulk.save") return Array.isArray(value.memberships);
  if (value.kind === "membership.bulk.remove") return arrayOfStrings("keys");
  if (value.kind === "image.asset.save") return hasObject("asset");
  if (value.kind === "image.asset.delete") return hasString("assetId");
  if (value.kind === "attempt.create" || value.kind === "attempt.update") return hasObject("attempt");
  if (value.kind === "attempt.delete") return hasString("attemptId");
  if (value.kind === "practice.answer.submitted" || value.kind === "practice.answer.updated") return hasObject("attempt") && hasObject("answer") && hasString("runId") && hasString("questionId");
  if (value.kind === "practice.answer.deleted") return hasString("attemptId") && hasString("runId") && hasString("questionId");
  if (value.kind === "practice.run.saved" || value.kind === "practice.run.status.changed") return hasObject("run");
  if (value.kind === "practice.run.deleted") return hasString("runId");
  if (value.kind === "note.upserted") return hasObject("note");
  if (value.kind === "note.deleted") return hasString("questionId");
  if (value.kind === "questionGroup.saved") return hasObject("group");
  if (value.kind === "questionGroup.deleted") return hasString("groupId");
  if (value.kind === "review.round.saved" || value.kind === "review.round.completed" || value.kind === "review.round.archived") return hasObject("round");
  return true;
}

/** Construct a fully validated, digest-bearing immutable change set. */
export async function createChangeSetV7(input: CreateChangeSetV7Input): Promise<ChangeSetV7> {
  if (!isRecord(input)) fail("input must be an object");
  assertNonEmptyString(input.deviceId, "deviceId");
  assertSafeInteger(input.localSequence, "localSequence", 0);
  assertIsoDate(input.createdAt, "createdAt");
  const rawMutations = input.mutations ?? (input.mutation ? [input.mutation] : []);
  if (!rawMutations.length) fail("mutations must contain at least one mutation");
  const mutations = rawMutations.map(normalizeMutation);
  const inferredRefs = mutations.flatMap(mutationEntityRefs);
  const entityRefs = (input.entityRefs ? [...input.entityRefs] : inferredRefs)
    .map((ref, index) => {
      if (!isRecord(ref)) fail(`entityRefs[${index}] must be an object`);
      assertNonEmptyString(ref.type, `entityRefs[${index}].type`);
      assertNonEmptyString(ref.id, `entityRefs[${index}].id`);
      return { type: ref.type.trim(), id: ref.id.trim() };
    })
    .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  const payloadRefs = input.payloadRefs?.map((ref, index) => {
    if (!isRecord(ref)) fail(`payloadRefs[${index}] must be an object`);
    assertNonEmptyString(ref.path, `payloadRefs[${index}].path`);
    assertDigest(ref.sha256, `payloadRefs[${index}].sha256`);
    assertSafeInteger(ref.size, `payloadRefs[${index}].size`, 0);
    return { path: ref.path, sha256: ref.sha256, size: ref.size, ...(ref.kind ? { kind: ref.kind } : {}) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const computedKind: ChangeSetKindV7 = mutations.length === 1 ? mutations[0].kind : "batch";
  if (input.kind !== undefined && input.kind !== computedKind) fail(`kind ${input.kind} 与 mutations 不一致`);
  const base = {
    formatVersion: CHANGE_SET_V7_FORMAT,
    id: input.id?.trim() || generatedId(input.deviceId, input.localSequence),
    deviceId: input.deviceId.trim(),
    localSequence: input.localSequence,
    createdAt: new Date(input.createdAt).toISOString(),
    kind: computedKind,
    mutations,
    entityRefs,
    ...(payloadRefs?.length ? { payloadRefs } : {}),
  } as Omit<ChangeSetV7, "digest">;
  assertNonEmptyString(base.id, "id");
  const digest = await sha256(encoder.encode(canonicalChangeSetV7(base)));
  return { ...base, digest };
}

/** Runtime structural validation; digest recomputation is available separately. */
export function validateChangeSetV7(value: unknown): value is ChangeSetV7 {
  try {
    if (!isRecord(value)) return false;
    if (value.formatVersion !== CHANGE_SET_V7_FORMAT) return false;
    assertNonEmptyString(value.id, "id");
    assertNonEmptyString(value.deviceId, "deviceId");
    assertSafeInteger(value.localSequence, "localSequence", 0);
    assertIsoDate(value.createdAt, "createdAt");
    if (typeof value.kind !== "string" || !Array.isArray(value.mutations) || value.mutations.length === 0) return false;
    if ((value.kind === "batch") !== (value.mutations.length > 1)) return false;
    if (value.kind !== "batch" && value.kind !== (value.mutations[0] as ChangeSetMutationV7).kind) return false;
    value.mutations.forEach((mutation, index) => {
      if (!isRecord(mutation) || typeof mutation.kind !== "string" || !validateMutationShapeV7(mutation)) fail(`mutations[${index}] is invalid`);
    });
    if (!Array.isArray(value.entityRefs)) return false;
    value.entityRefs.forEach((ref, index) => {
      if (!isRecord(ref)) fail(`entityRefs[${index}] must be an object`);
      assertNonEmptyString(ref.type, `entityRefs[${index}].type`);
      assertNonEmptyString(ref.id, `entityRefs[${index}].id`);
    });
    if (value.payloadRefs !== undefined) {
      if (!Array.isArray(value.payloadRefs)) return false;
      value.payloadRefs.forEach((ref, index) => {
        if (!isRecord(ref)) fail(`payloadRefs[${index}] must be an object`);
        assertNonEmptyString(ref.path, `payloadRefs[${index}].path`);
        assertDigest(ref.sha256, `payloadRefs[${index}].sha256`);
        assertSafeInteger(ref.size, `payloadRefs[${index}].size`, 0);
      });
    }
    assertDigest(value.digest, "digest");
    return true;
  } catch {
    return false;
  }
}

export function assertChangeSetV7(value: unknown): asserts value is ChangeSetV7 {
  if (!validateChangeSetV7(value)) fail("value does not satisfy the v7 change-set schema");
}

export async function digestChangeSetV7(value: Omit<ChangeSetV7, "digest"> | ChangeSetV7): Promise<string> {
  return sha256(encoder.encode(canonicalChangeSetV7(value)));
}

export async function verifyChangeSetDigestV7(value: unknown): Promise<boolean> {
  if (!validateChangeSetV7(value)) return false;
  return (await digestChangeSetV7(value)) === value.digest;
}

export const isChangeSetV7 = validateChangeSetV7;
export const serializeChangeSetV7 = canonicalChangeSetV7;
export const validateChangeSetDigestV7 = verifyChangeSetDigestV7;
export const isChangeSetDigestValidV7 = verifyChangeSetDigestV7;

