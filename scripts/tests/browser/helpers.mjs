import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { root, runRoot, screenshots } from "./harness.mjs";
import { fixtureFile } from "./fixtures.mjs";

/*
 * Role/text locators can temporarily have zero matches while React replaces a
 * focused topbar control after Radix closes its popup. Keep button helpers on
 * the same 10 s eventual-visibility contract as expectText instead of taking
 * a single synchronous DOM snapshot and reporting a false regression.
 */
async function visibleLocator(page, locator, description) {
  const deadline = Date.now() + 10_000;
  do {
    for (let index = 0; index < await locator.count(); index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible()) return candidate;
    }
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  throw new Error(`Visible ${description} was not found`);
}

export async function clickButton(page, name, options = {}) {
  const locator = page.getByRole("button", { name, exact: options.exact ?? true });
  const button = await visibleLocator(page, locator, `button ${JSON.stringify(name)}`);
  await button.click();
  return button;
}

export async function clickTextButton(page, text) {
  const locator = page.locator("button").filter({ hasText: text });
  const button = await visibleLocator(page, locator, `button containing ${JSON.stringify(text)}`);
  await button.click();
  return button;
}

export async function expectText(page, text, timeout = 10_000) {
  const locator = page.getByText(text, { exact: true }).first();
  await locator.waitFor({ state: "visible", timeout });
  return locator;
}

export async function waitForQuestion(page, number, total = 5) {
  const progress = page.locator(".practice-progress span");
  await progress.filter({ hasText: new RegExp(`^${number} / ${total} ·`) }).waitFor({ state: "visible" });
}

