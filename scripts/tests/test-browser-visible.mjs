import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import * as XLSX from "xlsx";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chromeExecutable = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 默认后台 headless 运行，不弹出 Chrome 窗口打断操作；需要肉眼观看时：
//   BROWSER_HEADLESS=0 node scripts/tests/test-browser-visible.mjs
const headless = process.env.BROWSER_HEADLESS !== "0" && process.env.BROWSER_HEADLESS !== "false";
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
// 吸附几何断言专用：默认 fixture 只有 5 题，桌面视口下滚动量不足以让搜索框
// 真正吸顶（最大滚动 187px < 自然位置 265px）。这批题目让条件搜索结果足够长。
const bigFixtureFile = {
  name: "吸附测试加长题库.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(
    Array.from({ length: 30 }, (_, index) => ({ q: `加长题库第 ${index + 1} 题：设备巡检记录的归档要求是？`, a: ["按月装订成册", "随意存放", "口头交接", "无需归档"], ans: "A" })),
  ), "utf8"),
};
const excelFixtureFile = {
  name: "送电线路工-中级工.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  buffer: XLSX.write((() => {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([
      ["题干", "题型", "答案", "标签", "解析", "A", "B", "C"],
      ["Excel 导入后的第一道题是什么？", "单选", "A", "Excel", "", "通过校验", "跳过校验", "无法判断"],
      ["Excel 导入支持多选吗？", "多选", "AB", "Excel", "", "支持", "可以", "不支持"],
      ["Excel 计算题的标准答案是多少？", "计算", "10", "Excel，计算", ""],
    ]);
    XLSX.utils.book_append_sheet(workbook, worksheet, "题库");
    return workbook;
  })(), { type: "buffer", bookType: "xlsx" }),
};

let devServer;

function frontmostAppName() {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync(
      "osascript",
      ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { encoding: "utf8", timeout: 3000 },
    ).trim();
  } catch {
    return "";
  }
}

// BROWSER_HEADLESS=0 时启动可见 Chrome。为了不把 Chrome 弹到最前打断用户操作，
// 启动/新建页面后把焦点还给启动测试前正在使用的 App，让 Chrome 留在窗口栈下层。
let lastUserApp = "";
function keepBrowserInBackground() {
  if (process.platform !== "darwin") return;
  const front = frontmostAppName();
  if (front && front !== "Google Chrome" && front !== "Chromium") lastUserApp = front;
  if (!lastUserApp || lastUserApp === "Google Chrome" || lastUserApp === "Chromium") return;
  try {
    execFileSync("osascript", ["-e", `tell application ${JSON.stringify(lastUserApp)} to activate`], { timeout: 3000 });
  } catch {
    // 没有自动化权限或 App 名称不可用时不影响测试本身。
  }
}

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

