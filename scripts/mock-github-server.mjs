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
 * @returns {Promise<{ url: string, port: number, hostname: string, reset: () => void, close: () => Promise<void> }>}
 */
export function startMockGitHubServer({ port = 0, hostname = "127.0.0.1" } = {}) {
  const paths = new Map(); // logical content path -> blobSha
  const blobs = new Map(); // blobSha -> Buffer

  function reset() {
    paths.clear();
    blobs.clear();
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
        const buffer = blobs.get(sha);
        if (!buffer) return sendJson(res, 404, { message: "Not Found" });
        return sendRaw(res, 200, buffer);
      }

      // GET/PUT /repos/:o/:r/contents/:path[?ref=branch]
      const contentMatch = CONTENT_RE.exec(pathname);
      if (contentMatch) {
        const logicalPath = contentMatch[3].split("/").map(decodeURIComponent).join("/");

        if (req.method === "GET") {
          const sha = paths.get(logicalPath);
          if (!sha) return sendJson(res, 404, { message: "Not Found" });
          const buffer = blobs.get(sha);
          return sendJson(res, 200, {
            content: buffer.toString("base64"),
            encoding: "base64",
            sha,
            path: logicalPath,
            size: buffer.length,
            name: logicalPath.split("/").pop(),
          }, { etag: `"${sha}"` });
        }

        if (req.method === "PUT") {
          const body = JSON.parse((await readBody(req)).toString("utf8"));
          const buffer = Buffer.from(body.content, "base64");
          const sha = sha1Hex(buffer);
          const existed = paths.has(logicalPath);
          paths.set(logicalPath, sha);
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
      resolve({ url, port: actualPort, hostname, reset, close });
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
