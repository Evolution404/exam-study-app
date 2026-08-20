import fs from "node:fs";

function edit(path, mutate) {
  const before = fs.readFileSync(path, "utf8");
  const after = mutate(before);
  if (after === before) throw new Error(`v7 gc migration made no change: ${path}`);
  fs.writeFileSync(path, after);
}

function replaceOnce(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`v7 gc migration missing ${label}`);
  return source.replace(from, to);
}

edit("src/lib/sync/github-v7-remote.ts", (input) => {
  let source = input;
  source = replaceOnce(source,
`export interface SyncV7ImmutablePutResult {\n  path: string;\n  blobSha: string;\n  sha256: string;\n  size: number;\n  /** Actual stored/wire bytes of the uploaded object (the DEFLATE envelope). */\n  storedSize: number;\n  created: boolean;\n  idempotent: boolean;\n  status: number;\n}\n`,
`export interface SyncV7ImmutablePutResult {\n  path: string;\n  blobSha: string;\n  sha256: string;\n  size: number;\n  /** Actual stored/wire bytes of the uploaded object (the DEFLATE envelope). */\n  storedSize: number;\n  created: boolean;\n  idempotent: boolean;\n  status: number;\n}\n\nexport interface SyncV7RemoteEntry {\n  path: string;\n  blobSha: string;\n}\n`,
"remote entry interface");

  source = replaceOnce(source,
`  private async readContentsMetadata(path: string): Promise<string> {\n    const response = await this.request(withRef(contentPath(this.owner, this.repo, path), this.branch));\n    this.requireOk(response, \`read metadata \${path}\`);\n    const sha = extractBlobSha(parseJson(await response.text(), \`read metadata \${path}\`));\n    if (!sha) throw new GitHubV7RemoteError(\`read metadata \${path}\`, 200, "GitHub did not return an existing blob SHA");\n    assertSha1(sha, "existing immutable blobSha");\n    return sha;\n  }\n`,
`  private async readContentsMetadata(path: string): Promise<string> {\n    const response = await this.request(withRef(contentPath(this.owner, this.repo, path), this.branch));\n    this.requireOk(response, \`read metadata \${path}\`);\n    const sha = extractBlobSha(parseJson(await response.text(), \`read metadata \${path}\`));\n    if (!sha) throw new GitHubV7RemoteError(\`read metadata \${path}\`, 200, "GitHub did not return an existing blob SHA");\n    assertSha1(sha, "existing immutable blobSha");\n    return sha;\n  }\n\n  /** List immutable files in a bounded v7 maintenance namespace. */\n  async listImmutableDirectory(prefix: typeof SYNC_V7_CHECKPOINT_PREFIX | typeof SYNC_V7_SEGMENT_PREFIX): Promise<SyncV7RemoteEntry[]> {\n    const kind: SyncV7DescriptorKind = prefix === SYNC_V7_CHECKPOINT_PREFIX ? "checkpoint" : "segment";\n    const directory = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;\n    const response = await this.request(withRef(contentPath(this.owner, this.repo, directory), this.branch));\n    if (response.status === 404) return [];\n    this.requireOk(response, \`list immutable \${directory}\`);\n    const value = parseJson(await response.text(), \`list immutable \${directory}\`);\n    if (!Array.isArray(value)) throw new GitHubV7RemoteError(\`list immutable \${directory}\`, 200, "GitHub returned an invalid directory listing");\n    const entries: SyncV7RemoteEntry[] = [];\n    for (const item of value) {\n      if (!item || typeof item !== "object" || Array.isArray(item)) continue;\n      const path = getString((item as { path?: unknown }).path);\n      const blobSha = getString((item as { sha?: unknown }).sha);\n      const type = getString((item as { type?: unknown }).type);\n      if (!path || !blobSha || (type !== undefined && type !== "file")) continue;\n      assertSyncV7Path(path, kind);\n      assertSha1(blobSha, "listed immutable blobSha");\n      entries.push({ path, blobSha });\n    }\n    return entries;\n  }\n\n  /** Delete an immutable path only when its Git blob SHA still matches. */\n  async deleteImmutablePath(path: string, blobSha: string): Promise<boolean> {\n    const kind = inferKind(path);\n    if (kind !== "checkpoint" && kind !== "segment" && kind !== "object") throw new TypeError("v7 GC cannot delete assets");\n    assertSyncV7Path(path, kind);\n    assertSha1(blobSha, "immutable delete blobSha");\n    const response = await this.request(contentPath(this.owner, this.repo, path), {\n      method: "DELETE",\n      headers: { "Content-Type": "application/json" },\n      body: JSON.stringify({ message: \`sync(v7): gc \${path}\`, sha: blobSha, branch: this.branch }),\n    });\n    if (response.status === 404) return false;\n    if (response.status === 409 || response.status === 422) return false;\n    this.requireOk(response, \`delete immutable \${path}\`);\n    return true;\n  }\n`,
"remote maintenance methods");
  return source;
});

