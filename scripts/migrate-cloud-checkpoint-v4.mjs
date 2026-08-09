import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const [owner, repo, branch = "main"] = process.argv.slice(2).filter((value) => value !== "--apply");
const apply = process.argv.includes("--apply");
if (!owner || !repo) throw new Error("Usage: node scripts/migrate-cloud-checkpoint-v4.mjs <owner> <repo> [branch] [--apply]");

const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
};
const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

function encodedPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function request(path, init = {}) {
  const response = await fetch(`${api}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed (${response.status}): ${payload.message ?? "unknown error"}`);
  return payload;
}

async function readContent(path) {
  const file = await request(`/contents/${encodedPath(path)}?ref=${encodeURIComponent(branch)}`);
  if (file.type !== "file" || !file.sha) throw new Error(`Remote file is invalid: ${path}`);
  let text;
  if (file.encoding === "base64" && typeof file.content === "string" && file.content.trim()) {
    text = Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
  } else {
    const response = await fetch(`${api}/git/blobs/${file.sha}`, {
      headers: { ...headers, Accept: "application/vnd.github.raw+json" },
    });
    if (!response.ok) throw new Error(`GitHub GET blob ${file.sha} failed (${response.status}).`);
    text = await response.text();
  }
  return { file, text, json: JSON.parse(text) };
}

function addPermanentQuestionOrder(checkpoint) {
  const questions = checkpoint.state?.questions;
  if (!Array.isArray(questions)) throw new Error("Checkpoint questions are invalid; no changes were made.");
  const nextByBank = new Map();
  for (const question of questions) {
    if (Number.isFinite(question.sortOrder)) {
      nextByBank.set(question.bankId, Math.max(nextByBank.get(question.bankId) ?? 0, question.sortOrder + 1));
    }
  }
  return questions.map((question) => {
    if (Number.isFinite(question.sortOrder)) return question;
    const sortOrder = nextByBank.get(question.bankId) ?? 0;
    nextByBank.set(question.bankId, sortOrder + 1);
    return { ...question, sortOrder };
  });
}

async function putContent(path, text, message, sha) {
  return request(`/contents/${encodedPath(path)}`, {
    method: "PUT",
    body: JSON.stringify({ message, branch, content: Buffer.from(text).toString("base64"), ...(sha ? { sha } : {}) }),
  });
}

const initial = await readContent("sync/v4/head.json");
if (initial.json.formatVersion !== 4 || initial.json.checkpoint?.path === undefined || initial.json.archiveCatalog?.path === undefined) {
  throw new Error("Remote v4 head is invalid; no changes were made.");
}
const catalog = await readContent(initial.json.archiveCatalog.path);
if (catalog.json.formatVersion !== 4 || [...(catalog.json.attemptSegments ?? []), ...(catalog.json.practiceRunSegments ?? [])].some((segment) => segment.legacy)) {
  throw new Error("Archive catalog is not native v4; no changes were made.");
}
const checkpointFile = await readContent(initial.json.checkpoint.path);
if (checkpointFile.json.formatVersion === 4) {
  console.log(JSON.stringify({ changed: false, headSha: initial.file.sha, checkpointPath: initial.json.checkpoint.path }));
  process.exit(0);
}
if (checkpointFile.json.formatVersion !== 3) throw new Error("Checkpoint format is neither 3 nor 4; no changes were made.");

const checkpoint = {
  ...checkpointFile.json,
  formatVersion: 4,
  state: { ...checkpointFile.json.state, questions: addPermanentQuestionOrder(checkpointFile.json) },
};
const checkpointText = JSON.stringify(checkpoint);
const sha256 = createHash("sha256").update(checkpointText).digest("hex");
const checkpointPath = `sync/v4/checkpoints/${sha256}.json`;
const nextHead = {
  ...initial.json,
  generatedAt: new Date().toISOString(),
  checkpoint: { path: checkpointPath, blobSha: "pending", sha256, size: Buffer.byteLength(checkpointText) },
};
if (!apply) {
  console.log(JSON.stringify({ changed: true, dryRun: true, currentHeadSha: initial.file.sha, checkpointPath, checkpointSize: nextHead.checkpoint.size }));
  process.exit(0);
}

let checkpointBlobSha;
try {
  const created = await putContent(checkpointPath, checkpointText, "sync: publish native v4 checkpoint");
  checkpointBlobSha = created.content?.sha;
} catch (error) {
  const existing = await readContent(checkpointPath);
  if (existing.text !== checkpointText) throw error;
  checkpointBlobSha = existing.file.sha;
}
if (!checkpointBlobSha) throw new Error("GitHub did not return the immutable checkpoint blob SHA.");

const latest = await readContent("sync/v4/head.json");
if (latest.file.sha !== initial.file.sha) throw new Error("Remote head changed during migration; the new immutable checkpoint is harmless but was not published.");
nextHead.checkpoint.blobSha = checkpointBlobSha;
const updated = await putContent("sync/v4/head.json", JSON.stringify(nextHead), "sync: advance head to native v4 checkpoint", initial.file.sha);
const verified = await readContent("sync/v4/head.json");
if (verified.json.checkpoint?.path !== checkpointPath || verified.json.checkpoint?.sha256 !== sha256) throw new Error("Remote head verification failed.");
console.log(JSON.stringify({ changed: true, headSha: updated.content?.sha, checkpointPath, checkpointBlobSha, formatVersion: checkpoint.formatVersion }));
