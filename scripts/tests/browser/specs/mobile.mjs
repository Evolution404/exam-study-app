import * as harness from "../harness.mjs";
import * as helpers from "../helpers.mjs";

export async function runTopbarMobile(page) {
  const contextName = "topbar-mobile";
  await page.goto(`${harness.baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  const quickQuery = page.getByLabel("快速正则搜索题目、选项、标签或解析");
  const quickScope = page.getByLabel("快速搜索范围");
  const topbarBeforeFocus = await page.evaluate(() => {
    const search = document.querySelector(".topbar .searchbox")?.getBoundingClientRect();
    const sync = document.querySelector(".topbar .quick-sync-split")?.getBoundingClientRect();
    return { searchWidth: search?.width ?? 0, syncWidth: sync?.width ?? 0 };
  });
  const quickScopeBox = await quickScope.boundingBox();
  harness.assert.ok(quickScopeBox && quickScopeBox.width <= 60, "mobile quick-search scope trigger must fit its two-character label");
  harness.assert.equal(await page.locator(".topbar .quick-sync-label").evaluate((element) => getComputedStyle(element).display), "none", "mobile quick sync must show only its icon");
  await quickQuery.focus();
  await page.waitForFunction(() => (document.querySelector(".topbar .quick-sync-split")?.getBoundingClientRect().width ?? Infinity) <= 1);
  const topbarFocused = await page.evaluate(() => {
    const search = document.querySelector(".topbar .searchbox")?.getBoundingClientRect();
    const sync = document.querySelector(".topbar .quick-sync-split");
    return { searchWidth: search?.width ?? 0, syncOpacity: sync ? Number.parseFloat(getComputedStyle(sync).opacity) : 1 };
  });
  harness.assert.ok(topbarFocused.searchWidth > topbarBeforeFocus.searchWidth + 70, "focused mobile quick search must expand into the released sync space");
  harness.assert.ok(topbarFocused.syncOpacity <= .01, "focused mobile quick search must fully fade the sync entry");
  await helpers.capture(page, contextName, "topbar-search-focused");
  await quickQuery.evaluate((element) => element.blur());
  await page.waitForFunction((expectedWidth) => Math.abs((document.querySelector(".topbar .quick-sync-split")?.getBoundingClientRect().width ?? 0) - expectedWidth) <= 1, topbarBeforeFocus.syncWidth);
}

export async function runMobile(page, mockServer) {
  const contextName = "mobile";
  await page.goto(`${harness.baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await helpers.importFixture(page);
  await helpers.clickButton(page, "打开导航");
  await helpers.expectText(page, "题库");
  await helpers.capture(page, contextName, "mobile-menu");
  await helpers.clickButton(page, "题库");
  await helpers.expectText(page, "题库管理");
  await helpers.assertBankManagementActions(page);
  const beforeTemplateDownload = page.url();
  const download = page.waitForEvent("download", { timeout: 3_000 }).catch(() => undefined);
  await helpers.clickTextButton(page, "Excel 模板");
  harness.assert.ok(await download, "mobile template action should fall back to a browser download when Web Share is unavailable or denied");
  harness.assert.equal(page.url(), beforeTemplateDownload, "mobile template download must keep the app on its current page");
  harness.assert.equal(await page.locator(".toast").filter({ hasText: /permission denied/i }).count(), 0, "mobile template download must not surface a raw Web Share permission error");
  await helpers.createBlankBank(page, "手机手动创建题库");
  await helpers.capture(page, contextName, "mobile-bank-created-empty");
  await helpers.clickTextButton(page, "返回题库管理");
  await helpers.capture(page, contextName, "banks");
  await helpers.clickButton(page, "打开导航");
  await helpers.clickButton(page, "练习");
  await helpers.expectText(page, "练习中心");
  await helpers.selectBankOnPracticeSetup(page);
  await helpers.clickTextButton(page, "全量顺序练习");
  await page.locator(".question-card").waitFor({ state: "visible" });
  await helpers.clickButton(page, "打开题目总览");
  // Fresh practice starts at the first question — the overview focuses the
  // current row (第 1 题) with 0/5 answered.
  await helpers.assertOverviewFocus(page, 1, "0.0%");
  await helpers.capture(page, contextName, "practice-overview");
  await helpers.clickButton(page, "关闭题目总览");
  await helpers.capture(page, contextName, "practice");
  await helpers.clickButton(page, "暂停并返回首页");
  await helpers.expectText(page, "继续上次练习");
  const resumeTone = await page.locator(".resume-copy strong").evaluate((element) => ({
    color: getComputedStyle(element).color,
    expected: getComputedStyle(document.documentElement).getPropertyValue("--ink").trim(),
  }));
  harness.assert.equal(resumeTone.color, await page.evaluate((value) => {
    const probe = document.createElement("span");
    probe.style.color = value;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, resumeTone.expected), "resume card title must use the primary text color");
  harness.assert.ok(await page.locator(".resume-progress > i").isVisible(), "resume card must show a progress bar");
  await helpers.capture(page, contextName, "home-resume");
  await helpers.clickButton(page, "打开导航");
  await helpers.clickButton(page, "配置");
  await helpers.expectText(page, "答题配置");
  const syncHeading = page.getByRole("heading", { name: "GitHub 同步" });
  await syncHeading.scrollIntoViewIfNeeded();
  await helpers.expectText(page, "同步时间起点");
  harness.assert.ok(await page.locator('.mobile-sync-settings .history-sync-range-card input[type="date"]').isVisible(), "mobile sync settings expose the history start date");
  const clearDataHeading = page.getByRole("heading", { name: "清除本机所有数据" });
  await clearDataHeading.scrollIntoViewIfNeeded();
  harness.assert.ok(await page.getByRole("button", { name: "清除数据" }).isVisible(), "mobile preferences must expose the site-data reset button");
  await helpers.expectText(page, "客户端版本");
  await helpers.capture(page, contextName, "preferences-and-sync");
  const settingsCard = page.locator(".mobile-sync-settings .settings-card").first();
  const fields = settingsCard.locator("input");
  await fields.nth(0).fill("visible-qa-owner-mobile");
  await fields.nth(1).fill("visible-qa-repo-mobile");
  await fields.nth(2).fill("main");
  await fields.nth(3).fill("qa-token-mobile");
  await helpers.capture(page, contextName, "sync-card");
  // 与桌面组一致：401 场景走真实本地 unauthorized mock（填进中转地址），不拦截。
  const mobileFailingServer = await harness.startMockGitHubServer({ faults: { unauthorized: true } });
  await fields.nth(4).fill(mobileFailingServer.url);
  await helpers.clickTextButton(page, "立即同步");
  await helpers.expectSyncFailureNotice(page);
  await helpers.capture(page, contextName, "sync-error");
  await mobileFailingServer.close();

  // 触控点按切换：展开待同步项 → 点按编号格出现完整 id 提示，再点按关闭。
  const mobileSummary = page.locator(".sync-event-summary").first();
  await mobileSummary.scrollIntoViewIfNeeded();
  await mobileSummary.tap();
  await page.waitForTimeout(250);
  const mobileIdDd = page.locator(".sync-event-metadata dd").first();
  await mobileIdDd.scrollIntoViewIfNeeded();
  await mobileIdDd.tap();
  const mobileHint = page.locator(".hint-popover");
  await mobileHint.waitFor({ state: "visible" });
  harness.assert.ok((await mobileHint.first().innerText()).trim().length > 12, "tap must reveal the full change-set id hint");
  await mobileIdDd.tap();
  await mobileHint.waitFor({ state: "hidden" });

  // ===== 真实同步：第二设备从 mock 拉取第一设备（desktop）的数据 =====
  // Point at the same vault the desktop pushed to; this fresh IndexedDB has no
  // prior head cache, so the sync downloads everything the desktop uploaded and
  // merges it with the mobile's own local edits (bi-directional merge).
  const realFields = page.locator(".mobile-sync-settings .settings-card").first().locator("input");
  await realFields.nth(0).fill("qa");
  await realFields.nth(1).fill("browser-vault");
  await realFields.nth(4).fill(mockServer.url);
  await helpers.clickTextButton(page, "立即同步");
  await helpers.expectNotice(page, /v9 同步完成/, "second-device real sync success");
  await helpers.capture(page, contextName, "sync-mobile-pulled");
  // Cross-device: the desktop-created bank must have propagated to this device.
  await helpers.clickButton(page, "打开导航");
  await helpers.clickButton(page, "题库");
  await helpers.expectText(page, "题库管理");
  const crossDeviceBank = page.locator("button.bank-management-main").filter({ hasText: "手动创建测试题库" }).first();
  await crossDeviceBank.waitFor({ state: "visible" });
  harness.assert.ok(await crossDeviceBank.isVisible(), "desktop-created bank must appear on the second device after syncing");
  await helpers.capture(page, contextName, "cross-device-bank-pulled");
}
