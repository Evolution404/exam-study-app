import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../src/app/sync/sync-view.tsx", import.meta.url), "utf8");

assert.match(source, /type=\{tokenVisible \? "text" : "password"\}/, "token must default to a hidden password field");
assert.match(
  source,
  /仓库所有者<input[^>]*name="github-username"[^>]*autoComplete="section-github username"/,
  "repository owner must be the explicit username target for iOS password autofill",
);
assert.match(
  source,
  /分支<input[^>]*name="github-branch"[^>]*autoComplete="off"/,
  "branch must opt out of credential autofill so iOS cannot treat it as the username field",
);
assert.match(
  source,
  /name="github-token"[^>]*autoComplete="section-github current-password"/,
  "token input must stay paired with the GitHub username autocomplete section",
);
assert.doesNotMatch(
  source,
  /分支<input[^>]*autoComplete="(?:username|current-password|section-github username|section-github current-password)"/,
  "branch must never expose credential autocomplete semantics",
);
assert.match(source, /显示 GitHub 令牌/, "token visibility must be explicitly user-controlled");
assert.match(source, /隐藏 GitHub 令牌/, "token visibility must be explicitly reversible");
assert.match(source, /await syncApplication\.saveToken\(next\)/, "token persistence must support an async native credential adapter");
assert.match(source, /GitHub 令牌保存失败，请重试/, "token save failures must use a token-free notice");
assert.doesNotMatch(source, /navigator\.clipboard|console\.(log|error|warn)/, "token UI must not use clipboard or logging side channels");

console.log("native token UI tests passed: iOS credential pairing, branch isolation, explicit visibility and safe async errors");