async function setPracticePreferences(page, patch) {
  // 直接写入偏好再刷新，与 desktop 场景在配置页里逐个勾选等价但更快：
  // 默认 shuffleOptions=true 会让选项随机排列（[0] 不再是正确答案），
  // autoNextCorrect=true 会在答对后自动前进并显示“回答正确，即将进入下一题”，
  // 两者都会让确定性作答断言不可靠。
  await page.evaluate((values) => {
    const raw = JSON.parse(window.localStorage.getItem("study-v7-preferences") ?? "{}");
    window.localStorage.setItem("study-v7-preferences", JSON.stringify({ ...raw, ...values }));
  }, patch);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
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
  // Pending change-sets (state pending|blocked) are the new sync queue; the v7
  // event log no longer exists.
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("shijuan-study-v7");
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
  // simple-dialog footer 的按钮规则（color:var(--ink)）特异性高于全局 .primary 的
  // 白字，曾把「创建并添加题目」压成绿底黑字；主按钮必须保持白字。
  const primaryTone = await dialog.locator("footer .primary").evaluate((button) => getComputedStyle(button).color);
  assert.equal(primaryTone, "rgb(255, 255, 255)", "新建题库主按钮文字必须为白色（绿底白字）");
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
    const raw = JSON.parse(window.localStorage.getItem("study-v7-preferences") ?? "{}");
    window.localStorage.setItem("study-v7-preferences", JSON.stringify({ ...raw, questionTransition: "slide" }));
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
  const note = page.locator('textarea[placeholder^="写下错因、口诀或区分条件…"]');
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
  // 复制题目双按钮（做错态）：不含答案版附「我的选择」且绝不泄漏答案；含答案版两行齐全。
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text) => { window.__copyCapture = text; return Promise.resolve(); } } });
  });
  await clickButton(page, "复制题目");
  const questionOnlyCopy = await page.evaluate(() => window.__copyCapture);
  assert.match(questionOnlyCopy, /题目：/, "复制题目应包含题干");
  assert.match(questionOnlyCopy, /我的选择：/, "做错题的复制应附我的选择");
  assert.doesNotMatch(questionOnlyCopy, /正确答案|答案内容/, "不含答案版不得泄漏答案");
  await page.locator(".question-meta .copy-question.copied").first().waitFor({ state: "visible" });
  await page.evaluate(() => { window.__copyCapture = undefined; });
  await clickButton(page, "复制题目和答案");
  const withAnswerCopy = await page.evaluate(() => window.__copyCapture);
  assert.match(withAnswerCopy, /正确答案：[A-D]\. /, "含答案版应包含正确答案的选项（字母+文本单行）");
  assert.doesNotMatch(withAnswerCopy, /答案内容/, "含答案版不再输出独立的答案内容行");
  assert.match(withAnswerCopy, /我的选择：/, "含答案版做错时同样附我的选择");
  await capture(page, contextName, "practice-copy-buttons");
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
  await page.getByRole("dialog", { name: "题目详情" }).waitFor({ state: "visible" });
  // 第 1 题答对：详情页复制只含题目+选项，无「我的选择/答案内容」。
  await page.evaluate(() => { window.__copyCapture = undefined; });
  await clickButton(page, "复制题目");
  const correctQuestionCopy = await page.evaluate(() => window.__copyCapture);
  assert.match(correctQuestionCopy, /题目：/, "详情页复制应包含题干");
  assert.doesNotMatch(correctQuestionCopy, /我的选择|答案内容|正确答案/, "答对题的详情复制不得附我的选择或答案");
  await capture(page, contextName, "practice-result-detail");
  await clickButton(page, "关闭题目详情");
  // 第 2 题做错：详情页复制附「我的选择」（错误选项），仍不含答案。
  await page.locator('button[aria-label="查看第 2 题详情"]').click();
  await page.getByRole("dialog", { name: "题目详情" }).waitFor({ state: "visible" });
  await page.evaluate(() => { window.__copyCapture = undefined; });
  await clickButton(page, "复制题目");
  const wrongQuestionCopy = await page.evaluate(() => window.__copyCapture);
  // 详情页按原始字母输出（canonical 顺序），选项打乱时具体字母不定，断言到字母级。
  assert.match(wrongQuestionCopy, /我的选择：[A-D]\. /, "做错题的详情复制应附我选择的错误选项");
  assert.doesNotMatch(wrongQuestionCopy, /答案内容|正确答案/, "详情页复制永不包含答案");
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
  // 401 失败与自动同步触发都走真实本地 HTTP：把 unauthorized mock 的地址填进
  // 「同步中转地址」字段，而不是 page.route 拦截 —— 计数来自 mock 的请求统计。
  const failingServer = await startMockGitHubServer({ faults: { unauthorized: true } });
  await fields.nth(4).fill(failingServer.url);
  await capture(page, contextName, "sync-settings");
  await clickTextButton(page, "立即同步");
  await expectSyncFailureNotice(page);
  await capture(page, contextName, "sync-error");

  const requestsBeforeAutoSync = failingServer.stats.totalRequests;
  await clickButton(page, "配置");
  await expectText(page, "答题配置");
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
  const requestDeadline = Date.now() + 5_000;
  while (failingServer.stats.totalRequests <= requestsBeforeAutoSync && Date.now() < requestDeadline) await page.waitForTimeout(100);
  assert.ok(failingServer.stats.totalRequests > requestsBeforeAutoSync, "enabling automatic sync should issue a GitHub request when pending events exceed the threshold");
  await capture(page, contextName, "auto-sync-enabled");
  await failingServer.close();
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
  assert.ok(hotLabels.includes("检查点") && hotLabels.includes("当前头") && hotLabels.includes("分段") && hotLabels.includes("热窗口"), "hot window must expose checkpoint, head, segment count and hot bytes");
  assert.ok(hotLabels.includes("检查点体积") && hotLabels.includes("热窗口事件") && hotLabels.includes("上次同步"), "hot window must expose checkpoint size, hot-window events and last sync time");
  const hotValues = (await hotWindow.locator("dd").allInnerTexts()).map((text) => text.trim());
  assert.ok(hotValues.some((text) => /^第 \d+ 代$/.test(text)), "checkpoint generation must be shown after a real sync");
  assert.ok(hotValues.some((text) => /\d+ (B|KB|MB)/.test(text)), "checkpoint volume must be shown after a real sync");
  assert.ok(hotValues.some((text) => /^\d+$/.test(text)), "hot-window event count must be shown after a real sync");
  assert.ok(hotValues.some((text) => /\d{2}\/\d{2} \d{2}:\d{2}/.test(text)), "last sync time must be shown after a real sync");
  await capture(page, contextName, "sync-hot-window");
  assert.ok(mockServer.contentPaths().includes("sync/v7/head.json"), "mock backend must hold the v7 head after a real sync");
  assert.ok(mockServer.contentPaths().some((path) => path.startsWith("sync/v7/checkpoints/")), "mock backend must hold the initial checkpoint");
  // 统一悬浮提示：检查点体积格以鼠标第一次悬浮的位置为中心弹出，格内移动不跟随，离开即关闭。
  const volumeCell = hotWindow.locator("div").filter({ hasText: "检查点体积" }).locator("dd");
  assert.equal(await volumeCell.getAttribute("title"), null, "checkpoint volume must not carry a native title");
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
  assert.match(await hint.first().innerText(), /检查点体积|实际 .* · 解压 .*/, "checkpoint volume hint must explain the volume");
  const hintBox1 = await hint.first().boundingBox();
  await volumeCell.hover({ position: { x: 3, y: 3 } }); // 在格内移动 → 锚定首次悬浮位置，不实时跟随
  await page.waitForTimeout(150);
  const hintBox2 = await hint.first().boundingBox();
  assert.ok(hintBox1 && hintBox2 && Math.abs(hintBox1.x - hintBox2.x) <= 1 && Math.abs(hintBox1.y - hintBox2.y) <= 1, "hint must stay centered on the first hover point (no real-time follow)");
  await page.mouse.move(30, 300); // 离开触发元素 → 关闭
  await hint.waitFor({ state: "hidden" });
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
  // 与桌面组一致：401 场景走真实本地 unauthorized mock（填进中转地址），不拦截。
  const mobileFailingServer = await startMockGitHubServer({ faults: { unauthorized: true } });
  await fields.nth(4).fill(mobileFailingServer.url);
  await clickTextButton(page, "立即同步");
  await expectSyncFailureNotice(page);
  await capture(page, contextName, "sync-error");
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
  assert.ok((await mobileHint.first().innerText()).trim().length > 12, "tap must reveal the full change-set id hint");
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

  // 题目详情：进度指示单独一行 + 上一题/下一题切换（与搜索详情统一）
  await page.locator(".managed-question-list article").first().locator("button").first().click();
  const managedDetail = page.getByRole("dialog", { name: "题目详情" });
  await managedDetail.waitFor({ state: "visible" });
  const detailCount = managedDetail.locator(".search-detail-count");
  await detailCount.waitFor({ state: "visible" });
  const detailCountBefore = (await detailCount.textContent()) ?? "";
  assert.match(detailCountBefore, /^\d+ \/ \d+$/, "题目详情应显示进度指示（当前/总数）");
  await managedDetail.getByRole("button", { name: /下一题/ }).click();
  await page.waitForFunction((before) => {
    const el = document.querySelector(".search-question-detail .search-detail-count");
    return el && el.textContent !== before;
  }, detailCountBefore);
  await managedDetail.getByRole("button", { name: /上一题/ }).click();
  await page.waitForFunction((before) => {
    const el = document.querySelector(".search-question-detail .search-detail-count");
    return el && el.textContent === before;
  }, detailCountBefore);
  await managedDetail.getByRole("button", { name: "关闭题目详情" }).click();
  await capture(page, contextName, "question-detail-nav");

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
  await page.getByRole("button", { name: "保存题组" }).click();
  await expectNotice(page, /题组“弧垂易混题组”已保存，共 1 道题/, "group save notice");
  let groupCard = page.locator(".group-list article").filter({ hasText: "弧垂易混题组" }).first();
  await groupCard.waitFor({ state: "visible" });
  await capture(page, contextName, "group-created");

  // 编辑题组：改名 + 删除单题
  await groupCard.getByRole("button", { name: "编辑" }).click();
  await page.getByLabel("题组名称").fill("弧垂易混题组-改");
  await page.getByRole("button", { name: "保存题组" }).click();
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
  const noteField = page.locator('textarea[placeholder^="写下错因、口诀或区分条件…"]');
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

  // 事件管理器渲染（刷新按钮已移除，为空操作）
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

  // 本次同步抽屉：搜索输入框必须无边框、聚焦只靠边框变色（统一输入框样式，避免内外两个矩形或聚焦光环）
  await page.locator(".sync-queue-trigger").click();
  await page.locator(".sync-event-drawer").waitFor({ state: "visible" });
  // 抽屉工具栏下方展示与同步页一致的热窗口信息面板。
  const drawerHotLabels = (await page.locator(".sync-event-drawer .sync-hot-window dt").allInnerTexts()).map((text) => text.trim());
  assert.ok(
    drawerHotLabels.includes("检查点") && drawerHotLabels.includes("当前头") && drawerHotLabels.includes("分段")
      && drawerHotLabels.includes("检查点体积") && drawerHotLabels.includes("热窗口事件") && drawerHotLabels.includes("上次同步") && drawerHotLabels.includes("热窗口"),
    "drawer hot window panel must show the same fields as the sync page",
  );
  const drawerSearchInput = page.locator(".sync-event-drawer .sync-event-search input").first();
  await drawerSearchInput.focus();
  await page.waitForTimeout(120);
  const drawerInputBorder = await drawerSearchInput.evaluate((input) => ({
    borderWidth: getComputedStyle(input).borderWidth,
    boxShadow: getComputedStyle(input).boxShadow,
    labelBorder: getComputedStyle(input.parentElement).borderRadius,
    labelBoxShadow: getComputedStyle(input.parentElement).boxShadow,
    labelBorderColor: getComputedStyle(input.parentElement).borderColor,
  }));
  assert.equal(drawerInputBorder.borderWidth, "0px", "drawer search input must be borderless (unified single-rectangle input)");
  assert.equal(drawerInputBorder.boxShadow, "none", "drawer search input must not add a focus box-shadow ring");
  assert.equal(drawerInputBorder.labelBorder, "11px", "drawer search input must stay inside the rounded container");
  assert.equal(drawerInputBorder.labelBoxShadow, "none", "drawer search container must not show a focus glow ring");
  assert.notEqual(drawerInputBorder.labelBorderColor, "rgba(0, 0, 0, 0)", "drawer search container must still signal focus via border color");
  await capture(page, contextName, "sync-drawer-search");
  await page.getByRole("button", { name: "关闭同步抽屉" }).click();
  await page.locator(".sync-event-drawer").waitFor({ state: "hidden" });

  // ===== 同步后面板及时更新：同步 → 制造新事件 → 抽屉再同步 → 两处面板立即反映 =====
  const readPanel = (scope) => page.evaluate((selector) => {
    const panel = document.querySelector(selector);
    if (!panel) return null;
    const cell = (label) => [...panel.querySelectorAll("div")].find((row) => row.querySelector("dt")?.textContent?.trim() === label)?.querySelector("dd")?.textContent?.trim();
    return { generation: cell("当前头"), lastSync: cell("上次同步") };
  }, scope);
  const parseGeneration = (value) => Number.parseInt(/^第 (\d+) 代$/.exec(value ?? "")?.[1] ?? "0", 10);
  const before = await readPanel(".sync-connection-card .sync-hot-window");
  assert.ok(before && /^第 \d+ 代$/.test(before.generation ?? ""), `同步页面板应有当前头代数（实际 ${before?.generation}）`);
  // 通过应用层接口制造 1 条 pending（收藏切换走完整 change-set 入队路径）。
  await page.evaluate(async () => {
    const { dbV7, updateQuestionV7 } = await import("/exam-study-app/src/lib/db/db-v7.ts");
    const question = await dbV7.questions.orderBy("id").first();
    if (!question) throw new Error("题库为空，无法制造同步事件");
    await updateQuestionV7(question.id, { favorite: !question.favorite });
  });
  // 抽屉内点「立即同步」（外部同步路径），完成后抽屉面板与同步页面板都必须立即更新。
  await page.locator(".sync-queue-trigger").click();
  await page.locator(".sync-event-drawer").waitFor({ state: "visible" });
  await page.locator(".sync-event-drawer .sync-event-manager-actions button").click();
  await expectNotice(page, /v7 同步完成/, "drawer quick sync notice");
  await page.waitForTimeout(600);
  const drawerPanel = await readPanel(".sync-event-drawer .sync-hot-window");
  assert.ok(drawerPanel, "抽屉面板应在同步后存在");
  assert.ok(parseGeneration(drawerPanel.generation) > parseGeneration(before.generation), `抽屉当前头应前进（${before.generation} → ${drawerPanel.generation}）`);
  assert.match(drawerPanel.lastSync ?? "", /^\d{2}\/\d{2} \d{2}:\d{2}$/, `上次同步应显示本地上次成功同步时间（实际 ${drawerPanel.lastSync}）`);
  await page.getByRole("button", { name: "关闭同步抽屉" }).click();
  await page.locator(".sync-event-drawer").waitFor({ state: "hidden" });
  // 同步页自己并不发起这次同步，但面板 live 订阅本地 head 缓存，必须自动刷新。
  await page.waitForFunction((threshold) => {
    const panel = document.querySelector(".sync-connection-card .sync-hot-window");
    if (!panel) return false;
    const row = [...panel.querySelectorAll("div")].find((candidate) => candidate.querySelector("dt")?.textContent?.trim() === "当前头");
    const value = /^第 (\d+) 代$/.exec(row?.querySelector("dd")?.textContent?.trim() ?? "");
    return value ? Number.parseInt(value[1], 10) > threshold : false;
  }, parseGeneration(before.generation), { timeout: 10_000 }).catch(() => {
    throw new Error("外部快速同步后同步页面板未及时刷新（pending 归零刷新失效）");
  });
  const after = await readPanel(".sync-connection-card .sync-hot-window");
  assert.ok(parseGeneration(after.generation) > parseGeneration(before.generation), `外部快速同步后同步页面板也应及时前进（${before.generation} → ${after.generation}）`);
  await capture(page, contextName, "sync-panel-fresh");
}

