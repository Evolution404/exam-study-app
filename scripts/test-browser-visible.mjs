import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import * as XLSX from "xlsx";
import { startMockGitHubServer } from "./mock-github-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeExecutable = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const configuredBaseUrl = process.env.BASE_URL?.trim();
const baseUrl = (configuredBaseUrl || "http://127.0.0.1:5173").replace(/\/$/, "");
const artifactRoot = path.join(root, "artifacts", "browser-qa");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactRoot, runId);
const screenshots = [];

if (!existsSync(chromeExecutable)) {
  throw new Error(`Chrome executable not found at ${chromeExecutable}. Set CHROME_PATH to a visible Chrome binary.`);
}

const fixture = [
  { q: "导线的主要作用是什么？", a: ["传输电能", "装饰线路", "储存电能", "测量温度"], ans: "A" },
  { q: "哪些做法有助于安全巡视？", a: ["按规程佩戴防护用品", "核对线路和杆塔编号", "跨越警戒区域", "跳过危险点记录"], ans: ["A", "B"] },
  { q: "巡视前应确认天气和现场风险。", a: ["正确", "错误"], ans: "A" },
  { q: "发现异常后，最合适的第一步是什么？", a: ["立即离开并隐瞒", "按流程记录并报告", "自行拆除设备", "等待下次巡视"], ans: "B" },
  { q: "图片所示数值允许 1% 误差时，计算结果是多少？", type: "计算", a: [], ans: "10" },
];
const fixtureFile = {
  name: "送电线路工-初级工.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(fixture), "utf8"),
};
const excelFixtureFile = {
  name: "送电线路工-中级工.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  buffer: XLSX.write((() => {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([
      ["题干", "题型", "答案", "标签", "A", "B", "C"],
      ["Excel 导入后的第一道题是什么？", "单选", "A", "Excel", "通过校验", "跳过校验", "无法判断"],
      ["Excel 导入支持多选吗？", "多选", "AB", "Excel", "支持", "可以", "不支持"],
      ["Excel 计算题的标准答案是多少？", "计算", "10", "Excel，计算"],
    ]);
    XLSX.utils.book_append_sheet(workbook, worksheet, "题库");
    return workbook;
  })(), { type: "buffer", bookType: "xlsx" }),
};

