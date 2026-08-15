import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file: string) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const common = read("proxy/github-relay-common.js");
const pages = read("proxy/pages-function.js");
const worker = read("proxy/worker.js");
const routes = JSON.parse(read("public/_routes.json")) as { include: string[]; exclude: string[] };

// 两个入口必须共用同一份公共逻辑，不能各自内联一套。
assert.match(pages, /from "\.\/github-relay-common\.js"/, "pages relay must import the shared relay module");
assert.match(worker, /from "\.\/github-relay-common\.js"/, "worker relay must import the shared relay module");
assert.doesNotMatch(pages, /https:\/\/api\.github\.com/, "pages relay must not duplicate the upstream origin");
assert.doesNotMatch(worker, /https:\/\/api\.github\.com/, "worker relay must not duplicate the upstream origin");

// 上游、剥除头清单、redirect 语义、set-cookie 处理都只定义在公共模块里。
assert.match(common, /GITHUB_API_UPSTREAM\s*=\s*"https:\/\/api\.github\.com"/, "upstream must target the GitHub API");
for (const header of [
  "cookie",
  "host",
  "content-length",
  "cf-connecting-ip",
  "cf-ray",
  "cf-ipcountry",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
]) {
  assert.match(common, new RegExp(`"${header}"`), `request header strip list must include ${header}`);
}
assert.match(common, /for \(const name of REQUEST_HEADERS_TO_STRIP\) out\.delete\(name\)/, "shared request builder must apply the strip list");
assert.match(common, /redirect: "manual"/, "shared request builder must preserve redirect semantics");
assert.match(common, /headers\.delete\("set-cookie"\)/, "shared response helper must drop upstream cookies");

// Pages Function：同源代理，剥 /api-github 前缀，响应全量透传但去掉 set-cookie。
assert.match(pages, /buildUpstreamRequest\(context\.request, \{ pathPrefix: "\/api-github" \}\)/, "pages relay must strip the /api-github prefix");
assert.match(pages, /withoutSetCookie\(response\)/, "pages relay must drop set-cookie on the way back");

// Worker：跨域代理，自行处理 OPTIONS 预检，GET/HEAD 不带 body，响应头走白名单。
assert.match(worker, /if \(request\.method === "OPTIONS"\)/, "worker relay must answer CORS preflight");
assert.match(worker, /buildUpstreamRequest\(request, \{ omitBodyForGetHead: true \}\)/, "worker relay must omit GET/HEAD bodies");
for (const header of ["etag", "content-type", "last-modified", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
  assert.match(worker, new RegExp(`"${header}"`), `worker relay must expose ${header}`);
}
assert.match(worker, /Access-Control-Allow-Origin": "\*"/, "worker relay must allow cross-origin browser clients");

// Pages 路由只覆盖 /api-github/*，其他路径不得挂函数。
assert.deepEqual(routes.include, ["/api-github/*"], "functions route only the API proxy path");
assert.deepEqual(routes.exclude, [], "no other path runs as a function");

console.log("GitHub relay consistency tests passed: shared upstream/strip-list/redirect, pages prefix, worker CORS, pages routes");