async function runReviewRounds(page) {
  const contextName = "review";
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await importFixture(page);
  await expectText(page, "送电线路工-初级工");
  await setPracticePreferences(page, { autoNextCorrect: false, shuffleOptions: false });

  // 复习轮次挂在「配置」的「出题与复习」卡片
  await clickButton(page, "配置");
  await expectText(page, "答题配置");
  const managerHeading = page.getByRole("heading", { name: "命名并追踪复习轮次" });
  await managerHeading.scrollIntoViewIfNeeded();
  await expectText(page, "还没有复习轮次");
  // 复习轮次卡片宽度应与配置页其他卡片一致（不窄于 preference-card）
  const roundWidth = await page.locator(".review-round-manager").evaluate((el) => el.getBoundingClientRect().width);
  const cardWidth = await page.locator(".preference-card").first().evaluate((el) => el.getBoundingClientRect().width);
  assert.ok(Math.abs(roundWidth - cardWidth) <= 1, `复习轮次宽度(${roundWidth}px)应与配置卡片一致(${cardWidth}px)`);
  await capture(page, contextName, "review-round-empty");

  // 新建轮次：命名 + 选择题库
  await clickTextButton(page, "新建轮次");
  const editor = page.locator(".review-round-editor");
  await editor.waitFor({ state: "visible" });
  await expectText(page, "命名复习轮次");
  await editor.locator(".review-round-name-field input").fill("春季第一轮");
  await editor.locator(".review-round-bank-picker label").filter({ hasText: "送电线路工-初级工" }).click();
  await clickTextButton(page, "保存轮次");
  await expectNotice(page, /已创建复习轮次「春季第一轮」/, "review round create notice");
  const roundCard = page.locator(".review-round-card").filter({ hasText: "春季第一轮" }).first();
  await roundCard.waitFor({ state: "visible" });
  const metricsText = await roundCard.locator(".review-round-metrics").innerText();
  assert.match(metricsText, /5/, "created round must show the fixture bank question count");
  assert.match(metricsText, /0/, "created round must start at zero completed");
  await capture(page, contextName, "review-round-created");

  // 编辑轮次：改名 + 调整范围
  await roundCard.getByRole("button", { name: "编辑范围" }).click();
  await editor.waitFor({ state: "visible" });
  await expectText(page, "调整轮次范围");
  await editor.locator(".review-round-name-field input").fill("春季第一轮-改");
  await clickTextButton(page, "保存轮次");
  await expectNotice(page, /复习轮次已更新/, "review round update notice");
  await page.locator(".review-round-card").filter({ hasText: "春季第一轮-改" }).first().waitFor({ state: "visible" });

  // 绑定轮次发起练习（复习轮次选择器自动选中轮次题库）
  await clickButton(page, "练习");
  await expectText(page, "练习中心");
  const roundSelect = page.getByLabel("复习轮次");
  await roundSelect.scrollIntoViewIfNeeded();
  await roundSelect.click();
  await page.getByRole("option", { name: /春季第一轮/ }).click();
  await page.waitForFunction(() => {
    const bank = [...document.querySelectorAll(".scope-bank-list button")].find((button) => button.textContent?.includes("送电线路工-初级工"));
    return bank?.getAttribute("aria-pressed") === "true";
  }, undefined, { timeout: 5_000 });
  await clickTextButton(page, "全量顺序练习");
  await page.locator(".setup-footer > button.primary").click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await answerCurrentQuestion(page, [0]);
  await expectText(page, "回答正确");
  await capture(page, contextName, "review-round-practice");
  await clickButton(page, "暂停并返回首页");
  await expectText(page, "继续上次练习");

  // 提前结束轮次（两次确认）→ 已完成 + 最终快照
  await clickButton(page, "配置");
  await expectText(page, "答题配置");
  await managerHeading.scrollIntoViewIfNeeded();
  const updatedCard = page.locator(".review-round-card").filter({ hasText: "春季第一轮-改" }).first();
  await updatedCard.getByRole("button", { name: "提前结束轮次" }).click();
  await expectText(page, "再次确认结束");
  await updatedCard.getByRole("button", { name: "再次确认结束" }).click();
  await expectNotice(page, /复习轮次已完成并保存最终快照/, "review round complete notice");
  await updatedCard.locator(".review-round-status.completed").waitFor({ state: "visible" });
  assert.match(await updatedCard.locator(".review-round-snapshot").innerText(), /结束时共 5 道题/, "completed round must freeze the final snapshot");
  await capture(page, contextName, "review-round-completed");

  // 归档 → 卡片消失回到空态
  await updatedCard.getByRole("button", { name: "归档" }).click();
  await expectNotice(page, /复习轮次已归档/, "review round archive notice");
  await page.locator(".review-round-card").waitFor({ state: "detached" });
  await expectText(page, "还没有复习轮次");
  await capture(page, contextName, "review-round-archived");
}