edit("scripts/tools/mock-github-server.mjs", (input) => {
  let source = input;
  source = replaceOnce(source,
`  "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",`,
`  "Access-Control-Allow-Methods": "GET,PUT,DELETE,OPTIONS",`,
"mock CORS methods");

  source = replaceOnce(source,
`          const sha = paths.get(storageKey);\n          if (!sha) return sendJson(res, 404, { message: "Not Found" });`,
`          const sha = paths.get(storageKey);\n          if (!sha) {\n            const prefix = \`${storageKey}/\`;\n            const entries = [...paths.entries()]\n              .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))\n              .map(([key, childSha]) => {\n                const childPath = key.replace(/^[^/]+\\/[^/]+\\//, "");\n                return { name: childPath.split("/").pop(), path: childPath, sha: childSha, type: "file", size: blobs.get(childSha)?.length ?? 0 };\n              });\n            if (entries.length) return sendJson(res, 200, entries);\n            return sendJson(res, 404, { message: "Not Found" });\n          }`,
"mock directory listing");

  source = replaceOnce(source,
`        if (req.method === "PUT") {\n`,
`        if (req.method === "DELETE") {\n          const currentSha = paths.get(storageKey);\n          if (!currentSha) return sendJson(res, 404, { message: "Not Found" });\n          const body = JSON.parse((await readBody(req)).toString("utf8"));\n          if (typeof body.sha !== "string" || body.sha !== currentSha) return sendJson(res, 409, { message: "Conflict" });\n          paths.delete(storageKey);\n          return sendJson(res, 200, { commit: { sha: randomBytes(20).toString("hex") }, content: null });\n        }\n\n        if (req.method === "PUT") {\n`,
"mock delete");
  return source;
});

edit("src/lib/sync/sync-v7-orchestrator.ts", (input) => {
  let source = input;
  source = replaceOnce(source,
`import { maybeCoalesceHotWindow } from "./sync-v7-coalesce";`,
`import { maybeCoalesceHotWindow } from "./sync-v7-coalesce";\nimport { gcSyncV7Remote } from "./sync-v7-gc";`,
"orchestrator GC import");

  source = replaceOnce(source,
`      await saveInstalledHead(settings, installFingerprint(committed.cache));\n      await saveInstalledCursors(settings, nextHead.cursors);\n      // The push is already durable. Coalescing is a best-effort maintenance write`,
`      await saveInstalledHead(settings, installFingerprint(committed.cache));\n      await saveInstalledCursors(settings, nextHead.cursors);\n      // The head CAS is durable before any deletion. Sweep only files unreachable\n      // from the current/previous head; failures are maintenance-only.\n      try { await gcSyncV7Remote(client, read.head, committed.cache, { checkpointChanged: compaction.required }); } catch { /* best-effort */ }\n      // The push is already durable. Coalescing is a best-effort maintenance write`,
"orchestrator post-CAS GC");
  return source;
});

edit("src/lib/sync/sync-v7-coalesce.ts", (input) => {
  let source = input;
  source = replaceOnce(source,
`import { uploadedDescriptor } from "./sync-v7-upload";`,
`import { uploadedDescriptor } from "./sync-v7-upload";\nimport { gcSyncV7Remote } from "./sync-v7-gc";`,
"coalesce GC import");
  source = replaceOnce(source,
`  const published = await client.publish(plan);\n  if (!published.ok) return null;\n  return published.cache;`,
`  const published = await client.publish(plan);\n  if (!published.ok) return null;\n  try { await gcSyncV7Remote(client, head, published.cache, { checkpointChanged: false }); } catch { /* best-effort */ }\n  return published.cache;`,
"coalesce post-CAS GC");
  return source;
});

console.log("v7 live GC migration applied");