export async function assertOverviewFocus(page, questionNumber, expectedProgress) {
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

export async function expectNotice(page, pattern, description = "notice") {
  const notice = page.locator(".toast").filter({ hasText: pattern }).first();
  await notice.waitFor({ state: "visible", timeout: 10_000 });
  assert.match(await notice.innerText(), pattern, `${description} should be visible`);
  return notice;
}

export async function expectSyncFailureNotice(page) {
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

export async function capture(page, contextName, label) {
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

export async function importFixture(page) {
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(fixtureFile);
  await expectText(page, "题库");
  await page.waitForTimeout(250);
}

export async function setPracticePreferences(page, patch) {
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

export async function selectBankOnPracticeSetup(page) {
  const bankButton = page.locator(".scope-bank-list button").filter({ hasText: "送电线路工-初级工" });
  const visibleBankButton = await visibleLocator(page, bankButton, "practice bank selector");
  const pressed = await visibleBankButton.getAttribute("aria-pressed");
  if (pressed !== "true") await visibleBankButton.click();
}

export async function answerCurrentQuestion(page, optionIndexes, confirm = false) {
  const options = page.locator(".options > button");
  const expectedOptionCount = Math.max(...optionIndexes) + 1;
  await page.waitForFunction(
    (minimum) => document.querySelectorAll(".options > button").length >= minimum,
    expectedOptionCount,
  );
  assert.ok(await options.count() >= expectedOptionCount, "expected answer options to be rendered");
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

export async function pendingEventCount(page) {
  // Pending change-sets (state pending|blocked) are the new sync queue; the v7
  // event log no longer exists.
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("shijuan-study");
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

export async function attachFixtureImage(page) {
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
  await assertActionButtonRow(page, ".question-manager>header", { minHeight: 42, maxHeight: 42 });
  const question = page.locator(".managed-question-list article").filter({ hasText: "图片所示数值允许 1% 误差时" }).first();
  await question.getByRole("button", { name: "编辑题目" }).click();
  const stemEditor = page.locator(".question-editor .editor-rich-field").first();
  const chooserPromise = page.waitForEvent("filechooser");
  await stemEditor.getByRole("button", { name: /在文本块 .* 中选择图片/ }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(path.join(root, "public/icons/app-icon-192.png"));
  // Keep the assertion strict while allowing the asynchronous decode/resize
  // pipeline to finish, and surface its own error instead of a vague timeout.
  const imageResult = stemEditor.locator(".content-block-editor-image, .content-block-editor-error").first();
  await imageResult.waitFor({ state: "visible", timeout: 30_000 });
  if (await imageResult.evaluate((element) => element.classList.contains("content-block-editor-error"))) {
    throw new Error(`Browser image preparation failed: ${await imageResult.innerText()}`);
  }
  await clickButton(page, "保存修改");
  await page.getByRole("dialog", { name: "编辑题目" }).waitFor({ state: "hidden" });
}

export async function assertActionButtonRow(page, selector, { minHeight = 36, maxHeight = 42 } = {}) {
  const rows = await page.locator(`${selector} button:visible`).evaluateAll((buttons) => buttons.map((button) => {
    const box = button.getBoundingClientRect();
    return { height: box.height, fontSize: Number.parseFloat(getComputedStyle(button).fontSize) };
  }));
  assert.ok(rows.length > 0, `${selector} must contain a visible action button`);
  for (const row of rows) {
    assert.ok(row.height >= minHeight - 0.5 && row.height <= maxHeight + 0.5,
      `${selector} button height ${row.height}px must stay in [${minHeight}, ${maxHeight}]`);
    assert.ok(row.fontSize >= 12, `${selector} button font-size ${row.fontSize}px must be at least 12px`);
  }
}

export async function assertBankManagementActions(page) {
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
  await assertActionButtonRow(page, ".bank-primary-actions", { minHeight: 42, maxHeight: 42 });
}

export async function createBlankBank(page, name) {
  await clickTextButton(page, "新建题库");
  const dialog = page.getByRole("dialog", { name: "新建空白题库" });
  await dialog.waitFor({ state: "visible" });
  await assertActionButtonRow(page, ".simple-dialog footer", { minHeight: 42, maxHeight: 42 });
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

export async function assertSearchFilterInteractions(page, contextName) {
  // 刷新后首次输入时，防抖关键词的初值为空。题库加载不能依赖该初值，
  // 否则 useLiveQuery 不会在防抖结束后重跑，界面会一直停在“正在搜索”。
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  const quickQuery = page.getByLabel("快速正则搜索题目、选项、标签或解析");
  await quickQuery.fill("巡视");
  await page.locator(".search-results").waitFor({ state: "visible" });
  await page.getByText("快速正则结果", { exact: true }).waitFor({ state: "visible" });
  await page.getByText(/共 \d+ 道匹配题目/).waitFor({ state: "visible" });
  assert.equal(await page.getByText("正在搜索…", { exact: true }).count(), 0, "first quick search after reload must leave the loading state");
  await page.getByRole("button", { name: "清除搜索" }).click();

  const quickScope = page.getByLabel("快速搜索范围");
  assert.equal(await page.locator('select[aria-label="快速搜索范围"]').count(), 0, "quick search scope must not use the native select menu");
  assert.ok(await quickScope.evaluate((element) => element.classList.contains("app-select-trigger")), "quick search scope must use the shared custom trigger");
  await quickScope.click();
  const quickScopePopup = page.locator(".quick-search-scope-content");
  await quickScopePopup.waitFor({ state: "visible" });
  const quickScopeStyle = await quickScopePopup.evaluate((element) => {
    const style = getComputedStyle(element);
    const checked = element.querySelector('[role="option"][data-state="checked"]');
    return {
      borderRadius: Number.parseFloat(style.borderRadius),
      boxShadow: style.boxShadow,
      background: style.backgroundColor,
      checkedBackground: checked ? getComputedStyle(checked).backgroundColor : "",
    };
  });
  assert.ok(quickScopeStyle.borderRadius >= 10, "custom search scope menu must keep the app's rounded surface");
  assert.notEqual(quickScopeStyle.boxShadow, "none", "custom search scope menu must keep the app's elevated surface");
  assert.notEqual(quickScopeStyle.checkedBackground, quickScopeStyle.background, "selected search scope must use the app's highlighted option style");
  await page.keyboard.press("Escape");

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
  await expectText(page, "搜索字段");
  await expectText(page, "匹配方式");
  const matchGroups = await page.evaluate(() => {
    const field = document.querySelector(".search-field-group");
    const mode = document.querySelector(".search-mode-group");
    const fieldBox = field?.getBoundingClientRect();
    const modeBox = mode?.getBoundingClientRect();
    return {
      fieldBackground: field ? getComputedStyle(field).backgroundColor : "",
      modeBackground: mode ? getComputedStyle(mode).backgroundColor : "",
      fieldBottom: fieldBox?.bottom ?? 0,
      modeTop: modeBox?.top ?? 0,
    };
  });
  assert.notEqual(matchGroups.fieldBackground, matchGroups.modeBackground, "search fields and match mode must use distinct visual surfaces");
  assert.ok(matchGroups.modeTop > matchGroups.fieldBottom, "match mode must be a separate group below search fields");
  await page.getByRole("radio", { name: "错题" }).click();
  const activeCountText = await page.locator(".search-filter-drawer-header span").innerText();
  assert.match(activeCountText, /已设置 [1-9]\d* 项/, "choosing a filter must immediately update the active count");
  await page.locator(".search-filter-backdrop").click({ position: { x: 20, y: 180 } });
  await page.locator(".search-filter-drawer").waitFor({ state: "hidden" });
  assert.match(await page.locator(".search-filter-toggle").innerText(), /筛选\s*[1-9]\d*/, "immediate filter changes must remain after dismissing the drawer");
  await capture(page, contextName, "search-controls-aligned");
}
