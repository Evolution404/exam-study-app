import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../src/app/sync/sync-view.tsx", import.meta.url), "utf8");
const utilityCss = readFileSync(new URL("../../src/app/styles/app-utility.css", import.meta.url), "utf8");
const responsiveCss = readFileSync(new URL("../../src/app/styles/responsive-shared.css", import.meta.url), "utf8");

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

const ownerIndex = source.indexOf('name="github-username"');
const tokenIndex = source.indexOf('name="github-token"');
const repositoryIndex = source.indexOf('name="github-repository"');
const branchIndex = source.indexOf('name="github-branch"');
const relayIndex = source.indexOf('name="github-relay"');
assert.ok(ownerIndex >= 0 && tokenIndex >= 0 && repositoryIndex >= 0 && branchIndex >= 0 && relayIndex >= 0, "all GitHub connection inputs must be present");
assert.ok(
  ownerIndex < tokenIndex && tokenIndex < repositoryIndex && repositoryIndex < branchIndex && branchIndex < relayIndex,
  "iOS credential fields must be the first two GitHub connection inputs, before repository and branch fields",
);

assert.match(
  source,
  /起始日期<span className="history-date"><input type="date"/,
  "history date input must use a wrapper so iOS WebKit does not size padding on the native date control",
);
assert.match(
  utilityCss,
  /\.history-date\{[^}]*overflow:hidden;[^}]*padding:8px 10px;/,
  "history date wrapper must own the visual padding and clipping",
);
assert.match(
  utilityCss,
  /\.history-date input\{[^}]*margin:0;[^}]*border:0;[^}]*padding:0;/,
  "native date input must not carry padding or border on iOS WebKit",
);
assert.match(
  responsiveCss,
  /\.history-sync-range-controls\{[^}]*width:100%;[^}]*align-items:stretch;[^}]*flex-direction:column\}/,
  "mobile history controls must stack within the card width",
);

assert.match(source, /显示 GitHub 令牌/, "token visibility must be explicitly user-controlled");
assert.match(source, /隐藏 GitHub 令牌/, "token visibility must be explicitly reversible");
assert.match(source, /await syncApplication\.saveToken\(next\)/, "token persistence must support an async native credential adapter");
assert.match(source, /GitHub 令牌保存失败，请重试/, "token save failures must use a token-free notice");
assert.doesNotMatch(source, /navigator\.clipboard|console\.(log|error|warn)/, "token UI must not use clipboard or logging side channels");

console.log("native token UI tests passed: credential ordering, branch isolation, mobile date containment, explicit visibility and safe async errors");
