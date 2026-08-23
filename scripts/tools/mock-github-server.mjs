// Local mock of the GitHub Contents + Git Data API subset used by sync.
//
// The app points settings.apiBaseUrl at this server. It is byte-transparent:
// stored blobs are returned exactly as uploaded. Git SHA-1 identifiers, trees,
// commits and refs are deterministic in-memory test objects.
//
// Test-only options:
//   • cas: true — honor Contents API sha CAS and If-None-Match.
//   • faults: failPutOnce/failGetOnce/corruptBlob/blackholePath/
//             conflictHeadPutOnce/conflictHeadPutAlways/unauthorized.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const JSON_MEDIA = "application/vnd.github+json; charset=utf-8";
const RAW_MEDIA = "application/vnd.github.raw+json";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,DELETE,POST,PATCH,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type,accept,x-github-api-version,if-none-match",
  "Access-Control-Expose-Headers": "etag,x-ratelimit-limit,x-ratelimit-remaining",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

const CONTENT_RE = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/;
const BLOB_RE = /^\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/([^/]+)$/;
const GIT_REF_READ_RE = /^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/;
const GIT_REF_WRITE_RE = /^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/;
const GIT_COMMIT_READ_RE = /^\/repos\/([^/]+)\/([^/]+)\/git\/commits\/([a-f0-9]{40})$/i;
const GIT_BLOB_CREATE_RE = /^\/repos\/([^/]+)\/([^/]+)\/git\/blobs$/;
const GIT_TREE_CREATE_RE = /^\/repos\/([^/]+)\/([^/]+)\/git\/trees$/;
const GIT_COMMIT_CREATE_RE = /^\/repos\/([^/]+)\/([^/]+)\/git\/commits$/;

function sha1Hex(buffer) {
  return createHash("sha1").update(buffer).digest("hex");
}

function sendJson(res, status, body, extra = {}) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, { "Content-Type": JSON_MEDIA, "Content-Length": payload.length, ...CORS_HEADERS, ...extra });
  res.end(payload);
}

