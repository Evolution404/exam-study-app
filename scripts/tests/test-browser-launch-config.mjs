import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchProjectChromium, resolveChromeLaunchOptions } from "../tools/chrome-executable.mjs";

const readProjectFile = (relativePath) => readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

assert.deepEqual(
  resolveChromeLaunchOptions({ env: {}, fileExists: () => true }),
  {},
  "the default browser must be Playwright Chromium, not an auto-detected system Chrome",
);

assert.deepEqual(
  resolveChromeLaunchOptions({
    env: { CHROME_PATH: " /test/chrome-for-testing " },
    fileExists: (candidate) => candidate === "/test/chrome-for-testing",
  }),
  { executablePath: "/test/chrome-for-testing" },
  "an explicit CHROME_PATH override should remain available",
);

assert.throws(
  () => resolveChromeLaunchOptions({ env: { CHROME_PATH: "/missing/chrome" }, fileExists: () => false }),
  /CHROME_PATH does not exist: \/missing\/chrome/,
  "a misspelled override must fail instead of silently using another browser",
);

let receivedOptions;
const fakeChromium = {
  async launch(options) {
    receivedOptions = options;
    return { close() {} };
  },
};
await launchProjectChromium(fakeChromium, { headless: true }, { env: {}, fileExists: () => true });
assert.deepEqual(
  receivedOptions,
  { timeout: 20_000, headless: true },
  "browser launch should have a short startup timeout and no implicit executablePath",
);

await assert.rejects(
  () => launchProjectChromium({ launch: async () => { throw new Error("missing executable"); } }, {}, { env: {} }),
  /npm run browser:install/,
  "browser launch failures should provide the recovery command",
);

const packageJson = JSON.parse(readProjectFile("package.json"));
assert.equal(
  packageJson.scripts["browser:install"],
  "playwright-core install chromium webkit",
  "the repository must expose one stable command for installing its matched Chromium and WebKit",
);
assert.match(
  readProjectFile("scripts/tools/run-test-full.mjs"),
  /const scripts = \["browser:install", "build", "test:fast"\]/,
  "release-level browser tests must prepare both Playwright engines first",
);
assert.match(
  readProjectFile("Makefile"),
  /^browser-install:.*\n\tnpm run browser:install$/m,
  "Makefile must keep the dedicated browser installation entry point",
);
assert.doesNotMatch(
  readProjectFile("scripts/tools/chrome-executable.mjs"),
  /Applications\/Google Chrome|google-chrome-stable|chromium-browser|spawnSync/,
  "the launcher must not restore automatic system-browser discovery",
);

assert.match(
  readProjectFile("scripts/tests/browser/harness.mjs"),
  /BROWSER_ENGINE must be chromium or webkit/,
  "browser QA must reject unknown engines instead of silently changing coverage",
);

console.log("browser launch config tests passed: isolated Chromium remains default and WebKit is selectable");