let devServer;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? `: ${lastError.message}` : ""}`);
}

async function startDevServerIfNeeded() {
  if (configuredBaseUrl) return;
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  devServer = spawn(npm, ["run", "dev", "--", "--host", "127.0.0.1"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none" },
  });
  devServer.stdout?.on("data", (chunk) => process.stdout.write(`[vite] ${chunk}`));
  devServer.stderr?.on("data", (chunk) => process.stderr.write(`[vite] ${chunk}`));
  await waitForServer(`${baseUrl}/`);
}

function visibleLocator(page, locator, description) {
  return (async () => {
    for (let index = 0; index < await locator.count(); index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible()) return candidate;
    }
    throw new Error(`Visible ${description} was not found`);
  })();
}

async function clickButton(page, name, options = {}) {
  const locator = page.getByRole("button", { name, exact: options.exact ?? true });
  const button = await visibleLocator(page, locator, `button ${JSON.stringify(name)}`);
  await button.click();
  return button;
}

async function clickTextButton(page, text) {
  const locator = page.locator("button").filter({ hasText: text });
  const button = await visibleLocator(page, locator, `button containing ${JSON.stringify(text)}`);
  await button.click();
  return button;
}

async function expectText(page, text, timeout = 10_000) {
  const locator = page.getByText(text, { exact: true }).first();
  await locator.waitFor({ state: "visible", timeout });
  return locator;
}

async function waitForQuestion(page, number, total = 5) {
  const progress = page.locator(".practice-progress span");
  await progress.filter({ hasText: new RegExp(`^${number} / ${total} ·`) }).waitFor({ state: "visible" });
}

async function assertOverviewFocus(page, questionNumber, expectedProgress) {
  const progress = page.locator(".overview-score span").filter({ hasText: "进度" }).locator("strong");
  assert.equal(await progress.innerText(), expectedProgress, "overview progress should use one decimal place");
  const target = page.locator('.overview-number-grid button[data-overview-focus="true"]');
  assert.equal(await target.count(), 1, "overview should expose exactly one centered row target");
  assert.match(await target.getAttribute("aria-label"), new RegExp(`^第 ${questionNumber} 题，`));
  const position = await target.evaluate((button) => {
    const groups = button.closest(".overview-groups");
    const buttonBox = button.getBoundingClientRect();
    const groupsBox = groups.getBoundingClientRect();
    const centerDelta = buttonBox.top + buttonBox.height / 2 - (groupsBox.top + groupsBox.height / 2);
    const naturalCenteredScroll = groups.scrollTop + centerDelta;
    return {
      actualScroll: groups.scrollTop,
      expectedScroll: Math.min(Math.max(naturalCenteredScroll, 0), groups.scrollHeight - groups.clientHeight),
      visible: buttonBox.bottom > groupsBox.top && buttonBox.top < groupsBox.bottom,
      paddingBlockStart: groups.style.paddingBlockStart,
      paddingBlockEnd: groups.style.paddingBlockEnd,
    };
  });
  assert.equal(position.visible, true, "overview focus row should be visible");
  assert.ok(Math.abs(position.actualScroll - position.expectedScroll) <= 2, "overview focus row should center only within natural scroll bounds");
  assert.equal(position.paddingBlockStart, "", "overview must not add leading space to force edge rows into the center");
  assert.equal(position.paddingBlockEnd, "", "overview must not add trailing space to force edge rows into the center");
}

async function expectNotice(page, pattern, description = "notice") {
  const notice = page.locator(".toast").filter({ hasText: pattern }).first();
  await notice.waitFor({ state: "visible", timeout: 10_000 });
  assert.match(await notice.innerText(), pattern, `${description} should be visible`);
  return notice;
}

async function expectSyncFailureNotice(page) {
  const notice = await expectNotice(page, /GitHub|同步|失败|401/, "sync failure notice");
  const tone = await notice.evaluate((element) => ({
    errorClass: element.classList.contains("error"),
    color: getComputedStyle(element).color,
    expectedColor: getComputedStyle(document.documentElement).getPropertyValue("--color-danger").trim(),
    background: getComputedStyle(element).backgroundColor,
    expectedBackground: getComputedStyle(document.documentElement).getPropertyValue("--color-danger-soft").trim(),
  }));
  assert.equal(tone.errorClass, true, "sync failure notice must use the error tone");
  const resolveColor = (value) => {
    const probe = document.createElement("span");
    probe.style.color = value;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  };
  assert.equal(tone.color, await page.evaluate(resolveColor, tone.expectedColor), "sync failure notice must use the danger text color");
  assert.equal(tone.background, await page.evaluate(resolveColor, tone.expectedBackground), "sync failure notice must use the danger background");
  return notice;
}

async function capture(page, contextName, label) {
  const viewportOverflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  assert.ok(
    viewportOverflow.content <= viewportOverflow.viewport + 1,
    `${contextName}/${label} has horizontal overflow: ${viewportOverflow.content}px > ${viewportOverflow.viewport}px`,
  );
  const directory = path.join(runRoot, contextName);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${String(screenshots.filter((item) => item.context === contextName).length + 1).padStart(2, "0")}-${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const image = await stat(file);
  assert.ok(image.size > 1_024, `screenshot ${file} is unexpectedly small`);
  const bytes = await readFile(file);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `screenshot ${file} is not a PNG`);
  screenshots.push({ context: contextName, label, path: path.relative(root, file), bytes: image.size });
  return file;
}

async function importFixture(page) {
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(fixtureFile);
  await expectText(page, "题库");
  await page.waitForTimeout(250);
}

async function selectBankOnPracticeSetup(page) {
  const bankButton = page.locator(".scope-bank-list button").filter({ hasText: "送电线路工-初级工" });
  const visibleBankButton = await visibleLocator(page, bankButton, "practice bank selector");
  const pressed = await visibleBankButton.getAttribute("aria-pressed");
  if (pressed !== "true") await visibleBankButton.click();
}

async function answerCurrentQuestion(page, optionIndexes, confirm = false) {
  const options = page.locator(".options > button");
  assert.ok(await options.count() >= Math.max(...optionIndexes) + 1, "expected answer options to be rendered");
  for (const index of optionIndexes) await options.nth(index).click();
  const result = page.locator(".result-box");
  if (confirm && !(await result.isVisible().catch(() => false))) {
    // Multi-select questions expose the submit control only while an answer is
    // pending.  Prefer the stable class over the rendered Chinese label so
    // the check remains resilient to copy/detail text changes.
    const submit = page.locator("button.practice-submit");
    const submitButton = await visibleLocator(page, submit, "practice answer submit button");
    await submitButton.click();
  }
  try {
    await result.waitFor({ state: "visible" });
  } catch (error) {
    const card = page.locator(".question-card");
    const diagnostic = path.join(runRoot, `${Date.now()}-practice-timeout.png`);
    await page.screenshot({ path: diagnostic, fullPage: true });
    console.error(`Practice answer did not submit; screenshot: ${path.relative(root, diagnostic)}`);
    console.error((await card.innerText()).slice(0, 1200));
    throw error;
  }
}

async function pendingEventCount(page) {
  // Pending change-sets (state pending|blocked) are the new sync queue; the v6
  // event log no longer exists.
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("shijuan-study-v6");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("changeSets", "readonly");
      const index = transaction.objectStore("changeSets").index("state");
      const pending = index.count(IDBKeyRange.only("pending"));
      const blocked = index.count(IDBKeyRange.only("blocked"));
      let pendingDone = false;
      let blockedDone = false;
      const finish = () => { if (pendingDone && blockedDone) { database.close(); resolve(pending.result + blocked.result); } };
      pending.onsuccess = () => { pendingDone = true; finish(); };
      blocked.onsuccess = () => { blockedDone = true; finish(); };
      pending.onerror = () => reject(pending.error);
      blocked.onerror = () => reject(blocked.error);
    };
  }));
}

async function attachFixtureImage(page) {
  const bankCard = page.locator("button.bank-management-main").filter({ hasText: "送电线路工-初级工" }).first();
  await bankCard.click();
  await expectText(page, "范围表现（近 90 天）");
  await clickButton(page, "自定义");
  const activityDates = page.locator(".bank-custom-range input[type=date]");
  assert.equal(await activityDates.count(), 2, "bank activity range must expose custom start and end dates");
  await activityDates.nth(0).fill("2026-08-01");
  await activityDates.nth(1).fill("2026-08-11");
  await capture(page, "desktop", "bank-custom-range");
  await clickTextButton(page, "试题管理");
  const question = page.locator(".managed-question-list article").filter({ hasText: "图片所示数值允许 1% 误差时" }).first();
  await question.getByRole("button", { name: "编辑题目" }).click();
  const stemEditor = page.locator(".question-editor .editor-rich-field").first();
  const chooserPromise = page.waitForEvent("filechooser");
  await stemEditor.getByRole("button", { name: /在文本块 .* 中选择图片/ }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(path.join(root, "public/icons/app-icon-192.png"));
  await stemEditor.locator(".content-block-editor-image").waitFor({ state: "visible" });
  await clickButton(page, "保存修改");
  await page.getByRole("dialog", { name: "编辑题目" }).waitFor({ state: "hidden" });
}

async function assertBankManagementActions(page) {
  const primaryActions = page.locator(".bank-primary-actions");
  const buttons = primaryActions.locator(":scope > button");
  const tools = page.locator(".bank-management-tools-actions > button");
  assert.equal(await buttons.count(), 2, "bank management must expose create and unified import as primary actions");
  assert.equal(await tools.count(), 3, "bank management must expose folder, template, and unfiled tools");
  await expectText(page, "新建题库");
  await expectText(page, "导入题库");
  const layout = await primaryActions.evaluate((element) => ({
    display: getComputedStyle(element).display,
    viewportWidth: window.innerWidth,
    buttons: [...element.querySelectorAll(":scope > button")].map((button) => {
      const box = button.getBoundingClientRect();
      return {
        height: box.height,
        scrollWidth: button.scrollWidth,
        width: box.width,
      };
    }),
  }));
  assert.equal(layout.display, layout.viewportWidth <= 520 ? "grid" : "flex", "bank management actions must use the responsive compact layout");
  const heights = layout.buttons.map(({ height }) => height);
  assert.ok(Math.max(...heights) - Math.min(...heights) < 1, "bank management actions must have equal heights");
  assert.ok(heights.every((height) => height >= 42 && height <= 46), "bank management actions must keep the compact 44px height");
  for (const button of layout.buttons) {
    assert.ok(button.scrollWidth <= button.width + 1, "bank management action text must fit its button");
  }
}

async function createBlankBank(page, name) {
  await clickTextButton(page, "新建题库");
  const dialog = page.getByRole("dialog", { name: "新建空白题库" });
  await dialog.waitFor({ state: "visible" });
  await dialog.getByLabel("题库名称").fill(name);
  await dialog.getByLabel("题库说明").fill("通过可见浏览器测试手动创建");
  await dialog.getByRole("button", { name: "创建并添加题目" }).click();
  await dialog.waitFor({ state: "hidden" });
  await expectText(page, name);
  await expectText(page, "新增题目");
  assert.ok(await page.locator(".bank-detail-tabs button.active").filter({ hasText: "试题管理" }).isVisible(), "new bank must open directly in question management");
}

async function assertSearchFilterInteractions(page, contextName) {
  await clickButton(page, "进入搜索主页");
  await expectText(page, "搜索题库");
  const geometry = await page.evaluate(() => {
    const search = document.querySelector(".search-trigger-button")?.getBoundingClientRect();
    const filter = document.querySelector(".search-filter-toggle")?.getBoundingClientRect();
    return { search: search && { width: search.width, height: search.height, y: search.y }, filter: filter && { width: filter.width, height: filter.height, y: filter.y } };
  });
  assert.deepEqual(geometry.search, geometry.filter, "search and filter actions must have identical geometry and alignment");
  await clickTextButton(page, "筛选");
  assert.equal(await page.locator(".search-filter-drawer-footer").count(), 0, "filter drawer must not render a duplicate clear/apply footer");
  const segmentColors = await page.evaluate(() => ({
    scope: getComputedStyle(document.querySelector(".search-scope-modes")).backgroundColor,
    keyword: getComputedStyle(document.querySelector(".search-filter-segments")).backgroundColor,
  }));
  assert.equal(segmentColors.scope, segmentColors.keyword, "scope and keyword segmented controls must share one background style");
  await page.getByRole("radio", { name: "错题" }).click();
  const activeCountText = await page.locator(".search-filter-drawer-header span").innerText();
  assert.match(activeCountText, /已设置 [1-9]\d* 项/, "choosing a filter must immediately update the active count");
  await page.locator(".search-filter-backdrop").click({ position: { x: 20, y: 180 } });
  await page.locator(".search-filter-drawer").waitFor({ state: "hidden" });
  assert.match(await page.locator(".search-filter-toggle").innerText(), /筛选\s*[1-9]\d*/, "immediate filter changes must remain after dismissing the drawer");
  await capture(page, contextName, "search-controls-aligned");
}

async function runDesktop(page, mockServer) {
  const contextName = "desktop";
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await expectText(page, "今日");
  await capture(page, contextName, "home-empty");

  await importFixture(page);
  await expectText(page, "送电线路工-初级工");
  await clickButton(page, "今日");
  const scopedAttemptLabel = page.locator(".stat-card > span:not(.stat-icon)").filter({ hasText: "作答" }).first();
  assert.equal(await scopedAttemptLabel.innerText(), "作答（近 90 天）", "home statistics must show the selected progress scope");
  await capture(page, contextName, "home-imported");

  await assertSearchFilterInteractions(page, contextName);

  await clickButton(page, "题库");
  await expectText(page, "题库管理");
  const excelInput = page.locator('input[type="file"][accept*=".xlsx"]').first();
  await excelInput.setInputFiles(excelFixtureFile);
  await expectNotice(page, /已从 Excel 导入/, "Excel import notice");
  await assertBankManagementActions(page);
  await createBlankBank(page, "手动创建测试题库");
  await capture(page, contextName, "bank-created-empty");
  await clickTextButton(page, "返回题库管理");
  await capture(page, contextName, "excel-imported");
  await attachFixtureImage(page);

  await clickButton(page, "配置");
  await expectText(page, "答题配置");
  await clickTextButton(page, "浅色");
  const autoNext = page.getByRole("checkbox", { name: "答对后自动下一题" });
  if (await autoNext.isChecked()) await autoNext.uncheck({ force: true });
  const shuffle = page.getByRole("checkbox", { name: "随机排列选项" });
  if (await shuffle.isChecked()) await shuffle.uncheck({ force: true });
  const groupSize = page.getByRole("spinbutton", { name: "每组题目数量" });
  await groupSize.fill("2");
  await groupSize.blur();
  await clickTextButton(page, "深色");
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
  assert.equal(darkInputStyles.groupInput, "rgba(0, 0, 0, 0)", "dark group-size input must use its field shell background");
  assert.equal(darkInputStyles.goalInput, "rgba(0, 0, 0, 0)", "dark daily-goal input must use its field shell background");
  assert.equal(darkInputStyles.groupShell, darkInputStyles.goalShell, "dark numeric field shells must use one consistent surface");
  const themeCheckOffset = await page.locator('.theme-setting button.active > svg').evaluate((icon) => {
    const iconBox = icon.getBoundingClientRect();
    const buttonBox = icon.parentElement.getBoundingClientRect();
    return Math.abs((iconBox.top + iconBox.height / 2) - (buttonBox.top + buttonBox.height / 2));
  });
  assert.ok(themeCheckOffset < 2, `theme checkmark must be vertically centered, offset was ${themeCheckOffset}px`);
  await page.getByRole("radio", { name: /永久/ }).click();
  await clickButton(page, "今日");
  await expectText(page, "作答（全部时间）");
  await clickButton(page, "配置");
  await expectText(page, "答题配置");
  await expectText(page, "客户端版本");
  await page.evaluate(() => {
    const raw = JSON.parse(window.localStorage.getItem("study-v6-preferences") ?? "{}");
    window.localStorage.setItem("study-v6-preferences", JSON.stringify({ ...raw, questionTransition: "slide" }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await clickButton(page, "配置");
  await expectText(page, "答题配置");

  const shortcutHeading = page.getByRole("heading", { name: "电脑快捷键" });
  await shortcutHeading.scrollIntoViewIfNeeded();
  const addShortcut = page.locator(".shortcut-capture").filter({ hasText: "添加" }).first();
  await addShortcut.click();
  await page.keyboard.press("F9");
  await page.locator(".shortcut-binding-values kbd").filter({ hasText: "F9" }).first().waitFor({ state: "visible" });
  await capture(page, contextName, "shortcut-captured");

  const autoSync = page.getByRole("checkbox", { name: "累计事件后自动同步" });
  if (await autoSync.isChecked()) await autoSync.uncheck({ force: true });
  await capture(page, contextName, "preferences");

  await clickButton(page, "练习");
  await expectText(page, "练习中心");
  await selectBankOnPracticeSetup(page);
  await clickTextButton(page, "随机指定题数");
  const customRandomCount = page.getByRole("spinbutton", { name: "本次随机题数" });
  await customRandomCount.fill("3");
  assert.equal(await customRandomCount.inputValue(), "3", "custom random count should be editable without changing preferences");
  await capture(page, contextName, "practice-custom-random");
  await clickTextButton(page, "全量顺序练习");
  await capture(page, contextName, "practice-setup");
  await page.locator(".setup-footer > button.primary").click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  const pendingBeforeFirstAnswer = await pendingEventCount(page);
  await answerCurrentQuestion(page, [0]);
  await expectText(page, "回答正确");
  assert.equal(await pendingEventCount(page), pendingBeforeFirstAnswer + 1, "one submitted answer must add exactly one pending sync event");
  const note = page.locator('textarea[placeholder="写下错因、口诀或区分条件…"]');
  await note.fill("先确认线路和风险，再按规程巡视。");
  await expectText(page, "已自动保存");
  await capture(page, contextName, "practice-answer");

  await clickButton(page, "打开题目总览");
  await expectText(page, "题目总览");
  // The overview focuses the CURRENT question (第 1 题, 单选 — the first
  // fixture row), not the next-unanswered one: the grid scrolls it into view.
  await assertOverviewFocus(page, 1, "20.0%");
  await capture(page, contextName, "practice-overview");
  const calculation = page.getByRole("button", { name: "第 5 题，计算" });
  await calculation.scrollIntoViewIfNeeded();
  await calculation.click();
  await waitForQuestion(page, 5);
  await page.locator(".asset-image img").waitFor({ state: "visible" });
  const earlyCalculationAnswer = page.getByRole("spinbutton", { name: "计算题答案" });
  await earlyCalculationAnswer.fill("10.05");
  await clickTextButton(page, "确认答案");
  await expectText(page, "回答正确");
  await clickButton(page, "打开题目总览");
  // After answering the calculation (第 5 题), the overview focuses the current
  // question — the calculation row (auto-advance may not have fired yet).
  await assertOverviewFocus(page, 5, "40.0%");
  await capture(page, contextName, "practice-overview-first-unanswered");
  await page.getByRole("button", { name: "第 2 题，单选" }).click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".practice-layout")).animationName === "question-page-back");
  await waitForQuestion(page, 2);
  // The app keeps the stable type grouping order (single choice, multi
  // choice, judgment), so the fourth fixture row is the second visible item.
  await answerCurrentQuestion(page, [0]);
  await expectText(page, "这次没有答对");
  const wrongFeedback = await page.locator(".result-box").innerText();
  assert.match(wrongFeedback, /你的选择：A/);
  assert.doesNotMatch(wrongFeedback, /立即离开并隐瞒|按流程记录并报告/);
  await capture(page, contextName, "practice-wrong-answer");
  await clickTextButton(page, "下一题");
  await waitForQuestion(page, 3);
  await answerCurrentQuestion(page, [0, 1], true);
  await clickTextButton(page, "下一题");
  await waitForQuestion(page, 4);
  await answerCurrentQuestion(page, [0]);
  await clickTextButton(page, "下一题");
  await waitForQuestion(page, 5);
  await expectText(page, "回答正确");
  await clickTextButton(page, "查看本次结果");
  await expectText(page, "本次正确率");
  await capture(page, contextName, "practice-result");
  await page.locator('button[aria-label^="查看第"]').first().click();
  await page.getByRole("dialog", { name: "练习结果题目详情" }).waitFor({ state: "visible" });
  await capture(page, contextName, "practice-result-detail");
  await clickButton(page, "关闭题目详情");

  await clickTextButton(page, "返回练习记录");
  await page.locator(".practice-hub-tabs button").first().click();
  await page.locator(".practice-setup-card").waitFor({ state: "visible" });
  assert.equal(await page.locator(".latest-practice-banner").count(), 0, "completed runs must not leave a latest-practice banner");
  await clickButton(page, "同步");
  await expectText(page, "GitHub 同步");
  await expectText(page, "清除本机所有数据");
  assert.ok(await page.getByRole("button", { name: "清除数据" }).isVisible(), "desktop sync view must expose the site-data reset button");
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
  assert.equal(await branchField.inputValue(), "", "branch field must stay cleared after deleting its text");
  await branchField.fill("main");
  let githubRequestCount = 0;
  await page.route("https://api.github.com/**", (route) => {
    githubRequestCount += 1;
    return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "visible QA stub" }) });
  });
  await capture(page, contextName, "sync-settings");
  await clickTextButton(page, "立即同步");
  await expectSyncFailureNotice(page);
  await capture(page, contextName, "sync-error");

  githubRequestCount = 0;
  await clickButton(page, "配置");
  await expectText(page, "答题配置");
  const autoSyncAfterCredentials = page.getByRole("checkbox", { name: "累计事件后自动同步" });
  await autoSyncAfterCredentials.check({ force: true });
  const autoThreshold = page.getByRole("spinbutton", { name: "自动同步阈值" });
  await autoThreshold.fill("1");
  await autoThreshold.blur();
  await page.waitForFunction(() => {
    const raw = window.localStorage.getItem("study-v6-preferences");
    if (!raw) return false;
    try { return Number(JSON.parse(raw).autoSyncEventThreshold) === 1; } catch { return false; }
  });
  const requestDeadline = Date.now() + 5_000;
  while (!githubRequestCount && Date.now() < requestDeadline) await page.waitForTimeout(100);
  assert.ok(githubRequestCount > 0, "enabling automatic sync should issue a GitHub request when pending events exceed the threshold");
  await capture(page, contextName, "auto-sync-enabled");
  // Disable auto-sync before the real-sync scenario so it cannot race the
  // manual "立即同步" click below.
  const autoSyncReset = page.getByRole("checkbox", { name: "累计事件后自动同步" });
  if (await autoSyncReset.isChecked()) await autoSyncReset.uncheck({ force: true });

  // ===== 真实同步：内存 mock GitHub 后端 =====
  // Re-point the connection at the in-process mock and use a fresh vault id so
  // all pending change-sets (imports, edits, answers accumulated above) push for
  // real, then verify the hot-window visualisation and an idempotent re-sync.
  await clickButton(page, "同步");
  await expectText(page, "GitHub 同步");
  const realFields = page.locator(".settings-card").first().locator("input");
  await realFields.nth(0).fill("qa");
  await realFields.nth(1).fill("browser-vault");
  await realFields.nth(4).fill(mockServer.url);
  await capture(page, contextName, "sync-mock-configured");
  await clickTextButton(page, "立即同步");
  await expectNotice(page, /v7 同步完成/, "real sync success notice");
  const hotWindow = page.locator(".sync-hot-window");
  await hotWindow.waitFor({ state: "visible" });
  const hotLabels = (await hotWindow.locator("dt").allInnerTexts()).map((text) => text.trim());
  assert.ok(hotLabels.includes("检查点") && hotLabels.includes("分段") && hotLabels.includes("热窗口"), "hot window must expose checkpoint, segment count and hot bytes");
  const hotValues = (await hotWindow.locator("dd").allInnerTexts()).map((text) => text.trim());
  assert.ok(hotValues.some((text) => /^第 \d+ 代$/.test(text)), "checkpoint generation must be shown after a real sync");
  await capture(page, contextName, "sync-hot-window");
  assert.ok(mockServer.contentPaths().includes("sync/v7/head.json"), "mock backend must hold the v7 head after a real sync");
  assert.ok(mockServer.contentPaths().some((path) => path.startsWith("sync/v7/checkpoints/")), "mock backend must hold the initial checkpoint");
  // Idempotent: a second sync with no new events pushes nothing but still succeeds.
  await clickTextButton(page, "立即同步");
  await expectNotice(page, /v7 同步完成/, "idempotent second sync");
}

async function runMobile(page, mockServer) {
  const contextName = "mobile";
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await importFixture(page);
  await clickButton(page, "打开导航");
  await expectText(page, "题库");
  await capture(page, contextName, "mobile-menu");
  await clickButton(page, "题库");
  await expectText(page, "题库管理");
  await assertBankManagementActions(page);
  const beforeTemplateDownload = page.url();
  const download = page.waitForEvent("download", { timeout: 3_000 }).catch(() => undefined);
  await clickTextButton(page, "Excel 模板");
  assert.ok(await download, "mobile template action should fall back to a browser download when Web Share is unavailable or denied");
  assert.equal(page.url(), beforeTemplateDownload, "mobile template download must keep the app on its current page");
  assert.equal(await page.locator(".toast").filter({ hasText: /permission denied/i }).count(), 0, "mobile template download must not surface a raw Web Share permission error");
  await createBlankBank(page, "手机手动创建题库");
  await capture(page, contextName, "mobile-bank-created-empty");
  await clickTextButton(page, "返回题库管理");
  await capture(page, contextName, "banks");
  await clickButton(page, "打开导航");
  await clickButton(page, "练习");
  await expectText(page, "练习中心");
  await selectBankOnPracticeSetup(page);
  await clickTextButton(page, "全量顺序练习");
  await page.locator(".setup-footer > button.primary").click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await clickButton(page, "打开题目总览");
  // Fresh practice starts at the first question — the overview focuses the
  // current row (第 1 题) with 0/5 answered.
  await assertOverviewFocus(page, 1, "0.0%");
  await capture(page, contextName, "practice-overview");
  await clickButton(page, "关闭题目总览");
  await capture(page, contextName, "practice");
  await clickButton(page, "暂停并返回首页");
  await expectText(page, "继续上次练习");
  const resumeTone = await page.locator(".resume-copy strong").evaluate((element) => ({
    color: getComputedStyle(element).color,
    expected: getComputedStyle(document.documentElement).getPropertyValue("--ink").trim(),
  }));
  assert.equal(resumeTone.color, await page.evaluate((value) => {
    const probe = document.createElement("span");
    probe.style.color = value;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, resumeTone.expected), "resume card title must use the primary text color");
  assert.ok(await page.locator(".resume-progress > i").isVisible(), "resume card must show a progress bar");
  await capture(page, contextName, "home-resume");
  await clickButton(page, "打开导航");
  await clickButton(page, "配置");
  await expectText(page, "答题配置");
  const syncHeading = page.getByRole("heading", { name: "GitHub 同步" });
  await syncHeading.scrollIntoViewIfNeeded();
  const clearDataHeading = page.getByRole("heading", { name: "清除本机所有数据" });
  await clearDataHeading.scrollIntoViewIfNeeded();
  assert.ok(await page.getByRole("button", { name: "清除数据" }).isVisible(), "mobile preferences must expose the site-data reset button");
  await expectText(page, "客户端版本");
  await capture(page, contextName, "preferences-and-sync");
  const settingsCard = page.locator(".mobile-sync-settings .settings-card").first();
  const fields = settingsCard.locator("input");
  await fields.nth(0).fill("visible-qa-owner-mobile");
  await fields.nth(1).fill("visible-qa-repo-mobile");
  await fields.nth(2).fill("main");
  await fields.nth(3).fill("qa-token-mobile");
  await capture(page, contextName, "sync-card");
  await page.route("https://api.github.com/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "visible QA mobile stub" }) }));
  await clickTextButton(page, "立即同步");
  await expectSyncFailureNotice(page);
  await capture(page, contextName, "sync-error");

  // ===== 真实同步：第二设备从 mock 拉取第一设备（desktop）的数据 =====
  // Point at the same vault the desktop pushed to; this fresh IndexedDB has no
  // prior head cache, so the sync downloads everything the desktop uploaded and
  // merges it with the mobile's own local edits (bi-directional merge).
  const realFields = page.locator(".mobile-sync-settings .settings-card").first().locator("input");
  await realFields.nth(0).fill("qa");
  await realFields.nth(1).fill("browser-vault");
  await realFields.nth(4).fill(mockServer.url);
  await clickTextButton(page, "立即同步");
  await expectNotice(page, /v7 同步完成/, "second-device real sync success");
  await capture(page, contextName, "sync-mobile-pulled");
  // Cross-device: the desktop-created bank must have propagated to this device.
  await clickButton(page, "打开导航");
  await clickButton(page, "题库");
  await expectText(page, "题库管理");
  const crossDeviceBank = page.locator("button.bank-management-main").filter({ hasText: "手动创建测试题库" }).first();
  await crossDeviceBank.waitFor({ state: "visible" });
  assert.ok(await crossDeviceBank.isVisible(), "desktop-created bank must appear on the second device after syncing");
  await capture(page, contextName, "cross-device-bank-pulled");
}

async function runManagementQA(page, mockServer) {
  const contextName = "management";
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await importFixture(page);
  await expectText(page, "送电线路工-初级工");

  // ===== 题库管理：文件夹 / 编辑 / 新增 / 批量 / 删除 =====
  // 新建文件夹（FolderDialog 无 role="dialog"，用 .simple-dialog 定位）
  await clickTextButton(page, "新建文件夹");
  const folderDialog = page.locator(".simple-dialog").filter({ hasText: "文件夹名称" });
  await folderDialog.waitFor({ state: "visible" });
  await folderDialog.getByLabel("文件夹名称").fill("线路工题库");
  await folderDialog.getByLabel("说明").fill("归类送电线路工相关题库");
  await folderDialog.getByRole("button", { name: "保存文件夹" }).click();
  await expectNotice(page, /文件夹“线路工题库”已保存/, "folder save notice");
  await capture(page, contextName, "folder-created");

  // 编辑题库：改名 + 移入文件夹
  await page.locator("button.bank-management-main").filter({ hasText: "送电线路工-初级工" }).first().click();
  await expectText(page, "范围表现（近 90 天）");
  await clickTextButton(page, "编辑题库");
  const editDialog = page.locator(".simple-dialog").filter({ hasText: "展示名称" });
  await editDialog.waitFor({ state: "visible" });
  await editDialog.getByLabel("展示名称").fill("送电线路工-基础");
  await editDialog.getByLabel("所属文件夹").click();
  await page.getByRole("option", { name: "线路工题库" }).click();
  await editDialog.getByRole("button", { name: "保存题库" }).click();
  await expectNotice(page, /已保存/, "bank edit notice");
  await clickTextButton(page, "返回题库管理");
  await expectText(page, "题库管理");
  await expectText(page, "送电线路工-基础");
  await expectText(page, "线路工题库");
  await capture(page, contextName, "bank-edited");

  // 新增题目（单选，答案默认 A）
  await page.locator("button.bank-management-main").filter({ hasText: "送电线路工-基础" }).first().click();
  await expectText(page, "范围表现（近 90 天）");
  await clickTextButton(page, "试题管理");
  await clickTextButton(page, "新增题目");
  const addDialog = page.getByRole("dialog", { name: "新增题目" });
  await addDialog.waitFor({ state: "visible" });
  await addDialog.locator(".editor-rich-field textarea").first().fill("导线弧垂与安全距离的关系是什么？");
  await addDialog.getByLabel("个人解析").fill("弧垂增大时安全距离应随之调整。");
  await addDialog.locator('input[placeholder="例如：弧垂，易混，必背"]').fill("易混,巡视");
  await addDialog.getByRole("button", { name: "添加题目" }).click();
  await expectNotice(page, /新题目已添加/, "question add notice");
  const addedStem = page.locator(".managed-question-list article").filter({ hasText: "导线弧垂与安全距离的关系" }).first();
  await addedStem.waitFor({ state: "visible" });
  await capture(page, contextName, "question-added");

  // 编辑题目：改题干
  await addedStem.getByRole("button", { name: "编辑题目" }).click();
  const editQuestionDialog = page.getByRole("dialog", { name: "编辑题目" });
  await editQuestionDialog.waitFor({ state: "visible" });
  await editQuestionDialog.locator(".editor-rich-field textarea").first().fill("弧垂增大时安全距离如何变化？");
  await clickTextButton(page, "保存修改");
  await page.getByRole("dialog", { name: "编辑题目" }).waitFor({ state: "hidden" });
  await expectNotice(page, /题目已保存/, "question edit notice");
  await page.locator(".managed-question-list article").filter({ hasText: "弧垂增大时安全距离如何变化" }).first().waitFor({ state: "visible" });
  await capture(page, contextName, "question-edited");

  // 批量操作：勾选 2 道 → 从题库移除
  const checkboxes = page.locator(".managed-question-check input");
  assert.ok(await checkboxes.count() >= 2, "expected at least two managed questions");
  await checkboxes.nth(0).check({ force: true });
  await checkboxes.nth(1).check({ force: true });
  await expectText(page, "已选 2 道");
  await clickTextButton(page, "从题库移除");
  await page.getByRole("alertdialog", { name: /从题库移除 \d+ 道题/ }).waitFor({ state: "visible" });
  await clickTextButton(page, "批量移除");
  await expectNotice(page, /移除 \d+ 道题/, "bulk remove notice");
  await capture(page, contextName, "bulk-removed");

  // 未归档题目：批量移除的 fixture 前两道应出现在这里
  await clickTextButton(page, "返回题库管理");
  await clickTextButton(page, "未归档题目");
  await expectText(page, "未归档题目");
  const unfiled = page.locator(".managed-question-list article").filter({ hasText: "导线的主要作用是什么" }).first();
  await unfiled.waitFor({ state: "visible" });
  await capture(page, contextName, "unfiled-questions");
  await clickTextButton(page, "隐藏未归档");

  // ===== 标签管理（知识整理 · 标签 tab） =====
  await clickButton(page, "知识整理");
  await expectText(page, "标签");
  const tagCard = page.locator(".tag-card-grid article").filter({ hasText: "易混" }).first();
  await tagCard.waitFor({ state: "visible" });
  await tagCard.getByRole("button", { name: "练习" }).click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await clickButton(page, "暂停并返回首页");
  await expectText(page, "继续上次练习");
  await capture(page, contextName, "tag-practice");

  // ===== 题组管理（知识整理 · 题组 tab，需在删除题库前：搜索依赖题库内题目） =====
  await clickButton(page, "知识整理");
  await expectText(page, "标签");
  await clickTextButton(page, "题组");

  // 新建题组：名称 / 说明 / 搜索添加题目 / 组内提示
  await page.getByLabel("题组名称").fill("弧垂易混题组");
  await page.getByLabel("题组说明").fill("弧垂与安全距离的对应关系容易混淆");
  const groupSearch = page.locator(".group-search input");
  await groupSearch.fill("巡视");
  await page.waitForTimeout(600);
  const firstResult = page.locator(".group-search-results button").first();
  await firstResult.waitFor({ state: "visible" });
  await firstResult.click();
  await page.locator(".group-items input").first().fill("区分：弧垂增大时安全距离减小");
  await clickTextButton(page, "保存题组");
  await expectNotice(page, /题组“弧垂易混题组”已保存，共 1 道题/, "group save notice");
  let groupCard = page.locator(".group-list article").filter({ hasText: "弧垂易混题组" }).first();
  await groupCard.waitFor({ state: "visible" });
  await capture(page, contextName, "group-created");

  // 编辑题组：改名 + 删除单题
  await groupCard.getByRole("button", { name: "编辑" }).click();
  await page.getByLabel("题组名称").fill("弧垂易混题组-改");
  await clickTextButton(page, "保存题组");
  await expectNotice(page, /题组“弧垂易混题组-改”已保存/, "group rename notice");
  groupCard = page.locator(".group-list article").filter({ hasText: "弧垂易混题组-改" }).first();
  await groupCard.waitFor({ state: "visible" });
  await capture(page, contextName, "group-renamed");

  // 练习题组 → 答题并输入解析（note）→ 自动保存 → 暂停返回
  await groupCard.getByRole("button", { name: "练习题组" }).click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await page.locator(".practice-progress span").filter({ hasText: "题组 · 弧垂易混题组-改" }).waitFor({ state: "visible" });
  await answerCurrentQuestion(page, [0]);
  await expectText(page, "回答正确");
  const noteField = page.locator('textarea[placeholder="写下错因、口诀或区分条件…"]');
  await noteField.fill("弧垂与安全距离成反比，做题时先判断弧垂方向。");
  await expectText(page, "已自动保存");
  await capture(page, contextName, "note-saved");
  await clickButton(page, "暂停并返回首页");
  await expectText(page, "继续上次练习");
  await clickButton(page, "知识整理");
  await clickTextButton(page, "题组");

  // 删除题组
  groupCard = page.locator(".group-list article").filter({ hasText: "弧垂易混题组-改" }).first();
  await groupCard.getByRole("button", { name: "删除" }).click();
  await page.getByRole("alertdialog", { name: "删除这个题组？" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "删除题组" }).click();
  await expectNotice(page, /题组.*已删除/, "group delete notice");
  await capture(page, contextName, "group-deleted");

  // 删除题库（保留题目）——题组与解析都依赖题库内题目，故放在最后
  await clickButton(page, "题库");
  await expectText(page, "题库管理");
  await page.locator("button.bank-management-main").filter({ hasText: "送电线路工-基础" }).first().click();
  await expectText(page, "范围表现（近 90 天）");
  await clickTextButton(page, "删除题库");
  await page.getByRole("dialog", { name: "删除题库时如何处理题目？" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: /只删除题库，保留题目/ }).click();
  await expectNotice(page, /已删除，题目已保留/, "bank delete keep questions");
  await expectText(page, "题库管理");
  await capture(page, contextName, "bank-deleted");

  // ===== 事件管理（同步页） =====
  await clickButton(page, "同步");
  await expectText(page, "GitHub 同步");

  // 刷新按钮
  await clickTextButton(page, "刷新");
  await page.locator(".sync-event-manager").waitFor({ state: "visible" });
  await expectText(page, "等待同步");

  // 展开事件详情
  const eventList = page.locator(".sync-event-list");
  await eventList.waitFor({ state: "visible" });
  const firstEventSummary = page.locator(".sync-event-summary").first();
  await firstEventSummary.waitFor({ state: "visible" });
  await firstEventSummary.click();
  await page.locator(".sync-event-detail").first().waitFor({ state: "visible" });
  await page.locator(".sync-event-mutations").first().waitFor({ state: "visible" });
  await capture(page, contextName, "event-detail");

  // 编辑事件：展开的事件若可编辑则编辑业务字段
  const editFieldButton = page.locator(".sync-event-detail").first().getByRole("button", { name: "编辑业务字段" });
  if (await editFieldButton.count() > 0) {
    await editFieldButton.click();
    const editor = page.locator(".sync-event-editor");
    await editor.waitFor({ state: "visible" });
    await editor.getByRole("button", { name: "保存修改" }).click();
    await editor.waitFor({ state: "hidden" });
    await capture(page, contextName, "event-edited");
  }

  // 删除一个 pending 事件（确认对话框）
  const deleteButton = page.locator(".sync-event-row-actions button[aria-label^='删除整组']").first();
  if (await deleteButton.count() > 0) {
    await deleteButton.click();
    const deleteDialog = page.getByRole("alertdialog", { name: "删除整个 change-set？" });
    await deleteDialog.waitFor({ state: "visible" });
    await deleteDialog.getByRole("button", { name: "删除整组" }).click();
    await deleteDialog.waitFor({ state: "hidden" });
    await capture(page, contextName, "event-deleted");
  }

  // 批量抽屉（已同步/待同步分组）
  const batchSections = page.locator(".sync-event-batch");
  assert.ok(await batchSections.count() >= 1, "event manager must render batch sections");
  await capture(page, contextName, "event-batches");

  // 真实同步（mock 后端）：清空全部待同步事件
  const mgmtFields = page.locator(".settings-card").first().locator("input");
  await mgmtFields.nth(0).fill("qa");
  await mgmtFields.nth(1).fill("mgmt-vault");
  await mgmtFields.nth(3).fill("tok");
  await mgmtFields.nth(4).fill(mockServer.url);
  await clickTextButton(page, "立即同步");
  await page.locator(".simple-dialog").filter({ hasText: "正在同步云端数据" }).waitFor({ state: "hidden", timeout: 20_000 }).catch(() => {});
  const syncToast = await page.locator(".toast").first().innerText().catch(() => "");
  assert.match(syncToast, /v7 同步完成/, "management events should sync successfully");
  await capture(page, contextName, "events-synced");
}

async function main() {
  await mkdir(runRoot, { recursive: true });
  await startDevServerIfNeeded();
  // In-process mock GitHub backend: both browser contexts share it, so the
  // desktop sync pushes real data and the mobile sync pulls it back — a true
  // cross-device round-trip without any external network.
  const mockServer = await startMockGitHubServer();
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage"],
  });
  try {
    const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
    const desktop = await desktopContext.newPage();
    desktop.setDefaultTimeout(10_000);
    desktop.setDefaultNavigationTimeout(25_000);
    await runDesktop(desktop, mockServer);
    await desktopContext.close();

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const mobile = await mobileContext.newPage();
    mobile.setDefaultTimeout(10_000);
    mobile.setDefaultNavigationTimeout(25_000);
    await runMobile(mobile, mockServer);
    await mobileContext.close();

    const mgmtContext = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
    const mgmt = await mgmtContext.newPage();
    mgmt.setDefaultTimeout(10_000);
    mgmt.setDefaultNavigationTimeout(25_000);
    await runManagementQA(mgmt, mockServer);
    await mgmtContext.close();
  } finally {
    await mockServer.close();
    await browser.close();
  }
  assert.ok(screenshots.length >= 12, `expected at least 12 QA screenshots, got ${screenshots.length}`);
  await writeFile(path.join(runRoot, "manifest.json"), `${JSON.stringify({ baseUrl, chromeExecutable, screenshots }, null, 2)}\n`);
  console.log(`Visible browser QA passed: ${screenshots.length} screenshots in ${path.relative(root, runRoot)}`);
}

try {
  await main();
} finally {
  if (devServer && !devServer.killed) devServer.kill("SIGTERM");
}