function sendRaw(res, status, buffer) {
  res.writeHead(status, { "Content-Type": RAW_MEDIA, "Content-Length": buffer.length, ...CORS_HEADERS });
  res.end(buffer);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJsonBody(buffer) {
  return JSON.parse(buffer.toString("utf8"));
}

/**
 * Start an in-memory mock of the GitHub API subset used by sync.
 * @param {{ port?: number, hostname?: string, cas?: boolean, faults?: MockFaults }} [options]
 */
export function startMockGitHubServer({ port = 0, hostname = "127.0.0.1", cas = false, faults } = {}) {
  const paths = new Map(); // owner/repo/logical path -> blobSha, current branch tree
  const blobs = new Map(); // blobSha -> Buffer
  const trees = new Map(); // treeSha -> Map<owner/repo/path, blobSha>
  const commits = new Map(); // commitSha -> { treeSha, parents, owner, repo }
  const heads = new Map(); // owner/repo@branch -> commitSha
  let objectSequence = 0;

  const stats = {
    blobReads: 0,
    maxConcurrentBlobReads: 0,
    assetWrites: 0,
    maxConcurrentAssetWrites: 0,
    gitBlobWrites: 0,
    gitTreeWrites: 0,
    gitCommitWrites: 0,
    gitRefUpdates: 0,
    totalRequests: 0,
  };
  let blobLatencyMs = 0;
  let assetWriteLatencyMs = 0;
  let inFlightBlobReads = 0;
  let inFlightAssetWrites = 0;
  let putFaultFired = false;
  let getFaultFired = false;
  let corruptNextBlob = false;
  let failNextBlobGet = false;

  function repoPrefix(owner, repo) {
    return `${owner}/${repo}/`;
  }

  function headKey(owner, repo, branch) {
    return `${owner}/${repo}@${branch}`;
  }

  function repoSnapshot(owner, repo) {
    const prefix = repoPrefix(owner, repo);
    return new Map([...paths.entries()].filter(([key]) => key.startsWith(prefix)));
  }

  function stableTreeSha(snapshot) {
    const entries = [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right));
    return sha1Hex(Buffer.from(JSON.stringify(entries), "utf8"));
  }

  function storeTree(snapshot) {
    const sha = stableTreeSha(snapshot);
    trees.set(sha, new Map(snapshot));
    return sha;
  }

  function storeCommit(owner, repo, treeSha, parents) {
    objectSequence += 1;
    const sha = sha1Hex(Buffer.from(`${owner}/${repo}|${treeSha}|${parents.join(",")}|${objectSequence}`, "utf8"));
    commits.set(sha, { treeSha, parents: [...parents], owner, repo });
    return sha;
  }

  function ensureHead(owner, repo, branch = "main") {
    const key = headKey(owner, repo, branch);
    const existing = heads.get(key);
    if (existing) return existing;
    const treeSha = storeTree(repoSnapshot(owner, repo));
    const commitSha = storeCommit(owner, repo, treeSha, []);
    heads.set(key, commitSha);
    return commitSha;
  }

  function advanceContentsCommit(owner, repo, branch = "main") {
    const parent = ensureHead(owner, repo, branch);
    const treeSha = storeTree(repoSnapshot(owner, repo));
    const commitSha = storeCommit(owner, repo, treeSha, [parent]);
    heads.set(headKey(owner, repo, branch), commitSha);
    return commitSha;
  }

  function applyTree(owner, repo, treeSha) {
    const snapshot = trees.get(treeSha);
    if (!snapshot) throw new Error(`unknown mock tree ${treeSha}`);
    const prefix = repoPrefix(owner, repo);
    for (const key of [...paths.keys()]) if (key.startsWith(prefix)) paths.delete(key);
    for (const [key, sha] of snapshot) if (key.startsWith(prefix)) paths.set(key, sha);
  }

  function viewForRef(owner, repo, ref) {
    if (!ref || !/^[a-f0-9]{40}$/i.test(ref)) return paths;
    const commit = commits.get(ref);
    if (!commit || commit.owner !== owner || commit.repo !== repo) return null;
    return trees.get(commit.treeSha) ?? null;
  }

  function reset() {
    paths.clear();
    blobs.clear();
    trees.clear();
    commits.clear();
    heads.clear();
    objectSequence = 0;
    putFaultFired = false;
    getFaultFired = false;
    corruptNextBlob = false;
    failNextBlobGet = false;
    stats.blobReads = 0;
    stats.maxConcurrentBlobReads = 0;
    stats.assetWrites = 0;
    stats.maxConcurrentAssetWrites = 0;
    stats.gitBlobWrites = 0;
    stats.gitTreeWrites = 0;
    stats.gitCommitWrites = 0;
    stats.gitRefUpdates = 0;
    stats.totalRequests = 0;
    blobLatencyMs = 0;
    assetWriteLatencyMs = 0;
  }

  function contentPaths() {
    return [...paths.keys()].map((key) => key.replace(/^[^/]+\/[^/]+\//, ""));
  }

  function blackholed(logicalPath) {
    return Boolean(faults?.blackholePath && faults.blackholePath.test(logicalPath));
  }

  function maybeCorrupt(sha, buffer) {
    const matched = faults?.corruptBlob === true || (faults?.corruptBlob instanceof Set && faults.corruptBlob.has(sha));
    if (!matched) return buffer;
    const corrupted = Buffer.from(buffer);
    if (corrupted.length) corrupted.writeUInt8((corrupted[0] ^ 0xff) >>> 0, 0);
    return corrupted;
  }

  function corruptBlobBuffer(buffer) {
    corruptNextBlob = false;
    const corrupted = Buffer.from(buffer);
    if (corrupted.length) corrupted.writeUInt8((corrupted[0] ^ 0xff) >>> 0, 0);
    return corrupted;
  }

  const server = createServer(async (req, res) => {
    try {
      stats.totalRequests += 1;
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }
      if (faults?.unauthorized) return sendJson(res, 401, { message: "unauthorized mock vault" });

      const parsed = new URL(req.url, `http://${hostname}`);
      const pathname = parsed.pathname;

      // Raw Git blob read used by checkpoint/segment/object/pack hydration.
      const blobMatch = BLOB_RE.exec(pathname);
      if (req.method === "GET" && blobMatch) {
        const sha = decodeURIComponent(blobMatch[3]);
        if (failNextBlobGet) {
          failNextBlobGet = false;
          return sendJson(res, 500, { message: "transient mock blob GET failure" });
        }
        const buffer = blobs.get(sha);
        if (!buffer) return sendJson(res, 404, { message: "Not Found" });
        stats.blobReads += 1;
        inFlightBlobReads += 1;
        stats.maxConcurrentBlobReads = Math.max(stats.maxConcurrentBlobReads, inFlightBlobReads);
        const reply = () => {
          inFlightBlobReads -= 1;
          sendRaw(res, 200, corruptNextBlob ? corruptBlobBuffer(buffer) : maybeCorrupt(sha, buffer));
        };
        if (blobLatencyMs > 0) setTimeout(reply, blobLatencyMs);
        else reply();
        return;
      }

      // Git Data: branch ref read.
      const refRead = GIT_REF_READ_RE.exec(pathname);
      if (req.method === "GET" && refRead) {
        const owner = decodeURIComponent(refRead[1]);
        const repo = decodeURIComponent(refRead[2]);
        const branch = refRead[3].split("/").map(decodeURIComponent).join("/");
        const sha = ensureHead(owner, repo, branch);
        return sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { type: "commit", sha } });
      }

      // Git Data: commit read, needed to obtain the exact base tree.
      const commitRead = GIT_COMMIT_READ_RE.exec(pathname);
      if (req.method === "GET" && commitRead) {
        const owner = decodeURIComponent(commitRead[1]);
        const repo = decodeURIComponent(commitRead[2]);
        const sha = commitRead[3];
        const commit = commits.get(sha);
        if (!commit || commit.owner !== owner || commit.repo !== repo) return sendJson(res, 404, { message: "Not Found" });
        return sendJson(res, 200, { sha, tree: { sha: commit.treeSha }, parents: commit.parents.map((parent) => ({ sha: parent })) });
      }

      // Git Data: create raw blob. Asset Pack publication uses base64.
      const blobCreate = GIT_BLOB_CREATE_RE.exec(pathname);
      if (req.method === "POST" && blobCreate) {
        const body = parseJsonBody(await readBody(req));
        const buffer = body.encoding === "base64" ? Buffer.from(body.content, "base64") : Buffer.from(String(body.content ?? ""), "utf8");
        const sha = sha1Hex(buffer);
        if (assetWriteLatencyMs > 0) {
          inFlightAssetWrites += 1;
          stats.maxConcurrentAssetWrites = Math.max(stats.maxConcurrentAssetWrites, inFlightAssetWrites);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, assetWriteLatencyMs));
          inFlightAssetWrites -= 1;
        }
        blobs.set(sha, buffer);
        stats.gitBlobWrites += 1;
        return sendJson(res, 201, { sha, url: `https://example.com/mock/git/blobs/${sha}` });
      }

      // Git Data: create tree from an exact base tree; sha:null deletes a path.
      const treeCreate = GIT_TREE_CREATE_RE.exec(pathname);
      if (req.method === "POST" && treeCreate) {
        const owner = decodeURIComponent(treeCreate[1]);
        const repo = decodeURIComponent(treeCreate[2]);
        const body = parseJsonBody(await readBody(req));
        const base = trees.get(body.base_tree);
        if (!base) return sendJson(res, 422, { message: "unknown base_tree" });
        const next = new Map(base);
        const prefix = repoPrefix(owner, repo);
        for (const entry of body.tree ?? []) {
          const logicalPath = String(entry.path ?? "");
          const key = `${prefix}${logicalPath}`;
          if (entry.sha === null) next.delete(key);
          else {
            if (typeof entry.sha !== "string" || !blobs.has(entry.sha)) return sendJson(res, 422, { message: `unknown blob ${entry.sha}` });
            next.set(key, entry.sha);
          }
        }
        const sha = storeTree(next);
        stats.gitTreeWrites += 1;
        return sendJson(res, 201, { sha, url: `https://example.com/mock/git/trees/${sha}` });
      }

      // Git Data: create commit object. It is not visible until the ref PATCH.
      const commitCreate = GIT_COMMIT_CREATE_RE.exec(pathname);
      if (req.method === "POST" && commitCreate) {
        const owner = decodeURIComponent(commitCreate[1]);
        const repo = decodeURIComponent(commitCreate[2]);
        const body = parseJsonBody(await readBody(req));
        if (typeof body.tree !== "string" || !trees.has(body.tree)) return sendJson(res, 422, { message: "unknown tree" });
        const parents = Array.isArray(body.parents) ? body.parents.filter((parent) => typeof parent === "string") : [];
        if (parents.some((parent) => !commits.has(parent))) return sendJson(res, 422, { message: "unknown parent" });
        const sha = storeCommit(owner, repo, body.tree, parents);
        stats.gitCommitWrites += 1;
        return sendJson(res, 201, { sha, tree: { sha: body.tree }, parents: parents.map((parent) => ({ sha: parent })) });
      }

      // Git Data: fast-forward branch ref. Non-fast-forward returns 422 just as
      // GitHub does when force=false, allowing the client to rebase/retry.
      const refWrite = GIT_REF_WRITE_RE.exec(pathname);
      if (req.method === "PATCH" && refWrite) {
        const owner = decodeURIComponent(refWrite[1]);
        const repo = decodeURIComponent(refWrite[2]);
        const branch = refWrite[3].split("/").map(decodeURIComponent).join("/");
        const body = parseJsonBody(await readBody(req));
        const next = commits.get(body.sha);
        if (!next || next.owner !== owner || next.repo !== repo) return sendJson(res, 422, { message: "unknown commit" });
        const current = ensureHead(owner, repo, branch);
        if (body.force !== true && next.parents[0] !== current) return sendJson(res, 422, { message: "Update is not a fast forward" });
        heads.set(headKey(owner, repo, branch), body.sha);
        applyTree(owner, repo, next.treeSha);
        stats.gitRefUpdates += 1;
        return sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { type: "commit", sha: body.sha } });
      }

      // Contents API: mutable head and existing immutable sync objects.
      const contentMatch = CONTENT_RE.exec(pathname);
      if (contentMatch) {
        const owner = decodeURIComponent(contentMatch[1]);
        const repo = decodeURIComponent(contentMatch[2]);
        const logicalPath = contentMatch[3].split("/").map(decodeURIComponent).join("/");
        const storageKey = `${owner}/${repo}/${logicalPath}`;

        if (req.method === "GET") {
          if (blackholed(logicalPath)) return sendJson(res, 404, { message: "Not Found" });
          if (faults?.failGetOnce && !getFaultFired && faults.failGetOnce.test(logicalPath)) {
            getFaultFired = true;
            return sendJson(res, 500, { message: "transient mock GET failure" });
          }
          const view = viewForRef(owner, repo, parsed.searchParams.get("ref"));
          if (!view) return sendJson(res, 404, { message: "Not Found" });
          const sha = view.get(storageKey);
          if (!sha) {
            const prefix = storageKey + "/";
            const entries = [...view.entries()]
              .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
              .map(([key, childSha]) => {
                const childPath = key.replace(/^[^/]+\/[^/]+\//, "");
                return { name: childPath.split("/").pop(), path: childPath, sha: childSha, type: "file", size: blobs.get(childSha)?.length ?? 0 };
              });
            if (entries.length) return sendJson(res, 200, entries);
            return sendJson(res, 404, { message: "Not Found" });
          }
          if (cas) {
            const inm = req.headers["if-none-match"];
            if (inm && inm === `"${sha}"`) return sendJson(res, 304, { message: "Not Modified" }, { etag: `"${sha}"` });
          }
          const buffer = blobs.get(sha);
          if (!buffer) return sendJson(res, 404, { message: "Not Found" });
          return sendJson(res, 200, {
            content: maybeCorrupt(sha, buffer).toString("base64"),
            encoding: "base64",
            sha,
            path: logicalPath,
            size: buffer.length,
            name: logicalPath.split("/").pop(),
          }, { etag: `"${sha}"` });
        }

        if (req.method === "DELETE") {
          const currentSha = paths.get(storageKey);
          if (!currentSha) return sendJson(res, 404, { message: "Not Found" });
          const body = parseJsonBody(await readBody(req));
          if (typeof body.sha !== "string" || body.sha !== currentSha) return sendJson(res, 409, { message: "Conflict" });
          paths.delete(storageKey);
          const commitSha = advanceContentsCommit(owner, repo, body.branch || "main");
          return sendJson(res, 200, { commit: { sha: commitSha }, content: null });
        }

        if (req.method === "PUT") {
          if (blackholed(logicalPath)) return sendJson(res, 404, { message: "Not Found" });
          if (faults?.failPutOnce && !putFaultFired && faults.failPutOnce.test(logicalPath)) {
            putFaultFired = true;
            return sendJson(res, 500, { message: "transient mock PUT failure" });
          }
          if (logicalPath.startsWith("sync/v9/assets/")) {
            stats.assetWrites += 1;
            inFlightAssetWrites += 1;
            stats.maxConcurrentAssetWrites = Math.max(stats.maxConcurrentAssetWrites, inFlightAssetWrites);
            if (assetWriteLatencyMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, assetWriteLatencyMs));
            inFlightAssetWrites -= 1;
          }
          const body = parseJsonBody(await readBody(req));
          const buffer = Buffer.from(body.content, "base64");
          const sha = sha1Hex(buffer);
          const existed = paths.has(storageKey);
          if (faults?.conflictHeadPutOnce && !putFaultFired && existed && /^sync\/v[789]\/head\.json$/.test(logicalPath)) {
            putFaultFired = true;
            return sendJson(res, 409, { message: "Conflict" });
          }
          if (faults?.conflictHeadPutAlways && existed && /^sync\/v[789]\/head\.json$/.test(logicalPath)) {
            return sendJson(res, 409, { message: "Conflict" });
          }
          if (cas && existed) {
            const currentSha = paths.get(storageKey);
            if (typeof body.sha === "string") {
              if (body.sha !== currentSha) return sendJson(res, 409, { message: "Conflict" });
            } else {
              return sendJson(res, 422, { message: "already exists", errors: [{ code: "already_exists" }] });
            }
          }
          paths.set(storageKey, sha);
          blobs.set(sha, buffer);
          const commitSha = advanceContentsCommit(owner, repo, body.branch || "main");
          return sendJson(res, existed ? 200 : 201, {
            content: { sha, path: logicalPath, size: buffer.length },
            commit: { sha: commitSha, html_url: `https://example.com/mock/${logicalPath}` },
          }, { etag: `"${sha}"` });
        }
      }

      return sendJson(res, 404, { message: "Not Found" });
    } catch (error) {
      return sendJson(res, 500, { message: error?.message ?? "mock github server error" });
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, hostname, () => {
      const { port: actualPort } = server.address();
      const url = `http://${hostname}:${actualPort}`;
      const close = () => new Promise((resolveClose) => server.close(() => resolveClose()));
      const armCorruptOnce = () => { corruptNextBlob = true; };
      const armFailBlobGetOnce = () => { failNextBlobGet = true; };
      resolve({
        url,
        port: actualPort,
        hostname,
        reset,
        contentPaths,
        armCorruptOnce,
        armFailBlobGetOnce,
        close,
        stats,
        setBlobLatency: (ms) => { blobLatencyMs = ms; },
        setAssetWriteLatency: (ms) => { assetWriteLatencyMs = ms; },
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.PORT || 4317);
  startMockGitHubServer({ port }).then(({ url }) => {
    console.log(`mock github api listening on ${url}`);
    console.log(`point the app's 同步中转地址 to: ${url}`);
  });
}
