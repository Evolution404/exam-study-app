import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import * as XLSX from "xlsx";

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

async function expectNotice(page, pattern, description = "notice") {
  const notice = page.locator(".toast").filter({ hasText: pattern }).first();
  await notice.waitFor({ state: "visible", timeout: 10_000 });
  assert.match(await notice.innerText(), pattern, `${description} should be visible`);
  return notice;
}

async function expectSyncFailureNotice(page) {
  return expectNotice(page, /GitHub|同步|失败|401/, "sync failure notice");
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
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("shijuan-study-v6");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("events", "readonly");
      const count = transaction.objectStore("events").index("synced").count(IDBKeyRange.only(0));
      count.onerror = () => reject(count.error);
      count.onsuccess = () => {
        database.close();
        resolve(count.result);
      };
    };
  }));
}

async function attachFixtureImage(page) {
  const bankCard = page.locator("button.bank-management-main").filter({ hasText: "送电线路工-初级工" }).first();
  await bankCard.click();
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

async function assertBankManagementActions(page, expectedColumns) {
  const toolbar = page.locator(".bank-management-heading .heading-actions");
  const buttons = toolbar.locator(":scope > button");
  assert.equal(await buttons.count(), 5, "bank management toolbar must expose five actions");
  const layout = await toolbar.evaluate((element) => ({
    columns: getComputedStyle(element).gridTemplateColumns.split(" ").length,
    buttons: [...element.querySelectorAll(":scope > button")].map((button) => {
      const box = button.getBoundingClientRect();
      return {
        height: box.height,
        scrollWidth: button.scrollWidth,
        width: box.width,
        whiteSpace: getComputedStyle(button).whiteSpace,
      };
    }),
  }));
  assert.equal(layout.columns, expectedColumns, `bank management toolbar must use ${expectedColumns} columns`);
  const heights = layout.buttons.map(({ height }) => height);
  assert.ok(Math.max(...heights) - Math.min(...heights) < 1, "bank management actions must have equal heights");
  for (const button of layout.buttons) {
    assert.equal(button.whiteSpace, "nowrap", "bank management action text must stay on one line");
    assert.ok(button.scrollWidth <= button.width + 1, "bank management action text must fit its button");
  }
}

async function runDesktop(page) {
  const contextName = "desktop";
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await expectText(page, "今日");
  await capture(page, contextName, "home-empty");

  await importFixture(page);
  await expectText(page, "送电线路工-初级工");
  await capture(page, contextName, "home-imported");

  await clickButton(page, "题库");
  await expectText(page, "题库管理");
  const excelInput = page.locator('input[type="file"][accept*=".xlsx"]').first();
  await excelInput.setInputFiles(excelFixtureFile);
  await expectNotice(page, /已从 Excel 导入/, "Excel import notice");
  await assertBankManagementActions(page, 5);
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
  await (await visibleLocator(page, page.locator(".setup-footer button"), "practice start button")).click();
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
  await capture(page, contextName, "practice-overview");
  await clickButton(page, "关闭题目总览");
  await clickTextButton(page, "下一题");
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".practice-layout")).animationName === "question-page-forward");
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
  await page.locator(".asset-image img").waitFor({ state: "visible" });
  const calculationAnswer = page.getByRole("spinbutton", { name: "计算题答案" });
  await calculationAnswer.fill("10.05");
  await clickTextButton(page, "确认答案");
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
}

async function runMobile(page) {
  const contextName = "mobile";
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await importFixture(page);
  await clickButton(page, "打开导航");
  await expectText(page, "题库");
  await capture(page, contextName, "mobile-menu");
  await clickButton(page, "题库");
  await expectText(page, "题库管理");
  await assertBankManagementActions(page, 2);
  const beforeTemplateDownload = page.url();
  const download = page.waitForEvent("download", { timeout: 3_000 }).catch(() => undefined);
  await clickTextButton(page, "下载 Excel 模板");
  await download;
  assert.equal(page.url(), beforeTemplateDownload, "mobile template download must keep the app on its current page");
  await capture(page, contextName, "banks");
  await clickButton(page, "打开导航");
  await clickButton(page, "练习");
  await expectText(page, "练习中心");
  await selectBankOnPracticeSetup(page);
  await clickTextButton(page, "全量顺序练习");
  await (await visibleLocator(page, page.locator(".setup-footer button"), "mobile practice start button")).click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await capture(page, contextName, "practice");
  await clickButton(page, "暂停并返回首页");
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
}

async function main() {
  await mkdir(runRoot, { recursive: true });
  await startDevServerIfNeeded();
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
    await runDesktop(desktop);
    await desktopContext.close();

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const mobile = await mobileContext.newPage();
    mobile.setDefaultTimeout(10_000);
    mobile.setDefaultNavigationTimeout(25_000);
    await runMobile(mobile);
    await mobileContext.close();
  } finally {
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
