import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const owner = process.env.VAULT_OWNER || "Evolution404";
const repo = process.env.VAULT_REPO || "exam-study-vault";
const branch = process.env.VAULT_BRANCH || "main";
const apply = process.argv.includes("--apply");
const allowedBank = /^送电线路工-(初级工|中级工|高级工|技师)$/;

function gh(args, input) {
  return execFileSync("gh", args, { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function api(path, method = "GET", body) {
  const args = ["api", path];
  if (method !== "GET") args.push("--method", method);
  if (body !== undefined) args.push("--input", "-");
  const output = gh(args, body === undefined ? undefined : JSON.stringify(body));
  return output ? JSON.parse(output) : undefined;
}

function compareClock(leftTime = "", leftDevice = "", leftTie = "", rightTime = "", rightDevice = "", rightTie = "") {
  return leftTime.localeCompare(rightTime) || leftDevice.localeCompare(rightDevice) || leftTie.localeCompare(rightTie);
}

function readBlob(sha) {
  const blob = api(`repos/${owner}/${repo}/git/blobs/${sha}`);
  return Buffer.from(blob.content.replace(/\n/g, ""), "base64").toString("utf8");
}

function tombstoneKey(type, id) { return `${type}:${id}`; }

const state = {
  banks: new Map(), bankFolders: new Map(), questions: new Map(), attempts: new Map(), notes: new Map(),
  practiceRuns: new Map(), questionGroups: new Map(), tombstones: new Map(),
};

function putTombstone(entityType, entityId, event) {
  const payload = event.payload || {};
  const incoming = {
    key: tombstoneKey(entityType, entityId), entityType, entityId,
    deletedAt: payload.deletedAt || event.createdAt, deviceId: event.deviceId, eventId: event.id,
  };
  const current = state.tombstones.get(incoming.key);
  if (!current || compareClock(incoming.deletedAt, incoming.deviceId, incoming.eventId, current.deletedAt, current.deviceId, current.eventId) > 0) state.tombstones.set(incoming.key, incoming);
}

function isDeletedAfter(type, id, changedAt = "", deviceId = "", tie = "") {
  const deleted = state.tombstones.get(tombstoneKey(type, id));
  return Boolean(deleted && compareClock(deleted.deletedAt, deleted.deviceId, deleted.eventId, changedAt, deviceId, tie) >= 0);
}

function deleteQuestion(id) {
  state.questions.delete(id);
  for (const [key, attempt] of state.attempts) if (attempt.questionId === id) state.attempts.delete(key);
  state.notes.delete(id);
  for (const [key, group] of state.questionGroups) {
    const items = group.items.filter((item) => item.questionId !== id);
    if (items.length) state.questionGroups.set(key, { ...group, items }); else state.questionGroups.delete(key);
  }
}

function deleteBank(id) {
  const questionIds = new Set([...state.questions.values()].filter((question) => question.bankId === id).map((question) => question.id));
  for (const questionId of questionIds) deleteQuestion(questionId);
  for (const [key, attempt] of state.attempts) if (attempt.bankId === id) state.attempts.delete(key);
  for (const [key, run] of state.practiceRuns) if (run.bankId === id || run.bankIds?.includes(id)) state.practiceRuns.delete(key);
  state.banks.delete(id);
}

function replay(event) {
  const payload = event.payload;
  if (event.type === "bank.imported") {
    if (!payload?.bank || !allowedBank.test(payload.bank.name) || isDeletedAfter("bank", payload.bank.id, event.createdAt, event.deviceId, event.id)) return;
    const remoteBank = { ...payload.bank, deviceId: payload.bank.deviceId || event.deviceId, syncEventId: event.id };
    const current = state.banks.get(payload.bank.id);
    const bank = current ? { ...remoteBank, displayName: current.displayName, description: current.description, color: current.color, folderId: current.folderId, sortOrder: current.sortOrder, updatedAt: current.updatedAt, deviceId: current.deviceId, syncEventId: current.syncEventId } : remoteBank;
    state.banks.set(bank.id, bank);
    for (const remote of payload.questions || []) {
      const incoming = remote.userUpdatedAt ? { ...remote, syncEventId: event.id } : { ...remote, bankName: bank.displayName?.trim() || bank.name, tags: [], syncEventId: event.id };
      if (isDeletedAfter("question", incoming.id, incoming.userUpdatedAt || event.createdAt, incoming.userUpdatedBy || event.deviceId, event.id)) continue;
      const existing = state.questions.get(incoming.id);
      state.questions.set(incoming.id, existing?.userUpdatedAt ? existing : incoming);
    }
  } else if (event.type === "bank.updated") {
    const incoming = { ...payload, syncEventId: event.id };
    const changedAt = incoming.updatedAt || event.createdAt;
    if (isDeletedAfter("bank", incoming.id, changedAt, incoming.deviceId || event.deviceId, event.id)) return;
    const current = state.banks.get(incoming.id);
    if (!current || compareClock(changedAt, incoming.deviceId || event.deviceId, event.id, current.updatedAt || current.importedAt, current.deviceId, current.syncEventId) > 0) {
      state.banks.set(incoming.id, incoming);
      for (const [id, question] of state.questions) if (question.bankId === incoming.id) state.questions.set(id, { ...question, bankName: incoming.displayName?.trim() || incoming.name });
    }
  } else if (event.type === "bank.deleted") {
    putTombstone("bank", payload.id, event); deleteBank(payload.id);
  } else if (event.type === "bankFolder.saved") {
    const incoming = { ...payload, syncEventId: event.id };
    if (isDeletedAfter("bankFolder", incoming.id, incoming.updatedAt, incoming.deviceId, event.id)) return;
    const current = state.bankFolders.get(incoming.id);
    if (!current || compareClock(incoming.updatedAt, incoming.deviceId, event.id, current.updatedAt, current.deviceId, current.syncEventId) > 0) state.bankFolders.set(incoming.id, incoming);
  } else if (event.type === "bankFolder.deleted") {
    putTombstone("bankFolder", payload.id, event); state.bankFolders.delete(payload.id);
    for (const [id, bank] of state.banks) if (bank.folderId === payload.id) state.banks.set(id, { ...bank, folderId: undefined });
  } else if (event.type === "attempt.created") {
    if (payload?.id && state.questions.has(payload.questionId)) state.attempts.set(payload.id, payload);
  } else if (event.type === "note.upserted") {
    const incoming = { ...payload, syncEventId: event.id };
    if (!state.questions.has(incoming.questionId)) return;
    const current = state.notes.get(incoming.questionId);
    if (!current || compareClock(incoming.updatedAt, incoming.deviceId, event.id, current.updatedAt, current.deviceId, current.syncEventId) > 0) state.notes.set(incoming.questionId, incoming);
  } else if (event.type === "practice.run.saved") {
    const incoming = { ...payload, syncDeviceId: event.deviceId, syncEventId: event.id };
    if (isDeletedAfter("practiceRun", incoming.id, incoming.updatedAt, event.deviceId, event.id)) return;
    const current = state.practiceRuns.get(incoming.id);
    if (!current || incoming.revision > current.revision || (incoming.revision === current.revision && compareClock(incoming.updatedAt, incoming.syncDeviceId, incoming.syncEventId, current.updatedAt, current.syncDeviceId, current.syncEventId) > 0)) state.practiceRuns.set(incoming.id, incoming);
  } else if (event.type === "practice.run.deleted") {
    putTombstone("practiceRun", payload.id, event); state.practiceRuns.delete(payload.id);
  } else if (event.type === "questionGroup.saved") {
    const incoming = { ...payload, syncEventId: event.id };
    if (isDeletedAfter("questionGroup", incoming.id, incoming.updatedAt, incoming.deviceId, event.id)) return;
    const items = incoming.items.filter((item) => state.questions.has(item.questionId));
    const current = state.questionGroups.get(incoming.id);
    if (items.length && (!current || compareClock(incoming.updatedAt, incoming.deviceId, event.id, current.updatedAt, current.deviceId, current.syncEventId) > 0)) state.questionGroups.set(incoming.id, { ...incoming, items });
  } else if (event.type === "questionGroup.deleted") {
    putTombstone("questionGroup", payload.id, event); state.questionGroups.delete(payload.id);
  } else if (event.type === "question.created" || event.type === "question.updated") {
    const incoming = { ...payload, syncEventId: event.id };
    const changedAt = incoming.userUpdatedAt || event.createdAt;
    if (!state.banks.has(incoming.bankId) || isDeletedAfter("question", incoming.id, changedAt, incoming.userUpdatedBy || event.deviceId, event.id)) return;
    const current = state.questions.get(incoming.id);
    if (!current || compareClock(changedAt, incoming.userUpdatedBy || event.deviceId, event.id, current.userUpdatedAt, current.userUpdatedBy, current.syncEventId) > 0) state.questions.set(incoming.id, incoming);
  } else if (event.type === "question.deleted") {
    putTombstone("question", payload.id, event); deleteQuestion(payload.id);
  }
}

const ref = api(`repos/${owner}/${repo}/git/ref/heads/${branch}`);
const oldCommitSha = ref.object.sha;
const oldCommit = api(`repos/${owner}/${repo}/git/commits/${oldCommitSha}`);
const tree = api(`repos/${owner}/${repo}/git/trees/${oldCommit.tree.sha}?recursive=1`);
if (tree.truncated) throw new Error("Repository tree was truncated");
const oldEventEntries = tree.tree.filter((entry) => entry.type === "blob" && /^events\/.+\.json$/.test(entry.path))
  .sort((a, b) => Number(!a.path.startsWith("events/seed/")) - Number(!b.path.startsWith("events/seed/")) || a.path.localeCompare(b.path));
let eventCount = 0;
for (const entry of oldEventEntries) {
  const events = JSON.parse(readBlob(entry.sha));
  if (!Array.isArray(events)) throw new Error(`Invalid event file: ${entry.path}`);
  for (const event of events) { replay(event); eventCount += 1; }
}

const generatedAt = new Date().toISOString();
const arrays = Object.fromEntries(Object.entries(state).map(([key, map]) => [key, [...map.values()]]));
const counts = {
  banks: arrays.banks.length, bankFolders: arrays.bankFolders.length, questions: arrays.questions.length, attempts: arrays.attempts.length,
  notes: arrays.notes.length, practiceRuns: arrays.practiceRuns.length,
  questionGroups: arrays.questionGroups.length, tombstones: arrays.tombstones.length,
};
const bankIds = new Set(arrays.banks.map((bank) => bank.id));
const questionIds = new Set(arrays.questions.map((question) => question.id));
if (arrays.banks.some((bank) => !allowedBank.test(bank.name))) throw new Error("Snapshot contains unsupported banks");
if (arrays.questions.some((question) => !bankIds.has(question.bankId))) throw new Error("Snapshot has orphan questions");
if (arrays.attempts.some((attempt) => !questionIds.has(attempt.questionId))) throw new Error("Snapshot has orphan attempts");
if (arrays.notes.some((note) => !questionIds.has(note.questionId))) throw new Error("Snapshot has orphan notes");

const snapshot = { formatVersion: 2, generatedAt, state: arrays, counts };
const snapshotText = JSON.stringify(snapshot);
const snapshotHash = createHash("sha256").update(snapshotText).digest("hex");
const safeTimestamp = generatedAt.replace(/[:.]/g, "-");
const snapshotPath = `snapshots/v2/${safeTimestamp}.json`;
const manifest = { formatVersion: 2, generatedAt, snapshot: { path: snapshotPath, sha256: snapshotHash }, eventPrefix: "events/v2/" };

console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", repository: `${owner}/${repo}`, oldCommitSha, oldEventFiles: oldEventEntries.length, eventCount, snapshotPath, snapshotBytes: Buffer.byteLength(snapshotText), counts }, null, 2));
if (!apply) process.exit(0);

const tagName = `pre-v2-migration-${safeTimestamp}`;
api(`repos/${owner}/${repo}/git/refs`, "POST", { ref: `refs/tags/${tagName}`, sha: oldCommitSha });
function createBlob(content) { return api(`repos/${owner}/${repo}/git/blobs`, "POST", { content, encoding: "utf-8" }).sha; }
const entries = [
  { path: snapshotPath, mode: "100644", type: "blob", sha: createBlob(snapshotText) },
  { path: "sync/manifest.json", mode: "100644", type: "blob", sha: createBlob(JSON.stringify(manifest, null, 2)) },
  { path: "README.md", mode: "100644", type: "blob", sha: createBlob("# Exam Study Vault\n\nPrivate data vault for Exam Study App. Sync protocol: v2 snapshot + incremental events.\n") },
  ...oldEventEntries.map((entry) => ({ path: entry.path, mode: "100644", type: "blob", sha: null })),
];
const newTree = api(`repos/${owner}/${repo}/git/trees`, "POST", { base_tree: oldCommit.tree.sha, tree: entries });
const commit = api(`repos/${owner}/${repo}/git/commits`, "POST", { message: "sync: migrate vault to v2 snapshot", tree: newTree.sha, parents: [oldCommitSha] });
api(`repos/${owner}/${repo}/git/refs/heads/${branch}`, "PATCH", { sha: commit.sha, force: false });
const updatedRef = api(`repos/${owner}/${repo}/git/ref/heads/${branch}`);
if (updatedRef.object.sha !== commit.sha) throw new Error("Branch verification failed after migration");
const committedTree = api(`repos/${owner}/${repo}/git/trees/${newTree.sha}?recursive=1`);
const committedPaths = new Set(committedTree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path));
if (!committedPaths.has("sync/manifest.json") || !committedPaths.has(snapshotPath)) throw new Error("Committed v2 files are incomplete");
if ([...committedPaths].some((path) => /^events\/(?!v2\/).+\.json$/.test(path))) throw new Error("Legacy event files remain on the migrated branch");
console.log(JSON.stringify({ migrated: true, verified: true, commit: commit.sha, backupTag: tagName, manifest, counts }, null, 2));