async function runSearchBatch(page) {
  const contextName = "search";
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await importFixture(page);
  await expectText(page, "送电线路工-初级工");
  await setPracticePreferences(page, { autoNextCorrect: false, shuffleOptions: false });

  // 关键词搜索 + 题型标签
  await clickButton(page, "进入搜索主页");
  await expectText(page, "搜索题库");
  await page.getByLabel("搜索题库").fill("巡视");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expectText(page, /“巡视”找到 \d+ 道题/);
  await capture(page, contextName, "search-results");
  // 吸附几何：搜索框钉顶、批量栏紧贴、全局顶栏滚走（桌面）。
  // 导入加长题库 + 清空关键词做条件搜索，让列表足够长以保证真正吸顶。
  await page.locator('input[type="file"]').first().setInputFiles(bigFixtureFile);
  await page.waitForTimeout(600);
  // 导入可能把视图带回首页，重新进入搜索页。
  if (await page.locator(".search-page").count() === 0) {
    await clickButton(page, "进入搜索主页");
    await expectText(page, "搜索题库");
  }
  await page.getByLabel("搜索题库").fill("");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expectText(page, /条件搜索找到 \d+ 道题/);
  await assertSearchPinGeometry(page, "desktop", { requireScroll: true });
  // 恢复关键词搜索，后续详情导航依赖“巡视”结果集与排序。
  await page.getByLabel("搜索题库").fill("巡视");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expectText(page, /“巡视”找到 \d+ 道题/);
  await page.locator(".search-type-tabs button").filter({ hasText: "单选" }).click();
  assert.equal(await page.locator(".search-result-list article").count(), 1, "single-choice tab must narrow the results");
  await page.locator(".search-type-tabs button").filter({ hasText: "全部" }).click();

  // 题目详情：下一题 / 上一题 / 收藏 / ESC 关闭
  await page.locator(".search-result-list article").first().locator(".search-result-main").click();
  const detail = page.getByRole("dialog", { name: "题目详情" });
  await detail.waitFor({ state: "visible" });
  await detail.getByText(/发现异常后，最合适的第一步是什么/).waitFor({ state: "visible" });
  await detail.getByRole("button", { name: /下一题/ }).click();
  await detail.getByText(/哪些做法有助于安全巡视/).waitFor({ state: "visible" });
  await detail.getByRole("button", { name: /下一题/ }).click();
  await detail.getByText(/巡视前应确认天气和现场风险/).waitFor({ state: "visible" });
  await detail.getByRole("button", { name: /上一题/ }).click();
  await detail.getByText(/哪些做法有助于安全巡视/).waitFor({ state: "visible" });
  await detail.getByRole("button", { name: /^收藏/ }).click();
  await expectNotice(page, /已收藏这道题/, "detail favorite notice");
  await page.keyboard.press("Escape");
  await detail.waitFor({ state: "hidden" });
  await capture(page, contextName, "search-detail-esc");

  // 批量：收藏所选 + 批量添加标签
  await clickButton(page, "进入搜索主页");
  await expectText(page, "搜索题库");
  // 离开搜索视图会清空 query，重新进入需重新输入关键词
  await page.getByLabel("搜索题库").fill("巡视");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const checkboxes = page.locator(".search-result-list .result-checkbox input");
  assert.ok(await checkboxes.count() >= 2, "expected at least two search results for batch operations");
  await checkboxes.nth(0).check({ force: true });
  await checkboxes.nth(1).check({ force: true });
  await expectText(page, "已选择 2 道");
  await clickTextButton(page, "收藏所选");
  await expectNotice(page, /已收藏 \d+ 道题/, "batch favorite notice");
  await page.locator(".batch-tag input").fill("易混");
  await clickTextButton(page, "添加");
  await expectNotice(page, /已给 2 道题添加标签“易混”/, "batch tag notice");
  await capture(page, contextName, "search-batch-ops");

  // 练习已选 → 起手 2 题
  const practiceDialog = page.getByRole("dialog", { name: "搜索练习配置" });
  await clickTextButton(page, "练习已选");
  await practiceDialog.waitFor({ state: "visible" });
  await expectText(page, /共有 \d+ 道可练题目/);
  await practiceDialog.getByRole("button", { name: /开始练习/ }).click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await waitForQuestion(page, 1, 2);
  await answerCurrentQuestion(page, [1]);
  await clickButton(page, "暂停并返回首页");
  await expectText(page, "继续上次练习");

  // 练习全部结果
  await clickButton(page, "进入搜索主页");
  await expectText(page, "搜索题库");
  // 离开搜索视图会清空 query，重新进入需重新输入关键词
  await page.getByLabel("搜索题库").fill("巡视");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const allCheckboxes = page.locator(".search-result-list .result-checkbox input");
  await allCheckboxes.nth(0).check({ force: true });
  await allCheckboxes.nth(1).check({ force: true });
  await clickTextButton(page, "练习全部结果");
  await practiceDialog.waitFor({ state: "visible" });
  await expectText(page, /共有 \d+ 道可练题目/);
  await practiceDialog.getByRole("button", { name: /开始练习/ }).click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await waitForQuestion(page, 1, 3);
  await capture(page, contextName, "search-practice-all");
  await clickButton(page, "暂停并返回首页");
  await expectText(page, "继续上次练习");

  // 加入题组 → 题组编辑器预填 + 上/下移排序（拖拽排序的替代覆盖）
  await clickButton(page, "进入搜索主页");
  await expectText(page, "搜索题库");
  // 离开搜索视图会清空 query，重新进入需重新输入关键词
  await page.getByLabel("搜索题库").fill("巡视");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const lastCheckboxes = page.locator(".search-result-list .result-checkbox input");
  await lastCheckboxes.nth(0).check({ force: true });
  await lastCheckboxes.nth(1).check({ force: true });
  await clickTextButton(page, "加入题组");
  await expectText(page, "新建题组");
  const groupItems = page.locator(".group-items article");
  assert.equal(await groupItems.count(), 2, "加入题组 must prefill the two selected questions");
  const firstStem = await groupItems.first().innerText();
  const firstHandle = groupItems.first().locator(".group-drag");
  const secondHandle = groupItems.nth(1).locator(".group-drag");
  const firstBox = await firstHandle.boundingBox();
  const secondBox = await secondHandle.boundingBox();
  assert.ok(firstBox && secondBox, "拖动前两个题组项应可见");
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction((previous) => {
    const first = document.querySelector(".group-items article")?.innerText ?? "";
    return first.trim() !== previous;
  }, firstStem);
  await capture(page, contextName, "search-to-group");
}

