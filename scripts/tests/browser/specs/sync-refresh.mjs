import * as harness from "../harness.mjs";
import * as helpers from "../helpers.mjs";

// ===== 跨设备同步刷新练习（两设备共享同一 mock vault） =====
// 场景：设备 A 练习中答完第 1 题并推送；设备 B 拉取后继续答第 2、3 题并推送；
// 设备 A 回到练习界面点同步，应刷新练习信息、切到最后一道做完的题（Q3）。
// 这覆盖 refreshActivePracticeAfterSync：同步拉取后 practiceSession（内存快照）
// 必须对齐 DB 里合并进来的新作答。
export async function runSyncRefreshQA(page, mockServer) {
  const contextName = "sync-refresh";
  const browser = page.context().browser();
  const vault = { owner: "qa", repo: "sync-refresh-vault", branch: "main", apiBaseUrl: mockServer.url };

  // ===== 设备 A：答第 1 题并推送 run =====
  await page.goto(`${harness.baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await helpers.importFixture(page);
  await helpers.setPracticePreferences(page, { autoNextCorrect: false, shuffleOptions: false });
  await page.evaluate((settings) => {
    window.localStorage.setItem("github-settings", JSON.stringify(settings));
    window.localStorage.setItem("github-token", "qa-token");
  }, vault);
  await helpers.clickButton(page, "练习");
  await helpers.expectText(page, "练习中心");
  await helpers.selectBankOnPracticeSetup(page);
  await helpers.clickTextButton(page, "全量顺序练习");
  await page.locator(".question-card").waitFor({ state: "visible" });
  await helpers.waitForQuestion(page, 1, 5);
  await helpers.answerCurrentQuestion(page, [0]); // Q1 单选 传输电能 → 对
  await helpers.expectText(page, "回答正确");
  await helpers.clickButton(page, "暂停并返回首页");
  await helpers.expectText(page, "继续上次练习");
  const quickSyncButton = page.locator(".sync-pill.quick-sync");
  const quickSyncBox = await quickSyncButton.boundingBox();
  harness.assert.ok(quickSyncBox, "quick-sync button must have a pointer target");
  const requestsBeforeCancelledHold = mockServer.stats.totalRequests;
  await page.mouse.move(quickSyncBox.x + quickSyncBox.width / 2, quickSyncBox.y + quickSyncBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  harness.assert.equal(await quickSyncButton.evaluate((button) => button.classList.contains("holding")), true, "dead-zone press must expose the restore-hold state");
  await page.mouse.up();
  await page.waitForTimeout(250);
  harness.assert.equal(mockServer.stats.totalRequests, requestsBeforeCancelledHold, "releasing in the hold dead zone must not send any sync request");
  harness.assert.equal(await quickSyncButton.evaluate((button) => button.classList.contains("holding")), false, "cancelled hold must clear its visual state");
  await quickSyncButton.click();
  await helpers.expectNotice(page, /同步完成/, "device A first sync pushes bank + run");
  await page.locator(".resume-card .resume-continue").click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  // resume 停在最后作答的下一题（已答 Q1 不回看），即 Q2。
  await helpers.waitForQuestion(page, 2, 5);
  await helpers.capture(page, contextName, "a-resumed-q2");

  // ===== 设备 B：拉取 run，补答 Q2/Q3 并推送 =====
  const contextB = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const pageB = await contextB.newPage();
  pageB.setDefaultTimeout(10_000);
  try {
    await pageB.goto(`${harness.baseUrl}/`, { waitUntil: "domcontentloaded" });
    await pageB.locator(".app-shell").waitFor({ state: "visible" });
    await helpers.setPracticePreferences(pageB, { autoNextCorrect: false, shuffleOptions: false });
    await pageB.evaluate((settings) => {
      window.localStorage.setItem("github-settings", JSON.stringify(settings));
      window.localStorage.setItem("github-token", "qa-token");
    }, vault);
    await pageB.locator(".sync-pill.quick-sync").click();
    await helpers.expectNotice(pageB, /同步完成/, "device B pulls device A data");
    await helpers.expectText(pageB, "继续上次练习");
    await pageB.locator(".resume-card .resume-continue").click();
    await pageB.locator(".question-card").waitFor({ state: "visible" });
    // 全量顺序练习按 TYPE_ORDER 分组排序：单选(传输电能/发现异常)→多选(安全巡视)→判断→计算。
    // A 答了第一题（传输电能），B 拉取后 resume 停在下一题：发现异常（单选，B 对）。
    await helpers.waitForQuestion(pageB, 2, 5);
    await helpers.answerCurrentQuestion(pageB, [1]); // 发现异常 单选 B 按流程记录并报告 → 对
    await helpers.expectText(pageB, "回答正确");
    await helpers.clickButton(pageB, "下一题");
    await helpers.waitForQuestion(pageB, 3, 5);
    await helpers.answerCurrentQuestion(pageB, [0, 1], true); // 安全巡视 多选 A 按规程/B 核对编号 → 对
    await helpers.expectText(pageB, "回答正确");
    await helpers.capture(page, contextName, "b-answered-q3");
    await helpers.clickButton(pageB, "暂停并返回首页");
    await helpers.expectText(pageB, "继续上次练习");
    await pageB.locator(".sync-pill.quick-sync").click();
    await helpers.expectNotice(pageB, /同步完成/, "device B pushes Q2/Q3 answers");
    // B 推送的 events 写进 mock 后 A 才能拉取，留出稳定窗口避免竞态。
    await pageB.waitForTimeout(600);
  } finally {
    await contextB.close();
  }

  // ===== 设备 A 再同步：刷新练习信息并切到最后一道做完的题（Q3） =====
  await page.locator(".sync-pill.quick-sync").click();
  await helpers.expectNotice(page, /已同步本练习 2 道新作答/, "device A refresh notice");
  await page.locator(".question-card").waitFor({ state: "visible" });
  await helpers.waitForQuestion(page, 3, 5);
  const stem = (await page.locator(".practice-stem").innerText()).replace(/\s+/g, " ");
  harness.assert.ok(stem.includes("哪些做法有助于安全巡视"), "sync must jump to the last answered question (第 3 题 安全巡视)");
  await helpers.capture(page, contextName, "a-synced-jumped-q3");
}
