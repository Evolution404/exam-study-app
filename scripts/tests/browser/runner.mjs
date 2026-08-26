import { mkdir, writeFile } from "node:fs/promises";
import * as harness from "./harness.mjs";
import { GROUPS } from "./groups.mjs";

async function main() {
  await mkdir(harness.runRoot, { recursive: true });
  await harness.startDevServerIfNeeded();
  // In-process mock GitHub backend: all browser contexts share it, so the
  // desktop sync pushes real data and the mobile sync pulls it back — a true
  // cross-device round-trip without any external network.
  const mockServer = await harness.startMockGitHubServer();
  const browser = harness.browserEngineName === "webkit"
    ? await harness.webkit.launch({ headless: harness.headless, timeout: 20_000 })
    : await harness.launchProjectChromium(harness.chromium, {
      headless: harness.headless,
      args: ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage"],
    });

  // BROWSER_GROUPS is comma-separated; unset = all groups. Each group gets a
  // fresh browser context/IndexedDB. requires expands cross-device setup
  // dependencies first (mobile -> desktop) without changing the public runner.
  const allKeys = GROUPS.map((group) => group.key);
  const requested = (process.env.BROWSER_GROUPS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const unknown = requested.filter((key) => !allKeys.includes(key));
  if (unknown.length) throw new Error(`Unknown BROWSER_GROUPS: ${unknown.join(", ")}. Available: ${allKeys.join(", ")}`);
  const requestedSet = new Set(requested.length ? requested : allKeys);
  const selected = GROUPS.filter((group) => requestedSet.has(group.key));
  const expanded = [];
  for (const group of selected) {
    for (const dependency of group.requires ?? []) {
      const dep = GROUPS.find((candidate) => candidate.key === dependency);
      if (dep && !expanded.some((item) => item.key === dep.key)) expanded.push(dep);
    }
    if (!expanded.some((item) => item.key === group.key)) expanded.push(group);
  }

  const ran = [];
  try {
    for (const group of expanded) {
      const contextOptions = {
        viewport: group.viewport,
        deviceScaleFactor: 1,
        ...(group.isMobile ? { isMobile: true, hasTouch: true } : {}),
      };
      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(25_000);
      const before = harness.screenshots.length;
      await group.run(page, mockServer);
      const count = harness.screenshots.length - before;
      ran.push({ key: group.key, screenshots: count });
      harness.assert.ok(count >= group.minScreenshots, `${group.key} group must capture at least ${group.minScreenshots} screenshots, got ${count}`);
      await context.close();
    }
  } finally {
    await mockServer.close();
    await browser.close();
  }
  const manifest = {
    baseUrl: harness.baseUrl,
    browserSource: process.env.CHROME_PATH?.trim() ? "CHROME_PATH" : "playwright",
    browserVersion: browser.version(),
    groups: ran,
    screenshots: harness.screenshots,
  };
  await writeFile(harness.path.join(harness.runRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Browser QA passed (${harness.headless ? "headless" : "visible"}): ${ran.map((item) => `${item.key}(${item.screenshots})`).join(", ")} in ${harness.path.relative(harness.root, harness.runRoot)}`);
}

try {
  await main();
} finally {
  if (harness.devServer && !harness.devServer.killed) harness.devServer.kill("SIGTERM");
}