async function runHistoryResult(page) {
  const contextName = "history";
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await importFixture(page);
  await expectText(page, "送电线路工-初级工");
  await setPracticePreferences(page, { autoNextCorrect: false, shuffleOptions: false });

  // 完成一次 5 题练习（第 2 题答错，其余答对 → 80%）
  await clickButton(page, "练习");
  await expectText(page, "练习中心");
  await selectBankOnPracticeSetup(page);
  await clickTextButton(page, "全量顺序练习");
  await page.locator(".setup-footer > button.primary").click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  // 1 导线（单选 A）→ 对
  await answerCurrentQuestion(page, [0]);
  await expectText(page, "回答正确");
  await clickTextButton(page, "下一题");
  // 2 发现异常（单选 B）→ 答错
  await waitForQuestion(page, 2, 5);
  await answerCurrentQuestion(page, [0]);
  await expectText(page, "这次没有答对");
  await clickTextButton(page, "下一题");
  // 3 哪些做法（多选 AB）→ 对
  await waitForQuestion(page, 3, 5);
  await answerCurrentQuestion(page, [0, 1], true);
  await expectText(page, "回答正确");
  await clickTextButton(page, "下一题");
  // 4 巡视前（判断 A）→ 对
  await waitForQuestion(page, 4, 5);
  await answerCurrentQuestion(page, [0]);
  await expectText(page, "回答正确");
  await clickTextButton(page, "下一题");
  // 5 图片（计算 10）→ 对
  await waitForQuestion(page, 5, 5);
  await page.getByRole("spinbutton", { name: "计算题答案" }).fill("10");
  await clickTextButton(page, "确认答案");
  await expectText(page, "回答正确");
  await clickTextButton(page, "查看本次结果");
  await expectText(page, "本次正确率");
  assert.match(await page.locator(".result-score strong").innerText(), /^80/, "four correct of five answered must show 80% accuracy");
  await capture(page, contextName, "result-page");

  // 结果页选中题目以主色软背景作唯一反馈：按钮基础 border:0 无四周边框，边框/描边
  // 方案会同时改动顶边（inset 线）与底部分隔线成上下等宽绿边（用户否决），因此选中
  // 不得叠加边框或描边，且底部分隔线必须保持浅灰。
  const firstResultQuestion = page.locator(".result-question-groups button").first();
  await firstResultQuestion.click();
  await page.getByRole("dialog", { name: "题目详情" }).waitFor({ state: "visible" });
  const detailHighlight = await firstResultQuestion.evaluate((button) => {
    const style = getComputedStyle(button);
    const root = getComputedStyle(document.documentElement);
    const resolveColor = (value, property) => {
      const probe = document.createElement("span");
      probe.style[property] = value;
      document.body.append(probe);
      const resolved = getComputedStyle(probe)[property];
      probe.remove();
      return resolved;
    };
    const primarySoftBg = resolveColor(root.getPropertyValue("--color-primary-soft").trim(), "backgroundColor");
    const separator = resolveColor("#e7e4dd", "borderTopColor");
    return { background: style.backgroundColor, boxShadow: style.boxShadow, borderBottom: style.borderBottomColor, expectSoftBg: primarySoftBg, expectSeparator: separator };
  });
  assert.equal(detailHighlight.background, detailHighlight.expectSoftBg, "结果页选中题目用主色软背景作选中反馈");
  assert.equal(detailHighlight.boxShadow, "none", "结果页选中不叠加边框/描边（底色已足够明显）");
  assert.equal(detailHighlight.borderBottom, detailHighlight.expectSeparator, "结果页选中不得改动底部分隔线颜色（防止上下等宽绿边）");
  await page.getByRole("dialog", { name: "题目详情" }).getByRole("button", { name: "关闭题目详情" }).click();
  await page.getByRole("dialog", { name: "题目详情" }).waitFor({ state: "hidden" });
  await capture(page, contextName, "result-question-selected");

  // 结果筛选 + 只练本次错题
  await clickTextButton(page, "只看错题");
  assert.equal(await page.locator(".result-question-groups button[aria-label^='查看第']").count(), 1, "wrong filter must narrow to the one wrong question");
  await clickTextButton(page, "全部题目");
  await capture(page, contextName, "result-filter-wrong");
  await clickTextButton(page, "只练本次错题");
  await page.locator(".question-card").waitFor({ state: "visible" });
  await waitForQuestion(page, 1, 1);
  await answerCurrentQuestion(page, [1]);
  await expectText(page, "回答正确");
  await clickTextButton(page, "查看本次结果");
  await expectText(page, "本次正确率");
  await capture(page, contextName, "result-repeat-wrong");
  await clickTextButton(page, "返回练习记录");

  // 练习记录：已完成 tab
  await page.locator(".history-filters button").filter({ hasText: /已完成/ }).click();
  await page.locator(".history-list article .run-status").filter({ hasText: "已完成" }).first().waitFor({ state: "visible" });
  await capture(page, contextName, "history-completed");

  // 进行中 → 继续练习 → 放弃 → 删除
  await page.locator(".practice-hub-tabs button").filter({ hasText: "开始练习" }).click();
  await selectBankOnPracticeSetup(page);
  await clickTextButton(page, "随机指定题数");
  await page.getByRole("spinbutton", { name: "本次随机题数" }).fill("2");
  await page.locator(".setup-footer > button.primary").click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await clickButton(page, "暂停并返回首页");
  await expectText(page, "继续上次练习");
  await clickButton(page, "练习");
  await expectText(page, "练习中心");
  await page.locator(".practice-hub-tabs button").filter({ hasText: "练习记录" }).click();
  await expectText(page, "练习记录");
  const inProgressTab = page.locator(".history-filters button").filter({ hasText: /进行中/ });
  await inProgressTab.click();
  const inProgressRun = page.locator(".history-list article").first();
  await inProgressRun.waitFor({ state: "visible" });
  await capture(page, contextName, "history-in-progress");
  await inProgressRun.getByRole("button", { name: "继续练习" }).click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await clickButton(page, "暂停并返回首页");
  await expectText(page, "继续上次练习");
  await clickButton(page, "练习");
  await page.locator(".practice-hub-tabs button").filter({ hasText: "练习记录" }).click();
  await inProgressTab.click();
  const resumedRun = page.locator(".history-list article").first();
  await resumedRun.waitFor({ state: "visible" });
  await resumedRun.getByRole("button", { name: "放弃练习" }).click();
  await expectNotice(page, /已放弃这次练习，记录仍会保留/, "abandon run notice");
  await page.locator(".history-filters button").filter({ hasText: /已放弃/ }).click();
  await page.locator(".history-list article .run-status").filter({ hasText: "已放弃" }).first().waitFor({ state: "visible" });
  await capture(page, contextName, "history-abandoned");
  // 删除按钮平时被 swipe-content 覆盖（需先滑动暴露）——用 dispatchEvent 直接触发其
  // 点击处理器作为替代（滑动手势见 docs/TESTING.md 已知限制）。
  await page.locator(".history-list article .history-delete-action").first().dispatchEvent("click");
  await expectNotice(page, /练习记录已删除，并加入同步队列/, "delete record notice");
  await expectText(page, "这里还没有记录");
  await capture(page, contextName, "history-deleted");
}

