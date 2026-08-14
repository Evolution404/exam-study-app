// Local mock of the GitHub Contents + Blobs API subset that v7 sync talks to.
//
// The app points its "同步中转地址" (settings.apiBaseUrl) at this server, so
// `${apiBaseUrl}/repos/:owner/:repo/contents/...` and `.../git/blobs/...` are
// served entirely in memory.  It is byte-transparent: it stores whatever bytes
// the client PUTs (raw JSON or deflated) and hands the exact bytes back, so the
// client's own sha256/size integrity checks still pass — the only value the
// server fabricates is the Git blob SHA-1 id (computed deterministically from
// the content, matching the shape github-v7-remote.ts asserts).
//
// Two modes:
//   • imported  -> `startMockGitHubServer({ port })` returns { url, port, reset, close }
//   • standalone -> `node scripts/mock-github-server.mjs [port]` prints the URL
//     so a real browser/dev session can point at it for manual verification.
//
// Test-only options (default off, preserving the original happy-path behaviour):
//   • cas: true        — honor `body.sha` on contents PUT (409 on stale, 422 when
//                        sha missing on an existing file) and `If-None-Match` on
//                        contents GET (304). Unlocks CAS-retry / concurrent-push /
//                        bootstrap-split-brain / ETag tests through syncWithGitHub.
//   • faults: {...}    — inject failures: failPutOnce/failGetOnce (first match →
//                        500 then recover), corruptBlob (serve flipped bytes for a
//                        sha), blackholePath (404 for a path), conflictHeadPutOnce /
//                        conflictHeadPutAlways (409 on a head update). Unlocks
//                        partial-upload / network-error / corruption / hydration /
//                        CAS-exhaustion tests. `armCorruptOnce()` (on the returned
//                        handle) flips the NEXT blob GET once.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const JSON_MEDIA = "application/vnd.github+json; charset=utf-8";
const RAW_MEDIA = "application/vnd.github.raw+json";

// The client sends Authorization, X-GitHub-Api-Version, Accept, Content-Type and
// (on head reads) If-None-Match — all non-safelisted, so the browser preflights.
// Expose etag so client JS can read the head version header.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type,accept,x-github-api-version,if-none-match",
  "Access-Control-Expose-Headers": "etag,x-ratelimit-limit,x-ratelimit-remaining",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

const CONTENT_RE = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/;
const BLOB_RE = /^\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/([^/]+)$/;

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

/**
 * Start an in-memory mock of the GitHub API subset used by v7 sync.
 * @param {{ port?: number, hostname?: string, cas?: boolean, faults?: MockFaults }} [options]
 * @returns {Promise<{ url: string, port: number, hostname: string, reset: () => void, contentPaths: () => string[], close: () => Promise<void> }>}
 */
