import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const helper = (name: string) => fileURLToPath(new URL(`../tools/${name}`, import.meta.url));
const helpers = [
  helper("purge-cloudflare-cache.sh"),
  helper("rollback-cloudflare-pages.sh"),
  helper("publish-sidestore-release.sh"),
  helper("rollback-sidestore-latest.sh"),
];

for (const file of helpers) {
  const syntax = spawnSync("bash", ["-n", file], { encoding: "utf8" });
  assert.equal(syntax.status, 0, `${file} must remain valid bash: ${syntax.stderr}`);
}

const root = mkdtempSync(join(tmpdir(), "deploy-helper-test-"));
try {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const curlLog = join(root, "curl.log");
  const ghLog = join(root, "gh.log");
  const curlMock = join(bin, "curl");
  const ghMock = join(bin, "gh");

  writeFileSync(curlMock, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> "$MOCK_CURL_LOG"\ncase "$*" in\n  *'/zones?name='*) printf '{"result":[{"id":"zone-test"}]}' ;;\n  *'/purge_cache'*) printf '{"success":true}' ;;\n  *'/rollback'*) printf '{"success":true}' ;;\n  *) printf '{"success":true}' ;;\nesac\n`);
  writeFileSync(ghMock, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> "$MOCK_GH_LOG"\nif [[ "\${1:-}" == "api" ]]; then\n  printf '%s\\n' "$MOCK_LATEST_TAG"\nfi\n`);
  chmodSync(curlMock, 0o755);
  chmodSync(ghMock, 0o755);

  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    MOCK_CURL_LOG: curlLog,
    MOCK_GH_LOG: ghLog,
  };

  const purge = spawnSync("bash", [helper("purge-cloudflare-cache.sh")], {
    encoding: "utf8",
    env: {
      ...baseEnv,
      CLOUDFLARE_API_TOKEN: "test-token",
      CLOUDFLARE_ZONE_NAME: "example.test",
    },
  });
  assert.equal(purge.status, 0, purge.stderr);
  const purgeRequests = readFileSync(curlLog, "utf8");
  assert.match(purgeRequests, /zones\?name=example\.test/, "purge helper must resolve the configured zone");
  assert.match(purgeRequests, /zones\/zone-test\/purge_cache/, "purge helper must purge the resolved zone");

  writeFileSync(curlLog, "");
  const cloudflareRollback = spawnSync("bash", [helper("rollback-cloudflare-pages.sh")], {
    encoding: "utf8",
    env: {
      ...baseEnv,
      CLOUDFLARE_API_TOKEN: "test-token",
      CLOUDFLARE_ACCOUNT_ID: "account-test",
      CLOUDFLARE_PROJECT_NAME: "project-test",
      PREVIOUS_DEPLOYMENT_ID: "deployment-test",
    },
  });
  assert.equal(cloudflareRollback.status, 0, cloudflareRollback.stderr);
  assert.match(
    readFileSync(curlLog, "utf8"),
    /accounts\/account-test\/pages\/projects\/project-test\/deployments\/deployment-test\/rollback/,
    "Cloudflare rollback helper must target the recorded immutable deployment",
  );

  const sideStoreEnv = {
    ...baseEnv,
    GITHUB_REPOSITORY: "Evolution404/exam-study-app",
    PREVIOUS_RELEASE_TAG: "ios-v1.0.100",
    MOCK_LATEST_TAG: "ios-v1.0.100",
  };
  const sideStoreRollback = spawnSync("bash", [helper("rollback-sidestore-latest.sh")], { encoding: "utf8", env: sideStoreEnv });
  assert.equal(sideStoreRollback.status, 0, sideStoreRollback.stderr);
  const ghCalls = readFileSync(ghLog, "utf8");
  assert.match(ghCalls, /release edit ios-v1\.0\.100 .*--latest/, "SideStore rollback must move only the latest pointer");
  assert.match(ghCalls, /releases\/latest/, "SideStore rollback must verify the resulting latest release");

  const mismatch = spawnSync("bash", [helper("rollback-sidestore-latest.sh")], {
    encoding: "utf8",
    env: { ...sideStoreEnv, MOCK_LATEST_TAG: "ios-v1.0.099" },
  });
  assert.notEqual(mismatch.status, 0, "SideStore rollback must fail if the latest pointer does not match the requested release");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("deploy helper tests passed: shell syntax, Cloudflare purge/rollback and SideStore latest rollback simulation");