// 练习进行中删除题目/题库的竞争状态：直接经页面内 import 数据层触发删除（等价后台同步拉取删除），
// 验证练习界面不会卡死或静默丢答案。
async function runInFlightDeletionQA(page) {
  const contextName = "inflight";
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await importFixture(page);
  await setPracticePreferences(page, { autoNextCorrect: false, shuffleOptions: false });

  // 开启全量顺序练习
  await clickButton(page, "练习");
  await expectText(page, "练习中心");
  await selectBankOnPracticeSetup(page);
  await clickTextButton(page, "全量顺序练习");
  await page.locator(".setup-footer > button.primary").click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  const firstStem = (await page.locator(".practice-stem").innerText()).trim();

  // S1.1a：删除「当前题」→ 自动跳过到下一道存活题（skip-effect）
  const currentId = await page.evaluate(async (stemText) => {
    const { dbV7 } = await import("/exam-study-app/src/lib/db/db-v7.ts");
    const all = await dbV7.questions.toArray();
    const hit = all.find((q) => q.content.some((b) => b.type === "text" && b.text === stemText));
    return hit ? hit.id : null;
  }, firstStem);
  assert.ok(currentId, "应能定位当前题 id");
  await page.evaluate(async (id) => {
    const { deleteQuestionsV7 } = await import("/exam-study-app/src/lib/db/db-v7.ts");
    await deleteQuestionsV7([id]);
  }, currentId);
  await expectNotice(page, /题目已删除，自动跳过/, "delete-current-question skip notice");
  await page.waitForTimeout(400);
  const nextStem = (await page.locator(".practice-stem").innerText()).trim();
  assert.notEqual(nextStem, firstStem, "删除当前题后应前进到下一道存活题");
  await capture(page, contextName, "skipped-current-question");

  // S1.1b：一次性删除剩余全部题 → 优雅结束进结果页（练习中题目被删光）
  await page.evaluate(async () => {
    const { dbV7, deleteQuestionsV7 } = await import("/exam-study-app/src/lib/db/db-v7.ts");
    const all = await dbV7.questions.toArray();
    await deleteQuestionsV7(all.map((q) => q.id));
  });
  await expectNotice(page, /练习中的题目已被删除，本次练习结束/, "all-questions-deleted end notice");
  await page.locator(".run-result").waitFor({ state: "visible" });
  await capture(page, contextName, "ended-all-deleted");

  // S1.3：新开一次练习，删除其题库 → run 行被硬删，练习会话应被置空并提示（E3 修复，避免幽灵会话丢答案）
  // 上一段已删光全部题目，这里重新导入题库以恢复可练题目。
  await importFixture(page);
  await clickButton(page, "练习");
  await expectText(page, "练习中心");
  await selectBankOnPracticeSetup(page);
  await clickTextButton(page, "全量顺序练习");
  await page.locator(".setup-footer > button.primary").click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  const bankId = await page.evaluate(async () => {
    const { dbV7 } = await import("/exam-study-app/src/lib/db/db-v7.ts");
    const bank = (await dbV7.banks.toArray())[0];
    return bank?.id;
  });
  assert.ok(bankId, "应能定位练习题库 id");
  await page.evaluate(async (id) => {
    const { deleteBankV7 } = await import("/exam-study-app/src/lib/db/db-v7.ts");
    await deleteBankV7(id);
  }, bankId);
  await expectNotice(page, /题库已被删除|练习已结束/, "bank-deleted-during-practice notice (E3)");
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".question-card").isVisible(), false, "删除题库后应离开练习界面（无幽灵会话）");
  await capture(page, contextName, "bank-deleted-no-phantom");
}


// ===== 搜索页吸附几何断言 =====
// 设计（2026-08 用户确认）：搜索页内全局顶栏随内容滚走，页面自己的搜索框钉在
// 视口顶部，批量操作栏紧贴搜索框正下方。滚动后逐一断言，防止吸附目标回退到
// 全局顶栏（旧 bug：批量栏与顶部搜索框之间隔出大段距离）。
async function assertSearchPinGeometry(page, label, { requireScroll = false } = {}) {
  await page.evaluate(() => {
    const workspace = document.querySelector(".workspace");
    const scroller = workspace && getComputedStyle(workspace).overflowY === "auto" ? workspace : window;
    scroller.scrollBy(0, 5000);
  });
  await page.waitForTimeout(250);
  const geo = await page.evaluate(() => {
    const query = document.querySelector(".search-home-query")?.getBoundingClientRect();
    const bar = document.querySelector(".search-batch-bar")?.getBoundingClientRect();
    const topbar = document.querySelector(".topbar")?.getBoundingClientRect();
    const workspace = document.querySelector(".workspace");
    const usesWorkspaceScroll = workspace !== null && getComputedStyle(workspace).overflowY === "auto";
    const scroller = usesWorkspaceScroll ? workspace : document.scrollingElement;
    return {
      queryTop: query?.top,
      queryBottom: query?.bottom,
      barTop: bar?.top,
      topbarBottom: topbar?.bottom,
      scrollTop: scroller?.scrollTop ?? window.scrollY,
      atScrollBottom: scroller ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1 : true,
    };
  });
  assert.ok(geo.queryTop !== undefined && geo.barTop !== undefined, `${label}: 搜索结果页缺少搜索框或批量栏`);
  if (geo.scrollTop < 10) {
    // 内容不足以产生滚动：sticky 无从验证。专用组必须滚动（requireScroll），
    // 顺路检查组（桌面 search）允许跳过。
    assert.ok(!requireScroll, `${label}: 搜索结果应长于视口以验证吸附（scrollTop=${geo.scrollTop}）`);
    console.log(`  · ${label}: 内容未超出视口，跳过吸附几何断言`);
    return;
  }
  assert.ok(Math.abs(geo.queryTop) <= 1, `${label}: 搜索框应钉在视口顶部（实际 top=${geo.queryTop}）`);
  assert.ok((geo.topbarBottom ?? 0) <= geo.queryTop + 1, `${label}: 全局顶栏应随滚动离场、不压在搜索框上（topbar.bottom=${geo.topbarBottom}）`);
  // 批量栏必须紧贴搜索框下方；唯一例外是内容太短、滚动到底后批量栏天然位置仍在下方。
  if (geo.barTop > geo.queryBottom + 1) {
    assert.ok(geo.atScrollBottom, `${label}: 批量栏与搜索框之间不得有空隙（bar.top=${geo.barTop} vs query.bottom=${geo.queryBottom}），且未滚到底`);
  }
  await capture(page, "search-pin", `pinned-${label}`);
}

async function runSearchPinMobile(page) {
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await importFixture(page);
  await expectText(page, "送电线路工-初级工");
  await page.locator('input[type="file"]').first().setInputFiles(bigFixtureFile);
  await page.waitForTimeout(600);
  await clickButton(page, "进入搜索主页");
  await expectText(page, "搜索题库");
  // 空关键词条件搜索：展示全部题目，保证列表足够长可滚动。
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expectText(page, /条件搜索找到 \d+ 道题/);
  await assertSearchPinGeometry(page, "mobile", { requireScroll: true });
}

const GROUPS = [
  { key: "desktop", run: runDesktop, viewport: { width: 1440, height: 960 }, minScreenshots: 12 },
  { key: "mobile", run: runMobile, viewport: { width: 390, height: 844 }, isMobile: true, requires: ["desktop"], minScreenshots: 6 },
  { key: "management", run: runManagementQA, viewport: { width: 1440, height: 960 }, minScreenshots: 8 },
  { key: "review", run: runReviewRounds, viewport: { width: 1440, height: 960 }, minScreenshots: 3 },
  { key: "search", run: runSearchBatch, viewport: { width: 1440, height: 960 }, minScreenshots: 4 },
  { key: "search-pin", run: runSearchPinMobile, viewport: { width: 390, height: 844 }, isMobile: true, minScreenshots: 1 },
  { key: "history", run: runHistoryResult, viewport: { width: 1440, height: 960 }, minScreenshots: 3 },
  { key: "inflight", run: runInFlightDeletionQA, viewport: { width: 1440, height: 960 }, minScreenshots: 3 },
  { key: "sync-refresh", run: runSyncRefreshQA, viewport: { width: 1440, height: 960 }, minScreenshots: 3 },
  { key: "dark", run: runDarkModeAudit, viewport: { width: 1440, height: 960 }, minScreenshots: 1 },
];