export function startMockGitHubServer({ port = 0, hostname = "127.0.0.1", cas = false, faults } = {}) {
  const paths = new Map(); // logical content path -> blobSha
  const blobs = new Map(); // blobSha -> Buffer
  // One-shot fault state: tracks whether failPutOnce/failGetOnce have fired yet.
  let putFaultFired = false;
  let getFaultFired = false;
  // Armed via armCorruptOnce(): the next blob GET flips a byte (simulating a
  // corrupted transfer), then self-clears. Lets tests push data intact, then
  // corrupt the NEXT download a fresh device makes.
  let corruptNextBlob = false;
  // Armed via armFailBlobGetOnce(): the next blob GET returns 500 (simulating a
  // failed object/checkpoint/segment download), then self-clears.
  let failNextBlobGet = false;

  function reset() {
    paths.clear();
    blobs.clear();
    putFaultFired = false;
    getFaultFired = false;
    corruptNextBlob = false;
    failNextBlobGet = false;
  }

  /**
   * Logical content paths currently stored (repo-prefixed internally, but the
   * prefix is stripped so assertions keep using `sync/v7/...`).
   */
  function contentPaths() {
    return [...paths.keys()].map((key) => key.replace(/^[^/]+\/[^/]+\//, ""));
  }

  /** Whether a path matches an active blackhole fault (→ 404). */
  function blackholed(logicalPath) {
    return Boolean(faults?.blackholePath && faults.blackholePath.test(logicalPath));
  }
  /** Possibly corrupt a blob buffer for a given blobSha (same length, flipped byte). */
  function maybeCorrupt(sha, buffer) {
    const matched = faults?.corruptBlob === true || (faults?.corruptBlob instanceof Set && faults.corruptBlob.has(sha));
    if (!matched) return buffer;
    const corrupted = Buffer.from(buffer); // copy
    corrupted.writeUInt8((corrupted[0] ^ 0xff) >>> 0, 0);
    return corrupted;
  }
  // armCorruptOnce target: corrupt only immutable BLOB downloads (checkpoint/
  // segment/object), never the head.json contents read — a corrupt head would
  // fail JSON parse instead of the sha256 integrity check we intend to exercise.
  function corruptBlobBuffer(buffer) {
    corruptNextBlob = false;
    const corrupted = Buffer.from(buffer);
    corrupted.writeUInt8((corrupted[0] ^ 0xff) >>> 0, 0);
    return corrupted;
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      const parsed = new URL(req.url, `http://${hostname}`);
      const pathname = parsed.pathname;

      // GET /repos/:o/:r/git/blobs/:sha  -> raw blob bytes (Accept: raw media)
      const blobMatch = BLOB_RE.exec(pathname);
      if (req.method === "GET" && blobMatch) {
        const sha = decodeURIComponent(blobMatch[3]);
        if (failNextBlobGet) { failNextBlobGet = false; return sendJson(res, 500, { message: "transient mock blob GET failure" }); }
        const buffer = blobs.get(sha);
        if (!buffer) return sendJson(res, 404, { message: "Not Found" });
        return sendRaw(res, 200, corruptNextBlob ? corruptBlobBuffer(buffer) : maybeCorrupt(sha, buffer));
      }

      // GET/PUT /repos/:o/:r/contents/:path[?ref=branch]
      // Storage keys are repo-prefixed so distinct owner/repo pairs (different
      // vaults) never share files — mirroring real GitHub's per-repo namespaces.
      const contentMatch = CONTENT_RE.exec(pathname);
      if (contentMatch) {
        const storageKey = `${contentMatch[1]}/${contentMatch[2]}/${contentMatch[3].split("/").map(decodeURIComponent).join("/")}`;
        const logicalPath = contentMatch[3].split("/").map(decodeURIComponent).join("/");

        if (req.method === "GET") {
          if (blackholed(logicalPath)) return sendJson(res, 404, { message: "Not Found" });
          // Fault injection: fail the first matching GET once, then recover.
          if (faults?.failGetOnce && !getFaultFired && faults.failGetOnce.test(logicalPath)) {
            getFaultFired = true;
            return sendJson(res, 500, { message: "transient mock GET failure" });
          }
          const sha = paths.get(storageKey);
          if (!sha) return sendJson(res, 404, { message: "Not Found" });
          // Conditional GET: honor If-None-Match against the current etag (CAS mode).
          if (cas) {
            const inm = req.headers["if-none-match"];
            if (inm && inm === `"${sha}"`) return sendJson(res, 304, { message: "Not Modified" }, { etag: `"${sha}"` });
          }
          const buffer = blobs.get(sha);
          return sendJson(res, 200, {
            content: maybeCorrupt(sha, buffer).toString("base64"),
            encoding: "base64",
            sha,
            path: logicalPath,
            size: buffer.length,
            name: logicalPath.split("/").pop(),
          }, { etag: `"${sha}"` });
        }

        if (req.method === "PUT") {
          if (blackholed(logicalPath)) return sendJson(res, 404, { message: "Not Found" });
          // Fault injection: fail the first matching PUT once, then recover.
          if (faults?.failPutOnce && !putFaultFired && faults.failPutOnce.test(logicalPath)) {
            putFaultFired = true;
            return sendJson(res, 500, { message: "transient mock PUT failure" });
          }
          const body = JSON.parse((await readBody(req)).toString("utf8"));
          const buffer = Buffer.from(body.content, "base64");
          const sha = sha1Hex(buffer);
          const existed = paths.has(storageKey);
          // Fault injection: force the first head UPDATE to 409 Conflict once —
          // simulates a concurrent device winning the head CAS between this client's
          // readHead and publish, exercising syncWithGitHub's CAS retry/rebase loop.
          // Only fires on an existing head (a data-sync update), never on the
          // bootstrap create, so initialize is unaffected.
          if (faults?.conflictHeadPutOnce && !putFaultFired && existed && logicalPath === "sync/v7/head.json") {
            putFaultFired = true;
            return sendJson(res, 409, { message: "Conflict" });
          }
          if (faults?.conflictHeadPutAlways && existed && logicalPath === "sync/v7/head.json") {
            return sendJson(res, 409, { message: "Conflict" });
          }
          // CAS mode emulates GitHub's optimistic concurrency on the Contents API:
          //   • sha present and stale → 409 Conflict (head-advanced)
          //   • sha missing on an existing file → 422 (head-already-exists); the
          //     client turns this into an idempotent verify for immutables or a
          //     conflict for an initial head create.
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
          return sendJson(res, existed ? 200 : 201, {
            content: { sha, path: logicalPath, size: buffer.length },
            commit: { sha: randomBytes(20).toString("hex"), html_url: `https://example.com/mock/${logicalPath}` },
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
      resolve({ url, port: actualPort, hostname, reset, contentPaths, armCorruptOnce, armFailBlobGetOnce, close });
    });
  });
}

// Standalone: print the URL so a real browser/dev session can point at it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.PORT || 4317);
  startMockGitHubServer({ port }).then(({ url }) => {
    console.log(`mock github api listening on ${url}`);
    console.log(`point the app's 同步中转地址 to: ${url}`);
  });
}
