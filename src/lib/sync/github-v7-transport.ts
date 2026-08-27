export interface GitHubV7RequestClient {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  request(path: string, init?: RequestInit, accept?: string): Promise<Response>;
}

export interface GitHubV7BranchSnapshot {
  parentSha: string;
  treeSha: string;
}

export interface GitHubV7TreeMutation {
  path: string;
  blobSha: string | null;
}

const SHA1 = /^[a-f0-9]{40}$/;

function asRecord(value: unknown, operation: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${operation} 返回了无效 JSON。`);
  return value as Record<string, unknown>;
}

function assertSha1(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SHA1.test(value)) throw new Error(`${field} 返回了无效 Git SHA-1。`);
}

async function responseJson(response: Response, operation: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${operation} 失败（GitHub ${response.status}）。`);
  try {
    return asRecord(JSON.parse(await response.text()) as unknown, operation);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${operation} 返回了无效 JSON`)) throw error;
    throw new Error(`${operation} 返回了无效 JSON。`);
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function contentPath(owner: string, repo: string, path: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

export function blobPath(owner: string, repo: string, blobSha: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(blobSha)}`;
}

export function withRef(path: string, ref: string): string {
  return `${path}?ref=${encodeURIComponent(ref)}`;
}

function repoGitPath(client: GitHubV7RequestClient, suffix: string): string {
  return `/repos/${encodeURIComponent(client.owner)}/${encodeURIComponent(client.repo)}/git/${suffix}`;
}

function branchPath(branch: string): string {
  return branch.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export async function readGitHubContentsAtRef(client: GitHubV7RequestClient, path: string, ref: string): Promise<Uint8Array | null> {
  const response = await client.request(withRef(contentPath(client.owner, client.repo, path), ref), { method: "GET" });
  if (response.status === 404) return null;
  const payload = await responseJson(response, `读取 ${path}`);
  if (typeof payload.content !== "string") throw new Error(`读取 ${path} 返回结果缺少 base64 content。`);
  try {
    return decodeBase64(payload.content);
  } catch {
    throw new Error(`读取 ${path} 返回了无效 base64 content。`);
  }
}

export async function createGitHubBlob(client: GitHubV7RequestClient, bytes: Uint8Array): Promise<string> {
  const payload = await responseJson(await client.request(repoGitPath(client, "blobs"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: encodeBase64(bytes), encoding: "base64" }),
  }), "创建 Git blob");
  assertSha1(payload.sha, "Git blob sha");
  return payload.sha;
}

export async function readGitHubBranchSnapshot(client: GitHubV7RequestClient): Promise<GitHubV7BranchSnapshot> {
  const branch = branchPath(client.branch);
  const refPayload = await responseJson(await client.request(repoGitPath(client, `ref/heads/${branch}`), { method: "GET" }), "读取 Git branch ref");
  const object = asRecord(refPayload.object, "读取 Git branch ref.object");
  assertSha1(object.sha, "branch commit sha");
  const parentSha = object.sha;
  const commitPayload = await responseJson(await client.request(repoGitPath(client, `commits/${parentSha}`), { method: "GET" }), "读取 Git commit");
  const tree = asRecord(commitPayload.tree, "读取 Git commit.tree");
  assertSha1(tree.sha, "base tree sha");
  return { parentSha, treeSha: tree.sha };
}

export async function commitGitHubTreeFastForward(
  client: GitHubV7RequestClient,
  base: GitHubV7BranchSnapshot,
  mutations: readonly GitHubV7TreeMutation[],
  message: string,
): Promise<boolean> {
  assertSha1(base.parentSha, "base commit sha");
  assertSha1(base.treeSha, "base tree sha");
  const byPath = new Map<string, string | null>();
  for (const mutation of mutations) {
    if (!mutation.path) throw new TypeError("Git tree mutation path is required");
    if (mutation.blobSha !== null) assertSha1(mutation.blobSha, `Git tree mutation ${mutation.path}`);
    byPath.set(mutation.path, mutation.blobSha);
  }
  const treePayload = await responseJson(await client.request(repoGitPath(client, "trees"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_tree: base.treeSha,
      tree: [...byPath.entries()].map(([path, blobSha]) => ({ path, mode: "100644", type: "blob", sha: blobSha })),
    }),
  }), "创建 Asset Pack Git tree");
  assertSha1(treePayload.sha, "new tree sha");
  const commitPayload = await responseJson(await client.request(repoGitPath(client, "commits"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, tree: treePayload.sha, parents: [base.parentSha] }),
  }), "创建 Asset Pack Git commit");
  assertSha1(commitPayload.sha, "new commit sha");
  const update = await client.request(repoGitPath(client, `refs/heads/${branchPath(client.branch)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha: commitPayload.sha, force: false }),
  });
  if (update.status === 409 || update.status === 422) return false;
  if (!update.ok) throw new Error(`发布 Asset Pack Git ref 失败（GitHub ${update.status}）。`);
  return true;
}
