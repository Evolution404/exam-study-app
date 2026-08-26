import * as harness from "../harness.mjs";
import * as helpers from "../helpers.mjs";
import * as fixtures from "../fixtures.mjs";

export async function runDesktop(page, mockServer) {
  const contextName = "desktop";
  await page.goto(`${harness.baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await helpers.expectText(page, "今日");
  await helpers.capture(page, contextName, "home-empty");

  await helpers.importFixture(page);
  await helpers.expectText(page, "送电线路工-初级工");
  await helpers.clickButton(page, "今日");
  const scopedAttemptLabel = page.locator(".stat-card > span:not(.stat-icon)").filter({ hasText: "作答" }).first();
  harness.assert.equal(await scopedAttemptLabel.innerText(), "作答（近 90 天）", "home statistics must show the selected progress scope");
  await helpers.capture(page, contextName, "home-imported");

  await helpers.assertSearchFilterInteractions(page, contextName);

  await helpers.clickButton(page, "题库");
  await helpers.expectText(page, "题库管理");
  const excelInput = page.locator('input[type="file"][accept*=".xlsx"]').first();
  await excelInput.setInputFiles(fixtures.excelFixtureFile);
  await helpers.expectNotice(page, /已从 Excel 导入/, "Excel import notice");
  await helpers.assertBankManagementActions(page);
  await helpers.createBlankBank(page, "手动创建测试题库");
  await helpers.capture(page, contextName, "bank-created-empty");
  await helpers.clickTextButton(page, "返回题库管理");
  await helpers.capture(page, contextName, "excel-imported");
  // Playwright's Linux WebKit port cannot structured-clone Blob values into
  // IndexedDB (a minimal Blob put fails before application code runs). The
  // Chromium suite retains the end-to-end image persistence regression; the
  // WebKit smoke uses image-free desktop and mobile core scenarios instead.
  if (harness.browserEngineName !== "webkit") await helpers.attachFixtureImage(page);

  await helpers.clickButton(page, "配置");
  await helpers.expectText(page, "答题配置");
  await helpers.clickTextButton(page, "浅色");
  const autoNext = page.getByRole("checkbox", { name: "答对后自动下一题" });
  if (await autoNext.isChecked()) await autoNext.uncheck({ force: true });
  const shuffle = page.getByRole("checkbox", { name: "随机排列选项" });
  if (await shuffle.isChecked()) await shuffle.uncheck({ force: true });
  const groupSize = page.getByRole("spinbutton", { name: "每组题目数量" });
  await groupSize.fill("2");
  await groupSize.blur();
  await helpers.clickTextButton(page, "深色");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  const darkInputStyles = await page.evaluate(() => {
    const group = document.querySelector('input[aria-label="每组题目数量"]');
    const goal = document.querySelector('input[aria-label="每日目标题数"]');
    return {
      groupInput: getComputedStyle(group).backgroundColor,
      groupShell: getComputedStyle(group.parentElement).backgroundColor,
      goalInput: getComputedStyle(goal).backgroundColor,
      goalShell: getComputedStyle(goal.parentElement).backgroundColor,
    };
  });
  harness.assert.equal(darkInputStyles.groupInput, "rgba(0, 0, 0, 0)", "dark group-size input must use its field shell background");
  harness.assert.equal(darkInputStyles.goalInput, "rgba(0, 0, 0, 0)", "dark daily-goal input must use its field shell background");
  harness.assert.equal(darkInputStyles.groupShell, darkInputStyles.goalShell, "dark numeric field shells must use one consistent surface");
  const themeCheckOffset = await page.locator('.theme-setting button.active > svg').evaluate((icon) => {
    const iconBox = icon.getBoundingClientRect();
    const buttonBox = icon.parentElement.getBoundingClientRect();
    return Math.abs((iconBox.top + iconBox.height / 2) - (buttonBox.top + buttonBox.height / 2));
  });
  harness.assert.ok(themeCheckOffset < 2, `theme checkmark must be vertically centered, offset was ${themeCheckOffset}px`);
  await page.getByRole("radio", { name: /永久/ }).click();
  await helpers.clickButton(page, "今日");
  await helpers.expectText(page, "作答（全部时间）");
  await helpers.clickButton(page, "配置");
  await helpers.expectText(page, "答题配置");
  await helpers.expectText(page, "客户端版本");
  await page.evaluate(() => {
    const raw = JSON.parse(window.localStorage.getItem("study-v7-preferences") ?? "{}");
    window.localStorage.setItem("study-v7-preferences", JSON.stringify({ ...raw, questionTransition: "slide" }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await helpers.clickButton(page, "配置");
  await helpers.expectText(page, "答题配置");

  const shortcutHeading = page.getByRole("heading", { name: "电脑快捷键" });
  await shortcutHeading.scrollIntoViewIfNeeded();
  const addShortcut = page.locator(".shortcut-capture").filter({ hasText: "添加" }).first();
  await addShortcut.click();
  await page.keyboard.press("F9");
  await page.locator(".shortcut-binding-values kbd").filter({ hasText: "F9" }).first().waitFor({ state: "visible" });
  await helpers.capture(page, contextName, "shortcut-captured");

  const autoSync = page.getByRole("checkbox", { name: "累计事件后自动同步" });
  if (await autoSync.isChecked()) await autoSync.uncheck({ force: true });
  await helpers.capture(page, contextName, "preferences");

  await helpers.clickButton(page, "练习");
  await helpers.expectText(page, "练习中心");
  await helpers.selectBankOnPracticeSetup(page);
  await helpers.clickTextButton(page, "随机指定题数");
  const customRandomCount = page.getByRole("spinbutton", { name: "本次随机题数" });
  await customRandomCount.fill("3");
  harness.assert.equal(await customRandomCount.inputValue(), "3", "custom random count should be editable without changing preferences");
  await helpers.capture(page, contextName, "practice-custom-random");
  // 高级筛选折叠区：最近作答日期区间必须可交互（旧 .date-range-filter 类名失配曾导致控件无样式）。
  await page.locator(".advanced-toggle").filter({ hasText: "高级筛选" }).click();
  const dateFrom = page.getByLabel("最近作答从");
  await dateFrom.fill("2026-01-01");
  harness.assert.equal(await dateFrom.inputValue(), "2026-01-01", "date range start input should accept and echo a date");
  const dateTo = page.getByLabel("到", { exact: true });
  await dateTo.fill("2026-12-31");
  harness.assert.equal(await dateTo.inputValue(), "2026-12-31", "date range end input should accept and echo a date");
  await dateFrom.fill("");
  await dateTo.fill("");
  await page.locator(".advanced-toggle").filter({ hasText: "高级筛选" }).click();
  await helpers.capture(page, contextName, "practice-setup");
  // 快捷卡片一键开始：点「全量顺序练习」直接进入练习，不经过自定义组合的题量状态。
  await helpers.clickTextButton(page, "全量顺序练习");
  await page.locator(".question-card").waitFor({ state: "visible" });
  const pendingBeforeFirstAnswer = await helpers.pendingEventCount(page);
  await helpers.answerCurrentQuestion(page, [0]);
  await helpers.expectText(page, "回答正确");
  harness.assert.equal(await helpers.pendingEventCount(page), pendingBeforeFirstAnswer + 1, "one submitted answer must add exactly one pending sync event");
  const note = page.locator('textarea[placeholder^="写下错因、口诀或区分条件…"]');
  await note.fill("先确认线路和风险，再按规程巡视。");
  await helpers.expectText(page, "已自动保存");
  await helpers.capture(page, contextName, "practice-answer");

  await helpers.clickButton(page, "打开题目总览");
  await helpers.expectText(page, "题目总览");
  // The overview focuses the CURRENT question (第 1 题, 单选 — the first
  // fixture row), not the next-unanswered one: the grid scrolls it into view.
  await helpers.assertOverviewFocus(page, 1, "20.0%");
  await helpers.capture(page, contextName, "practice-overview");
  const calculation = page.getByRole("button", { name: "第 5 题，计算" });
  await calculation.scrollIntoViewIfNeeded();
  await calculation.click();
  await helpers.waitForQuestion(page, 5);
  await page.locator(".asset-image img").waitFor({ state: "visible" });
  harness.assert.equal(await page.getByText(/依次填写题干中的/).count(), 0, "inline calculation blanks must not repeat a separate guidance card");
  const earlyCalculationAnswer = page.getByRole("spinbutton", { name: "第1空答案" });
  await earlyCalculationAnswer.fill("10.05");
  await page.getByRole("spinbutton", { name: "第2空答案" }).fill("20.1");
  await helpers.clickTextButton(page, "确认答案");
  await helpers.expectText(page, "回答正确");
  await helpers.clickButton(page, "打开题目总览");
  // After answering the calculation (第 5 题), the overview focuses the current
  // question — the calculation row (auto-advance may not have fired yet).
  await helpers.assertOverviewFocus(page, 5, "40.0%");
  await helpers.capture(page, contextName, "practice-overview-first-unanswered");
  await page.getByRole("button", { name: "第 2 题，单选" }).click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".practice-layout")).animationName === "question-page-back");
  await helpers.waitForQuestion(page, 2);
  // The app keeps the stable type grouping order (single choice, multi
  // choice, judgment), so the fourth fixture row is the second visible item.
  await helpers.answerCurrentQuestion(page, [0]);
  await helpers.expectText(page, "这次没有答对");
  const wrongFeedback = await page.locator(".result-box").innerText();
  harness.assert.match(wrongFeedback, /你的选择：A/);
  harness.assert.doesNotMatch(wrongFeedback, /立即离开并隐瞒|按流程记录并报告/);
  await helpers.capture(page, contextName, "practice-wrong-answer");
  // 复制题目双按钮（做错态）：不含答案版附「我的选择」且绝不泄漏答案；含答案版两行齐全。
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text) => { window.__copyCapture = text; return Promise.resolve(); } } });
  });
  await helpers.clickButton(page, "复制题目");
  const questionOnlyCopy = await page.evaluate(() => window.__copyCapture);
  harness.assert.match(questionOnlyCopy, /题目：/, "复制题目应包含题干");
  harness.assert.match(questionOnlyCopy, /我的选择：/, "做错题的复制应附我的选择");
  harness.assert.doesNotMatch(questionOnlyCopy, /正确答案|答案内容/, "不含答案版不得泄漏答案");
  await page.locator(".question-meta .copy-question.copied").first().waitFor({ state: "visible" });
  await page.evaluate(() => { window.__copyCapture = undefined; });
  await helpers.clickButton(page, "复制题目和答案");
  const withAnswerCopy = await page.evaluate(() => window.__copyCapture);
  harness.assert.match(withAnswerCopy, /正确答案：[A-D]+\b/, "含答案版应包含正确答案字母（不带选项文本，用户口径）");
  harness.assert.doesNotMatch(withAnswerCopy, /正确答案：[A-D]+\./, "正确答案不得附带选项文本");
  harness.assert.doesNotMatch(withAnswerCopy, /答案内容/, "含答案版不再输出独立的答案内容行");
  harness.assert.match(withAnswerCopy, /我的选择：/, "含答案版做错时同样附我的选择");
  await helpers.capture(page, contextName, "practice-copy-buttons");
  await helpers.clickTextButton(page, "下一题");
  await helpers.waitForQuestion(page, 3);
  await helpers.answerCurrentQuestion(page, [0, 1], true);
  await helpers.clickTextButton(page, "下一题");
  await helpers.waitForQuestion(page, 4);
  await helpers.answerCurrentQuestion(page, [0]);
  await helpers.clickTextButton(page, "下一题");
  await helpers.waitForQuestion(page, 5);
  await helpers.expectText(page, "回答正确");
  await helpers.clickTextButton(page, "查看本次结果");
  await helpers.expectText(page, "本次正确率");
  await helpers.capture(page, contextName, "practice-result");
  await page.locator('button[aria-label^="查看第"]').first().click();
  await page.getByRole("dialog", { name: "题目详情" }).waitFor({ state: "visible" });
  // 第 1 题答对：详情页复制 = 练习页含答案版（题目+选项+正确答案），无「我的选择」。
  await page.evaluate(() => { window.__copyCapture = undefined; });
  await helpers.clickButton(page, "复制题目和答案");
  const correctQuestionCopy = await page.evaluate(() => window.__copyCapture);
  harness.assert.match(correctQuestionCopy, /题目：/, "详情页复制应包含题干");
  harness.assert.match(correctQuestionCopy, /正确答案：[A-D]+\b/, "详情页复制必须带正确答案字母（与练习页作答后一致）");
  harness.assert.doesNotMatch(correctQuestionCopy, /我的选择|答案内容/, "答对题的详情复制不得附我的选择，且无答案内容行");
  harness.assert.equal(await page.locator(".search-detail-body > ol > li.wrong").count(), 0, "答对题的详情选项不得有 wrong 标记");
  await helpers.capture(page, contextName, "practice-result-detail");
  await helpers.clickButton(page, "关闭题目详情");
  // 第 2 题做错：详情页复制附「我的选择」（错误选项）+ 正确答案。
  await page.locator('button[aria-label="查看第 2 题详情"]').click();
  await page.getByRole("dialog", { name: "题目详情" }).waitFor({ state: "visible" });
  await page.evaluate(() => { window.__copyCapture = undefined; });
  await helpers.clickButton(page, "复制题目和答案");
  const wrongQuestionCopy = await page.evaluate(() => window.__copyCapture);
  // 详情页按原始字母输出（canonical 顺序），选项打乱时具体字母不定，断言到字母级；
  // 我的选择只带字母（用户口径：不带选项内容）。
  harness.assert.match(wrongQuestionCopy, /我的选择：[A-D]+\b/, "做错题的详情复制应附我选择的字母");
  harness.assert.doesNotMatch(wrongQuestionCopy, /我的选择：[A-D]\. /, "我的选择不得附带选项文本");
  harness.assert.match(wrongQuestionCopy, /正确答案：[A-D]+\b/, "做错题的详情复制同样带正确答案字母");
  harness.assert.doesNotMatch(wrongQuestionCopy, /答案内容/, "详情页复制不输出独立的答案内容行");
  // 做错选项标记与做题界面一致：所选错误项红标 + X 图标。
  const wrongOption = page.locator(".search-detail-body > ol > li.wrong").first();
  await wrongOption.waitFor({ state: "visible" });
  harness.assert.ok(await wrongOption.locator("svg").last().isVisible(), "做错选项应带 X 图标");
  // 选项文字保持正文墨色（与做题界面一致），只有边框/底色/字母块/图标变色。
  const optionTextColor = await page.evaluate(() => {
    const wrong = document.querySelector(".search-detail-body > ol > li.wrong");
    const answer = document.querySelector(".search-detail-body > ol > li.answer");
    const ink = getComputedStyle(document.body).color;
    return { wrong: wrong ? getComputedStyle(wrong).color : null, answer: answer ? getComputedStyle(answer).color : null, ink };
  });
  harness.assert.equal(optionTextColor.wrong, optionTextColor.ink, "做错选项文字必须保持正文墨色（不染红）");
  harness.assert.equal(optionTextColor.answer, optionTextColor.ink, "正确选项文字必须保持正文墨色（不染绿）");
  await helpers.clickButton(page, "关闭题目详情");

  await helpers.clickTextButton(page, "返回练习记录");
  await page.locator(".practice-hub-tabs button").first().click();
  await page.locator(".practice-setup-card").waitFor({ state: "visible" });
  harness.assert.equal(await page.locator(".latest-practice-banner").count(), 0, "completed runs must not leave a latest-practice banner");
  await helpers.clickButton(page, "同步");
  await helpers.expectText(page, "GitHub 同步");
  await helpers.expectText(page, "清除本机所有数据");
  await helpers.expectText(page, "同步时间起点");
  const historyStartInput = page.locator('.history-sync-range-card input[type="date"]');
  await historyStartInput.fill("2025-01-01");
  harness.assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("github-settings") ?? "{}").historySyncStart), "2025-01-01", "sync history start must persist on the current device");
  await helpers.clickTextButton(page, "同步全部历史");
  harness.assert.equal(await historyStartInput.inputValue(), "", "all-history action clears the device lower bound");
  harness.assert.ok(await page.getByRole("button", { name: "清除数据" }).isVisible(), "desktop sync view must expose the site-data reset button");
  const settingsCard = page.locator(".settings-card").first();
  const fields = settingsCard.locator("input");
  await fields.nth(0).fill("visible-qa-owner");
  await fields.nth(1).fill("visible-qa-repo");
  await fields.nth(2).fill("main");
  await fields.nth(3).fill("qa-token");
  // The branch field must stay cleared while editing — Backspace used to snap
  // the value straight back to "main". The default is applied at sync time via
  // branch(), never while typing.
  const branchField = fields.nth(2);
  // Refocusing an input drops the caret to the start; move it to the end so
  // Backspace actually deletes characters (the field is not being cleared).
  await branchField.focus();
  await page.keyboard.press("End");
  for (let index = 0; index < "main".length; index += 1) await page.keyboard.press("Backspace");
  await page.waitForFunction(() => {
    const input = document.querySelector('.sync-connection-card input[placeholder="main"]');
    return input instanceof HTMLInputElement && input.value === "";
  });
  harness.assert.equal(await branchField.inputValue(), "", "branch field must stay cleared after deleting its text");
  await branchField.fill("main");
  // 401 失败与自动同步触发都走真实本地 HTTP：把 unauthorized mock 的地址填进
  // 「同步中转地址」字段，而不是 page.route 拦截 —— 计数来自 mock 的请求统计。
  const failingServer = await harness.startMockGitHubServer({ faults: { unauthorized: true } });
  await fields.nth(4).fill(failingServer.url);
  await helpers.capture(page, contextName, "sync-settings");
  await helpers.clickTextButton(page, "立即同步");
  await helpers.expectSyncFailureNotice(page);
  await helpers.capture(page, contextName, "sync-error");

  const requestsBeforeAutoSync = failingServer.stats.totalRequests;
  await helpers.clickButton(page, "配置");
  await helpers.expectText(page, "答题配置");
  const autoSyncAfterCredentials = page.getByRole("checkbox", { name: "累计事件后自动同步" });
  await autoSyncAfterCredentials.check({ force: true });
  const autoThreshold = page.getByRole("spinbutton", { name: "自动同步阈值" });
  await autoThreshold.fill("1");
  await autoThreshold.blur();
  await page.waitForFunction(() => {
    const raw = window.localStorage.getItem("study-v7-preferences");
    if (!raw) return false;
    try { return Number(JSON.parse(raw).autoSyncEventThreshold) === 1; } catch { return false; }
  });
  // 自动同步现为两阶段空闲调度（~2.5s 去抖 + requestIdleCallback 最多 2s），
  // 阈值触发到真正发起请求最坏接近 4.5s，等待窗口放宽到 10s 防抖动。
  const requestDeadline = Date.now() + 10_000;
  while (failingServer.stats.totalRequests <= requestsBeforeAutoSync && Date.now() < requestDeadline) await page.waitForTimeout(100);
  harness.assert.ok(failingServer.stats.totalRequests > requestsBeforeAutoSync, "enabling automatic sync should issue a GitHub request when pending events exceed the threshold");
  await helpers.capture(page, contextName, "auto-sync-enabled");
  await failingServer.close();
  // Disable auto-sync before the real-sync scenario so it cannot race the
  // manual "立即同步" click below.
  const autoSyncReset = page.getByRole("checkbox", { name: "累计事件后自动同步" });
  if (await autoSyncReset.isChecked()) await autoSyncReset.uncheck({ force: true });

  // ===== 真实同步：内存 mock GitHub 后端 =====
  // Re-point the connection at the in-process mock and use a fresh vault id so
  // all pending change-sets (imports, edits, answers accumulated above) push for
  // real, then verify the hot-window visualisation and an idempotent re-sync.
  await helpers.clickButton(page, "同步");
  await helpers.expectText(page, "GitHub 同步");
  const realFields = page.locator(".settings-card").first().locator("input");
  await realFields.nth(0).fill("qa");
  await realFields.nth(1).fill("browser-vault");
  await realFields.nth(4).fill(mockServer.url);
  await helpers.capture(page, contextName, "sync-mock-configured");
  await helpers.clickTextButton(page, "立即同步");
  await helpers.expectNotice(page, /v9 同步完成/, "real sync success notice");
  const hotWindow = page.locator(".sync-hot-window");
  await hotWindow.waitFor({ state: "visible" });
  const hotLabels = (await hotWindow.locator("dt").allInnerTexts()).map((text) => text.trim());
  harness.assert.ok(hotLabels.includes("检查点") && hotLabels.includes("当前头") && hotLabels.includes("分段") && hotLabels.includes("热窗口"), "hot window must expose checkpoint, head, segment count and hot bytes");
  harness.assert.ok(hotLabels.includes("检查点体积") && hotLabels.includes("热窗口事件") && hotLabels.includes("上次同步"), "hot window must expose checkpoint size, hot-window events and last sync time");
  const hotValues = (await hotWindow.locator("dd").allInnerTexts()).map((text) => text.trim());
  harness.assert.ok(hotValues.some((text) => /^第 \d+ 代$/.test(text)), "checkpoint generation must be shown after a real sync");
  harness.assert.ok(hotValues.some((text) => /\d+ (B|KB|MB)/.test(text)), "checkpoint volume must be shown after a real sync");
  harness.assert.ok(hotValues.some((text) => /^\d+$/.test(text)), "hot-window event count must be shown after a real sync");
  harness.assert.ok(hotValues.some((text) => /\d{2}\/\d{2} \d{2}:\d{2}/.test(text)), "last sync time must be shown after a real sync");
  await helpers.capture(page, contextName, "sync-hot-window");
  harness.assert.ok(mockServer.contentPaths().includes("sync/v9/head.json"), "mock backend must hold the v8 head after a real sync");
  harness.assert.ok(mockServer.contentPaths().some((path) => path.startsWith("sync/v9/checkpoints/")), "mock backend must hold the initial checkpoint");
  // 统一悬浮提示：检查点体积格以鼠标第一次悬浮的位置为中心弹出，格内移动不跟随，离开即关闭。
  const volumeCell = hotWindow.locator("div").filter({ hasText: "检查点体积" }).locator("dd");
  harness.assert.equal(await volumeCell.getAttribute("title"), null, "checkpoint volume must not carry a native title");
  await volumeCell.hover();
  const hint = page.locator(".hint-popover");
  await hint.waitFor({ state: "visible" });
  // 打开动画是 0.12s 的 scale(.98→1)，若在动画中测量 boundingBox，x/y 会随
  // 缩放偏移 1~3px，导致下面的“不实时跟随”断言偶发失败。等动画结束再测。
  await page.waitForFunction(() => {
    const element = document.querySelector(".hint-popover");
    if (!element) return false;
    return element.getAnimations().every((animation) => animation.playState === "finished");
  });
  harness.assert.match(await hint.first().innerText(), /检查点体积|实际 .* · 解压 .*/, "checkpoint volume hint must explain the volume");
  const hintBox1 = await hint.first().boundingBox();
  await volumeCell.hover({ position: { x: 3, y: 3 } }); // 在格内移动 → 锚定首次悬浮位置，不实时跟随
  await page.waitForTimeout(150);
  const hintBox2 = await hint.first().boundingBox();
  harness.assert.ok(hintBox1 && hintBox2 && Math.abs(hintBox1.x - hintBox2.x) <= 1 && Math.abs(hintBox1.y - hintBox2.y) <= 1, "hint must stay centered on the first hover point (no real-time follow)");
  await page.mouse.move(30, 300); // 离开触发元素 → 关闭
  await hint.waitFor({ state: "hidden" });
  // Idempotent: a second sync with no new events pushes nothing but still succeeds.
  await helpers.clickTextButton(page, "立即同步");
  await helpers.expectNotice(page, /v9 同步完成/, "idempotent second sync");
}