// ===== 跨设备同步刷新练习（两设备共享同一 mock vault） =====
// 场景：设备 A 练习中答完第 1 题并推送；设备 B 拉取后继续答第 2、3 题并推送；
// 设备 A 回到练习界面点同步，应刷新练习信息、切到最后一道做完的题（Q3）。
// 这覆盖 refreshActivePracticeAfterSync：同步拉取后 practiceSession（内存快照）
// 必须对齐 DB 里合并进来的新作答。
async function runSyncRefreshQA(page, mockServer) {
  const contextName = "sync-refresh";
  const browser = page.context().browser();
  const vault = { owner: "qa", repo: "sync-refresh-vault", branch: "main", apiBaseUrl: mockServer.url };

  // ===== 设备 A：答第 1 题并推送 run =====
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await importFixture(page);
  await setPracticePreferences(page, { autoNextCorrect: false, shuffleOptions: false });
  await page.evaluate((settings) => {
    window.localStorage.setItem("github-settings", JSON.stringify(settings));
    window.localStorage.setItem("github-token", "qa-token");
  }, vault);
  await clickButton(page, "练习");
  await expectText(page, "练习中心");
  await selectBankOnPracticeSetup(page);
  await clickTextButton(page, "全量顺序练习");
  await page.locator(".setup-footer > button.primary").click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await waitForQuestion(page, 1, 5);
  await answerCurrentQuestion(page, [0]); // Q1 单选 传输电能 → 对
  await expectText(page, "回答正确");
  await clickButton(page, "暂停并返回首页");
  await expectText(page, "继续上次练习");
  await page.locator(".sync-pill.quick-sync").click();
  await expectNotice(page, /同步完成/, "device A first sync pushes bank + run");
  await page.locator(".resume-card .resume-continue").click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  // resume 停在最后作答的下一题（已答 Q1 不回看），即 Q2。
  await waitForQuestion(page, 2, 5);
  await capture(page, contextName, "a-resumed-q2");

  // ===== 设备 B：拉取 run，补答 Q2/Q3 并推送 =====
  const contextB = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const pageB = await contextB.newPage();
  keepBrowserInBackground();
  pageB.setDefaultTimeout(10_000);
  try {
    await pageB.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    await pageB.locator(".app-shell").waitFor({ state: "visible" });
    await setPracticePreferences(pageB, { autoNextCorrect: false, shuffleOptions: false });
    await pageB.evaluate((settings) => {
      window.localStorage.setItem("github-settings", JSON.stringify(settings));
      window.localStorage.setItem("github-token", "qa-token");
    }, vault);
    await pageB.locator(".sync-pill.quick-sync").click();
    await expectNotice(pageB, /同步完成/, "device B pulls device A data");
    await expectText(pageB, "继续上次练习");
    await pageB.locator(".resume-card .resume-continue").click();
    await pageB.locator(".question-card").waitFor({ state: "visible" });
    // 全量顺序练习按 TYPE_ORDER 分组排序：单选(传输电能/发现异常)→多选(安全巡视)→判断→计算。
    // A 答了第一题（传输电能），B 拉取后 resume 停在下一题：发现异常（单选，B 对）。
    await waitForQuestion(pageB, 2, 5);
    await answerCurrentQuestion(pageB, [1]); // 发现异常 单选 B 按流程记录并报告 → 对
    await expectText(pageB, "回答正确");
    await clickButton(pageB, "下一题");
    await waitForQuestion(pageB, 3, 5);
    await answerCurrentQuestion(pageB, [0, 1], true); // 安全巡视 多选 A 按规程/B 核对编号 → 对
    await expectText(pageB, "回答正确");
    await capture(page, contextName, "b-answered-q3");
    await clickButton(pageB, "暂停并返回首页");
    await expectText(pageB, "继续上次练习");
    await pageB.locator(".sync-pill.quick-sync").click();
    await expectNotice(pageB, /同步完成/, "device B pushes Q2/Q3 answers");
    // B 推送的 events 写进 mock 后 A 才能拉取，留出稳定窗口避免竞态。
    await pageB.waitForTimeout(600);
  } finally {
    await contextB.close();
  }

  // ===== 设备 A 再同步：刷新练习信息并切到最后一道做完的题（Q3） =====
  await page.locator(".sync-pill.quick-sync").click();
  await expectNotice(page, /已同步本练习 2 道新作答/, "device A refresh notice");
  await page.locator(".question-card").waitFor({ state: "visible" });
  await waitForQuestion(page, 3, 5);
  const stem = (await page.locator(".practice-stem").innerText()).replace(/\s+/g, " ");
  assert.ok(stem.includes("哪些做法有助于安全巡视"), "sync must jump to the last answered question (第 3 题 安全巡视)");
  await capture(page, contextName, "a-synced-jumped-q3");
}

// ===== 夜间模式按钮适配审计 =====
// 在深色主题下遍历全部主视图与关键弹窗，任何「近白背景 / 浅灰边框」的可见按钮
// 都视为未适配夜间模式（曾因 :where 零特异性被基础规则的 #fff 压回而回退过）。
// 刻意保持浅色的按钮（彩色卡片上的奶油色强调按钮等）登记在 ALLOWLIST，
// 新增按钮若被标记请先改 token 再放行。
const DARK_BUTTON_ALLOWLIST = [
  /^开始这一组$/, // 焦点卡片（绿色底）上的奶油色强调按钮，双主题刻意恒定
];

