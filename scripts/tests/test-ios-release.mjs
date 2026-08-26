import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSideStoreSource, IOS_BUNDLE_ID, SIDESTORE_IPA_URL, SIDESTORE_SOURCE_URL } from "../tools/generate-sidestore-source.mjs";
import { validatePublishedSource } from "../tools/verify-sidestore-release.mjs";
import { onRequest, RELEASE_BASE } from "../../proxy/sidestore-pages-function.js";

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

const source = createSideStoreSource({
  version: "1.0.321",
  date: "2026-08-22",
  size: 123456,
  notes: "测试更新",
});
assert.equal(source.identifier, "com.evolution404.shijuan.source");
assert.equal(source.sourceURL, SIDESTORE_SOURCE_URL);
assert.equal(source.apps[0].bundleIdentifier, IOS_BUNDLE_ID);
assert.equal(source.apps[0].version, "1.0.321", "legacy version field must remain available");
assert.equal(source.apps[0].downloadURL, SIDESTORE_IPA_URL, "legacy download URL must use Cloudflare");
assert.equal(source.apps[0].versions[0].version, "1.0.321");
assert.equal(source.apps[0].versions[0].downloadURL, SIDESTORE_IPA_URL);
assert.equal(source.apps[0].versions[0].size, 123456);
assert.equal(validatePublishedSource(source, "1.0.321").size, 123456);
assert.throws(
  () => createSideStoreSource({ version: "build-1", date: "2026-08-22", size: 1, notes: "" }),
  /无效 iOS 版本号/,
);

let forwarded;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  forwarded = { input: String(input), init };
  return new Response('{"ok":true}', {
    status: 200,
    headers: { "content-type": "text/plain", "content-length": "11", etag: '"asset"' },
  });
};
try {
  const response = await onRequest({ request: new Request(SIDESTORE_SOURCE_URL) });
  assert.equal(response.status, 200);
  assert.equal(forwarded.input, `${RELEASE_BASE}/sidestore-source.json`);
  assert.equal(forwarded.init.redirect, "follow");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-cache, no-store, must-revalidate");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(await response.text(), '{"ok":true}');

  const head = await onRequest({ request: new Request(SIDESTORE_IPA_URL, { method: "HEAD", headers: { range: "bytes=0-1023" } }) });
  assert.equal(head.status, 200);
  assert.equal(forwarded.input, `${RELEASE_BASE}/shijuan.ipa`);
  assert.equal(forwarded.init.method, "HEAD");
  assert.equal(forwarded.init.headers.get("range"), "bytes=0-1023", "IPA proxy must preserve range requests");
  assert.equal(head.headers.get("content-disposition"), 'attachment; filename="shijuan.ipa"');
  assert.equal(await head.text(), "");
} finally {
  globalThis.fetch = originalFetch;
}

assert.equal((await onRequest({ request: new Request("https://learn.980923.xyz/sidestore/unknown") })).status, 404);
assert.equal((await onRequest({ request: new Request(SIDESTORE_SOURCE_URL, { method: "POST" }) })).status, 405);

const workflow = read(".github/workflows/deploy-pages.yml");
const publishSideStore = read("scripts/tools/publish-sidestore-release.sh");
const rollbackSideStore = read("scripts/tools/rollback-sidestore-latest.sh");
assert.match(workflow, /ios_release:[\s\S]*runs-on: macos-15/, "iOS release must use a pinned macOS runner");
assert.match(workflow, /ios_release:[\s\S]*?needs: build\n/, "IPA must publish in parallel with both web targets after the common build");
assert.match(workflow, /previous_release_tag: \$\{\{ steps\.previous-release\.outputs\.tag \}\}/, "IPA release must preserve the previous latest tag");
assert.match(workflow, /startsWith\("ios-v"\)|startswith\("ios-v"\)/, "IPA rollback source must ignore unrelated repository releases");
assert.match(workflow, /make ios-ipa[\s\S]*IOS_MARKETING_VERSION/, "workflow must build the existing unsigned IPA target with an explicit version");
assert.match(workflow, /scripts\/tools\/publish-sidestore-release\.sh/, "workflow must delegate versioned GitHub Release publication");
assert.match(publishSideStore, /gh release create[\s\S]*gh release upload[\s\S]*--latest/, "SideStore helper must publish versioned GitHub Release assets");
assert.match(workflow, /sidestore_smoke:[\s\S]*needs: \[deploy, deploy_cloudflare, ios_release\][\s\S]*verify-sidestore-release\.mjs --version "\$\{\{ needs\.ios_release\.outputs\.version \}\}"/, "SideStore endpoints must be verified after all three targets publish");
assert.match(workflow, /rollback_ios_release:[\s\S]*needs\.sidestore_smoke\.result == 'failure'[\s\S]*scripts\/tools\/rollback-sidestore-latest\.sh/, "any post-deploy test failure must delegate restoration of the previous latest IPA");
assert.match(rollbackSideStore, /gh release edit "\$PREVIOUS_RELEASE_TAG" --repo "\$GITHUB_REPOSITORY" --latest/, "SideStore rollback helper must restore the previous latest IPA");
assert.doesNotMatch(workflow + rollbackSideStore, /gh release delete/, "IPA rollback must preserve immutable release history");

const makefile = read("Makefile");
assert.match(makefile, /MARKETING_VERSION="\$\(IOS_MARKETING_VERSION\)"/, "IPA build must accept a marketing-version override");
assert.match(makefile, /CURRENT_PROJECT_VERSION="\$\(IOS_BUILD_NUMBER\)"/, "IPA build must accept a build-number override");

const routes = JSON.parse(read("public/_routes.json"));
assert.deepEqual(routes.include, ["/api-github/*", "/sidestore/*"]);

console.log("iOS release tests passed: deterministic source metadata, Cloudflare relay, parallel publish, online smoke and latest-pointer rollback");
