import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../src/app/sync/sync-view.tsx", import.meta.url), "utf8");
assert.match(source, /type=\{tokenVisible \? "text" : "password"\}/, "token must default to a hidden password field");
assert.match(source, /autoComplete="current-password"/, "token input must expose standard password autocomplete semantics");
assert.match(source, /显示 GitHub 令牌/, "token visibility must be explicitly user-controlled");
assert.match(source, /隐藏 GitHub 令牌/, "token visibility must be explicitly reversible");
assert.match(source, /await syncApplication\.saveToken\(next\)/, "token persistence must support an async native credential adapter");
assert.match(source, /GitHub 令牌保存失败，请重试/, "token save failures must use a token-free notice");
assert.doesNotMatch(source, /navigator\.clipboard|console\.(log|error|warn)/, "token UI must not use clipboard or logging side channels");

console.log("native token UI tests passed: password, explicit visibility, autocomplete and safe async errors");