function parseRgbChannels(value) {
  const match = /rgba?\(([^)]+)\)/.exec(value ?? "");
  if (!match) return null;
  const parts = match[1].split(",").map((part) => Number(part.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

function looksLightInDark(channels, minChannel, minAlpha = 0.5) {
  if (!channels || channels.a < minAlpha) return false;
  return channels.r >= minChannel && channels.g >= minChannel && channels.b >= minChannel;
}

async function auditVisibleButtons(page, viewName, offenders) {
  const buttons = await page.evaluate(() => {
    const rows = [];
    for (const button of document.querySelectorAll("button")) {
      if (!(button instanceof HTMLElement) || button.offsetParent === null) continue;
      const style = getComputedStyle(button);
      rows.push({
        label: (button.getAttribute("aria-label") || button.textContent || "").replace(/\s+/g, " ").trim().slice(0, 36),
        bg: style.backgroundColor,
        border: style.borderColor,
        // border:0 的按钮 computed border-color 只是 currentColor 默认值，无视觉意义。
        borderWidth: Number.parseFloat(style.borderTopWidth) || 0,
      });
    }
    return rows;
  });
  for (const button of buttons) {
    const bg = parseRgbChannels(button.bg);
    const border = parseRgbChannels(button.border);
    const lightBg = looksLightInDark(bg, 225);
    const lightBorder = button.borderWidth > 0 && looksLightInDark(border, 195, 0.25);
    if (!lightBg && !lightBorder) continue;
    if (DARK_BUTTON_ALLOWLIST.some((pattern) => pattern.test(button.label))) continue;
    offenders.push(`${viewName} · ${button.label || "(图标按钮)"} bg=${button.bg} border=${button.border}`);
  }
}

// 夜间透明输入框审计：搜索类 input 的底色必须保持透明（旧 bug：全站夜间 input
// 规则带 !important 强制 #111813，压进本应透明的搜索框，容器与 input 呈两种深色）。
async function auditSearchInputsDark(page, offenders) {
  const rows = await page.evaluate(() => {
    const out = [];
    for (const input of document.querySelectorAll(".searchbox input, .search-home-query input")) {
      if (!(input instanceof HTMLInputElement) || input.offsetParent === null) continue;
      out.push({ container: input.closest(".searchbox, .search-home-query")?.className ?? "?", bg: getComputedStyle(input).backgroundColor });
    }
    return out;
  });
  assert.ok(rows.length >= 2, `夜间审计应同时看到顶栏搜索框与搜索页搜索框（实际 ${rows.length} 个）`);
  for (const row of rows) {
    const bg = parseRgbChannels(row.bg);
    if (bg && bg.a > 0.01) offenders.push(`夜间搜索框 input 底色不透明（.${row.container} bg=${row.bg}）`);
  }
}

async function runDarkModeAudit(page) {
  const contextName = "dark";
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await importFixture(page);
  await page.evaluate(() => {
    const raw = JSON.parse(window.localStorage.getItem("study-v7-preferences") ?? "{}");
    window.localStorage.setItem("study-v7-preferences", JSON.stringify({ ...raw, themeMode: "dark" }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");

  // 夜间 hover 审计（静态 CSSOM）：浅色 :hover 规则的特异性高于夜间基础列表，
  // 悬浮时会把浅底带回来（bank-priority-grid 曾中招）；元素级巡检采样的是
  // 静止态，看不到悬浮样式，这里直接扫样式表做项目级守卫。
  const hoverOffenders = await page.evaluate(() => {
    const isLight = (channels, min) => channels && channels.r >= min && channels.g >= min && channels.b >= min;
    const resolve = (value, min) => {
      if (!value || value.includes("var(")) return false;
      const toChannels = (text) => {
        if (text.startsWith("#")) {
          const hex = text.slice(1);
          if (hex.length === 3) return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16) };
          if (hex.length === 6) return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
          return null;
        }
        const match = /rgba?\(([^)]+)\)/.exec(text);
        if (!match) return null;
        const parts = match[1].split(",").map((part) => Number(part.trim()));
        return parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite) ? { r: parts[0], g: parts[1], b: parts[2] } : null;
      };
      return isLight(toChannels(value), min);
    };
    const rules = [];
    const walk = (list) => {
      for (const rule of list) {
        // 分组规则（@media/@supports）没有 selectorText；样式规则一律收录。
        // 不能用 rule.cssRules 判断分组——CSSStyleRule 也带空 cssRules（嵌套语法），
        // 那样会把所有样式规则当分组规则吞掉，守卫变成空扫。
        if (rule.selectorText !== undefined) {
          rules.push(rule);
          continue;
        }
        try { walk(rule.cssRules); } catch { /* 跨域或受限表跳过 */ }
      }
    };
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules); } catch { /* skip */ }
    }
    const darkSelectors = rules.filter((rule) => rule.selectorText?.includes('[data-theme="dark"]')).map((rule) => rule.selectorText);
    const offenders = [];
    for (const rule of rules) {
      const selector = rule.selectorText ?? "";
      if (!selector.includes(":hover") || selector.includes('[data-theme="dark"]')) continue;
      const style = rule.style;
      const bgValue = style.backgroundColor || style.background;
      const borderValue = style.borderTopColor || style.borderColor;
      if (!resolve(bgValue, 225) && !resolve(borderValue, 195)) continue;
      const hoverParts = selector.split(",").map((part) => part.trim()).filter((part) => part.includes(":hover"));
      // 覆盖判定：任一暗色选择器包含该 hover 选择器文本（共享 :where/:is 列表也成立）。
      const uncovered = hoverParts.filter((part) => !darkSelectors.some((dark) => dark.includes(part)));
      if (!uncovered.length) continue;
      offenders.push(`${uncovered.join(", ")} bg=${bgValue || "-"} border=${borderValue || "-"}`);
    }
    return offenders;
  });
  assert.deepEqual(hoverOffenders, [], `夜间模式下存在未适配的 :hover 浅色规则（请补 html[data-theme="dark"] 覆盖或改用主题 token）：\n${hoverOffenders.join("\n")}`);

  const offenders = [];
  for (const nav of ["今日", "题库", "练习", "知识整理", "配置", "同步"]) {
    await clickButton(page, nav);
    await page.waitForTimeout(450);
    await auditVisibleButtons(page, nav, offenders);
  }
  // 题组编辑器编辑态（历史漏检点）：取消编辑的叉按钮与条目移除按钮只在编辑
  // 已有题组时渲染，常规视图巡检看不到，曾在夜间保持白底。必须进入编辑态审计。
  await clickButton(page, "知识整理");
  await expectText(page, "标签");
  await clickTextButton(page, "题组");
  await page.getByLabel("题组名称").fill("夜间审计题组");
  const groupSearch = page.locator(".group-search input");
  await groupSearch.fill("巡视");
  await page.waitForTimeout(600);
  const firstGroupResult = page.locator(".group-search-results button").first();
  await firstGroupResult.waitFor({ state: "visible" });
  await firstGroupResult.click();
  await page.getByRole("button", { name: "保存题组" }).click();
  await expectNotice(page, /题组“夜间审计题组”已保存/, "dark audit group save");
  const groupCard = page.locator(".group-list article").filter({ hasText: "夜间审计题组" }).first();
  await groupCard.waitFor({ state: "visible" });
  await groupCard.getByRole("button", { name: "编辑" }).click();
  await page.getByRole("button", { name: "取消编辑" }).waitFor({ state: "visible" });
  await auditVisibleButtons(page, "题组编辑器编辑态", offenders);
  await capture(page, contextName, "group-editor-edit-dark");
  await page.getByRole("button", { name: "取消编辑" }).click();
  // 搜索视图：透明输入框审计（顶栏 + 搜索页两个搜索框）。
  await clickButton(page, "今日");
  await clickButton(page, "进入搜索主页");
  await expectText(page, "搜索题库");
  await auditSearchInputsDark(page, offenders);
  // 搜索详情面板底部操作按钮（历史回退点：夜间规则 >footer>button 子选择器
  // 匹配不到 .search-detail-actions 内的按钮，三按钮保持浅色 #fff）。
  await page.getByLabel("搜索题库").fill("巡视");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expectText(page, /“巡视”找到 \d+ 道题/);
  await page.locator(".search-result-list article").first().locator(".search-result-main").click();
  await page.getByRole("dialog", { name: "题目详情" }).waitFor({ state: "visible" });
  await auditVisibleButtons(page, "搜索详情面板", offenders);
  await capture(page, contextName, "search-detail-dark");
  await page.getByRole("dialog", { name: "题目详情" }).getByRole("button", { name: "关闭题目详情" }).click();
  await page.getByRole("dialog", { name: "题目详情" }).waitFor({ state: "hidden" });
  await clickButton(page, "题库");
  // 清除数据确认弹窗（历史回退点）：三个按钮必须全部适配。
  await clickButton(page, "同步");
  await expectText(page, "GitHub 同步");
  const clearButton = page.getByRole("button", { name: "清除数据" }).first();
  await clearButton.scrollIntoViewIfNeeded();
  await clearButton.click();
  await page.locator(".confirm-dialog").waitFor({ state: "visible" });
  await auditVisibleButtons(page, "清除数据弹窗", offenders);
  await capture(page, contextName, "clear-data-dialog-dark");
  await page.getByRole("button", { name: "取消" }).click();
  await page.locator(".confirm-dialog").waitFor({ state: "hidden" });

  // 练习答题页（提交后还有结果操作按钮）。
  await clickButton(page, "练习");
  await expectText(page, "练习中心");
  await selectBankOnPracticeSetup(page);
  await clickTextButton(page, "全量顺序练习");
  await page.locator(".setup-footer > button.primary").click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await answerCurrentQuestion(page, [0]);
  await auditVisibleButtons(page, "练习作答", offenders);

  assert.deepEqual(offenders, [], `夜间模式下存在未适配按钮（${offenders.length} 个，请改用主题 token 或登记 ALLOWLIST）：\n${offenders.join("\n")}`);
  console.log(`dark mode button audit passed: 6 视图 + 清除数据弹窗 + 练习作答，无未适配按钮`);
}

async function main() {
  await mkdir(runRoot, { recursive: true });
  await startDevServerIfNeeded();
  // In-process mock GitHub backend: all browser contexts share it, so the
  // desktop sync pushes real data and the mobile sync pulls it back — a true
  // cross-device round-trip without any external network.
  const mockServer = await startMockGitHubServer();
  lastUserApp = frontmostAppName();
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage"],
  });
  keepBrowserInBackground();

  // BROWSER_GROUPS=desktop,mobile,management,review,search,history
  // (comma-separated; unset = all groups). Each group gets a fresh browser
  // context and its own IndexedDB; `requires` expands dependencies first so a
  // group that depends on another device's pushed data (mobile → desktop) still
  // works when selected on its own.
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
      keepBrowserInBackground();
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(25_000);
      const before = screenshots.length;
      await group.run(page, mockServer);
      const count = screenshots.length - before;
      ran.push({ key: group.key, screenshots: count });
      assert.ok(count >= group.minScreenshots, `${group.key} group must capture at least ${group.minScreenshots} screenshots, got ${count}`);
      await context.close();
    }
  } finally {
    await mockServer.close();
    await browser.close();
  }
  const manifest = { baseUrl, chromeExecutable, groups: ran, screenshots };
  await writeFile(path.join(runRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Browser QA passed (${headless ? "headless" : "visible"}): ${ran.map((item) => `${item.key}(${item.screenshots})`).join(", ")} in ${path.relative(root, runRoot)}`);
}

try {
  await main();
} finally {
  if (devServer && !devServer.killed) devServer.kill("SIGTERM");
}
