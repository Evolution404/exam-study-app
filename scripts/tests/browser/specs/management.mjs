import * as harness from "../harness.mjs";
import * as helpers from "../helpers.mjs";
import * as fixtures from "../fixtures.mjs";

export async function runManagementQA(page, mockServer) {
  const contextName = "management";
  await page.goto(`${harness.baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await helpers.importFixture(page);
  await helpers.expectText(page, "送电线路工-初级工");

  // ===== 题库管理：文件夹 / 编辑 / 新增 / 批量 / 删除 =====
  // 新建文件夹（FolderDialog 无 role="dialog"，用 .simple-dialog 定位）
  await helpers.clickTextButton(page, "新建文件夹");
  const folderDialog = page.locator(".simple-dialog").filter({ hasText: "文件夹名称" });
  await folderDialog.waitFor({ state: "visible" });
  await folderDialog.getByLabel("文件夹名称").fill("线路工题库");
  await folderDialog.getByLabel("说明").fill("归类送电线路工相关题库");
  await folderDialog.getByRole("button", { name: "保存文件夹" }).click();
  await helpers.expectNotice(page, /文件夹“线路工题库”已保存/, "folder save notice");
  await helpers.capture(page, contextName, "folder-created");

  // 编辑题库：改名 + 移入文件夹
  await page.locator("button.bank-management-main").filter({ hasText: "送电线路工-初级工" }).first().click();
  await helpers.expectText(page, "范围表现（近 90 天）");
  await helpers.clickTextButton(page, "编辑题库");
  const editDialog = page.locator(".simple-dialog").filter({ hasText: "展示名称" });
  await editDialog.waitFor({ state: "visible" });
  await editDialog.getByLabel("展示名称").fill("送电线路工-基础");
  await editDialog.getByLabel("所属文件夹").click();
  await page.getByRole("option", { name: "线路工题库" }).click();
  await editDialog.getByRole("button", { name: "保存题库" }).click();
  await helpers.expectNotice(page, /已保存/, "bank edit notice");
  await helpers.clickTextButton(page, "返回题库管理");
  await helpers.expectText(page, "题库管理");
  await helpers.expectText(page, "送电线路工-基础");
  await helpers.expectText(page, "线路工题库");
  await helpers.capture(page, contextName, "bank-edited");

  // 新增题目（单选，答案默认 A）
  await page.locator("button.bank-management-main").filter({ hasText: "送电线路工-基础" }).first().click();
  await helpers.expectText(page, "范围表现（近 90 天）");
  await helpers.clickTextButton(page, "试题管理");
  await helpers.assertActionButtonRow(page, ".question-bulk-bar>div", { minHeight: 36, maxHeight: 36 });
  await helpers.clickTextButton(page, "新增题目");
  const addDialog = page.getByRole("dialog", { name: "新增题目" });
  await addDialog.waitFor({ state: "visible" });
  await addDialog.locator(".editor-rich-field textarea").first().fill("导线弧垂与安全距离的关系是什么？");
  await addDialog.getByLabel("个人解析").fill("弧垂增大时安全距离应随之调整。");
  await addDialog.locator('input[placeholder="例如：弧垂，易混，必背"]').fill("易混,巡视");
  await addDialog.getByRole("button", { name: "添加题目" }).click();
  await helpers.expectNotice(page, /新题目已添加/, "question add notice");
  const addedStem = page.locator(".managed-question-list article").filter({ hasText: "导线弧垂与安全距离的关系" }).first();
  await addedStem.waitFor({ state: "visible" });
  await helpers.capture(page, contextName, "question-added");

  // 编辑题目：改题干
  await addedStem.getByRole("button", { name: "编辑题目" }).click();
  const editQuestionDialog = page.getByRole("dialog", { name: "编辑题目" });
  await editQuestionDialog.waitFor({ state: "visible" });
  await editQuestionDialog.locator(".editor-rich-field textarea").first().fill("弧垂增大时安全距离如何变化？");
  await helpers.clickTextButton(page, "保存修改");
  await page.getByRole("dialog", { name: "编辑题目" }).waitFor({ state: "hidden" });
  await helpers.expectNotice(page, /题目已保存/, "question edit notice");
  await page.locator(".managed-question-list article").filter({ hasText: "弧垂增大时安全距离如何变化" }).first().waitFor({ state: "visible" });
  await helpers.capture(page, contextName, "question-edited");

  // 往既有题库继续导入：试题管理头部「导入题目」→ 选 Excel → 导入当前题库、停留在试题管理。
  {
    const listCount = await page.locator(".managed-question-list article").count();
    await page.getByRole("button", { name: /导入题目/ }).click();
    const bankExcelInput = page.locator('input[type="file"][accept*=".xlsx"]').first();
    await bankExcelInput.setInputFiles(fixtures.excelFixtureFile);
    await helpers.expectNotice(page, /已从 Excel 导入 3 道题到「送电线路工-基础」/, "import-into-bank notice");
    const grownCount = await page.locator(".managed-question-list article").count();
    harness.assert.equal(grownCount, listCount + 3, "导入题目应把 Excel 的 3 行追加进当前题库");
    harness.assert.ok(await page.locator(".bank-detail-tabs button.active").filter({ hasText: "试题管理" }).isVisible(), "导入后应停留在试题管理 tab");
    await helpers.capture(page, contextName, "import-into-bank");
  }

  // 题目详情：进度指示单独一行 + 上一题/下一题切换（与搜索详情统一）
  await page.locator(".managed-question-list article").first().locator("button").first().click();
  const managedDetail = page.getByRole("dialog", { name: "题目详情" });
  await managedDetail.waitFor({ state: "visible" });
  const detailCount = managedDetail.locator(".search-detail-count");
  await detailCount.waitFor({ state: "visible" });
  const detailCountBefore = (await detailCount.textContent()) ?? "";
  harness.assert.match(detailCountBefore, /^\d+ \/ \d+$/, "题目详情应显示进度指示（当前/总数）");
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
  await helpers.capture(page, contextName, "question-detail-nav");

  // 批量操作：勾选 2 道 → 从题库移除
  const checkboxes = page.locator(".managed-question-check input");
  harness.assert.ok(await checkboxes.count() >= 2, "expected at least two managed questions");
  await checkboxes.nth(0).check({ force: true });
  await checkboxes.nth(1).check({ force: true });
  await helpers.expectText(page, "已选 2 道");
  await helpers.clickTextButton(page, "从题库移除");
  await page.getByRole("alertdialog", { name: /从题库移除 \d+ 道题/ }).waitFor({ state: "visible" });
  await helpers.clickTextButton(page, "批量移除");
  await helpers.expectNotice(page, /移除 \d+ 道题/, "bulk remove notice");
  await helpers.capture(page, contextName, "bulk-removed");

  // 未归档题目：批量移除的 fixture 前两道应出现在这里
  await helpers.clickTextButton(page, "返回题库管理");
  await helpers.clickTextButton(page, "未归档题目");
  await helpers.expectText(page, "未归档题目");
  const unfiled = page.locator(".managed-question-list article").filter({ hasText: "导线的主要作用是什么" }).first();
  await unfiled.waitFor({ state: "visible" });
  await helpers.capture(page, contextName, "unfiled-questions");
  await helpers.clickTextButton(page, "隐藏未归档");

  // ===== 标签管理（知识整理 · 标签 tab） =====
  await helpers.clickButton(page, "知识整理");
  await helpers.expectText(page, "标签");
  const tagCard = page.locator(".tag-card-grid article").filter({ hasText: "易混" }).first();
  await tagCard.waitFor({ state: "visible" });
  await tagCard.getByRole("button", { name: "练习" }).click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await helpers.clickButton(page, "暂停并返回首页");
  await helpers.expectText(page, "继续上次练习");
  await helpers.capture(page, contextName, "tag-practice");

  // ===== 题组管理（知识整理 · 题组 tab，需在删除题库前：搜索依赖题库内题目） =====
  await helpers.clickButton(page, "知识整理");
  await helpers.expectText(page, "标签");
  await helpers.clickTextButton(page, "题组");

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
  await helpers.expectNotice(page, /题组“弧垂易混题组”已保存，共 1 道题/, "group save notice");
  let groupCard = page.locator(".group-list article").filter({ hasText: "弧垂易混题组" }).first();
  await groupCard.waitFor({ state: "visible" });
  await helpers.capture(page, contextName, "group-created");

  // 编辑题组：改名 + 删除单题
  await groupCard.getByRole("button", { name: "编辑" }).click();
  await page.getByLabel("题组名称").fill("弧垂易混题组-改");
  await page.getByRole("button", { name: "保存题组" }).click();
  await helpers.expectNotice(page, /题组“弧垂易混题组-改”已保存/, "group rename notice");
  groupCard = page.locator(".group-list article").filter({ hasText: "弧垂易混题组-改" }).first();
  await groupCard.waitFor({ state: "visible" });
  await helpers.capture(page, contextName, "group-renamed");

  // 练习题组 → 答题并输入解析（note）→ 自动保存 → 暂停返回
  await groupCard.getByRole("button", { name: "练习题组" }).click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await page.locator(".practice-progress span").filter({ hasText: "题组 · 弧垂易混题组-改" }).waitFor({ state: "visible" });
  await helpers.answerCurrentQuestion(page, [0]);
  await helpers.expectText(page, "回答正确");
  const noteField = page.locator('textarea[placeholder^="写下错因、口诀或区分条件…"]');
  await noteField.fill("弧垂与安全距离成反比，做题时先判断弧垂方向。");
  await helpers.expectText(page, "已自动保存");
  await helpers.capture(page, contextName, "note-saved");
  await helpers.clickButton(page, "暂停并返回首页");
  await helpers.expectText(page, "继续上次练习");
  await helpers.clickButton(page, "知识整理");
  await helpers.clickTextButton(page, "题组");

  // 删除题组
  groupCard = page.locator(".group-list article").filter({ hasText: "弧垂易混题组-改" }).first();
  await groupCard.getByRole("button", { name: "删除" }).click();
  await page.getByRole("alertdialog", { name: "删除这个题组？" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "删除题组" }).click();
  await helpers.expectNotice(page, /题组.*已删除/, "group delete notice");
  await helpers.capture(page, contextName, "group-deleted");

  // 删除题库（保留题目）——题组与解析都依赖题库内题目，故放在最后
  await helpers.clickButton(page, "题库");
  await helpers.expectText(page, "题库管理");
  await page.locator("button.bank-management-main").filter({ hasText: "送电线路工-基础" }).first().click();
  await helpers.expectText(page, "范围表现（近 90 天）");
  await helpers.clickTextButton(page, "删除题库");
  await page.getByRole("dialog", { name: "删除题库时如何处理题目？" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: /只删除题库，保留题目/ }).click();
  await helpers.expectNotice(page, /已删除，题目已保留/, "bank delete keep questions");
  await helpers.expectText(page, "题库管理");
  await helpers.capture(page, contextName, "bank-deleted");

  // ===== 事件管理（同步页） =====
  await helpers.clickButton(page, "同步");
  await helpers.expectText(page, "GitHub 同步");

  // 事件管理器渲染（刷新按钮已移除，为空操作）
  await page.locator(".sync-event-manager").waitFor({ state: "visible" });
  await helpers.expectText(page, "等待同步");

  // 展开事件详情
  const eventList = page.locator(".sync-event-list");
  await eventList.waitFor({ state: "visible" });
  const firstEventSummary = page.locator(".sync-event-summary").first();
  await firstEventSummary.waitFor({ state: "visible" });
  await firstEventSummary.click();
  await page.locator(".sync-event-detail").first().waitFor({ state: "visible" });
  await page.locator(".sync-event-mutations").first().waitFor({ state: "visible" });
  await helpers.capture(page, contextName, "event-detail");

  // 编辑事件：展开的事件若可编辑则编辑业务字段
  const editFieldButton = page.locator(".sync-event-detail").first().getByRole("button", { name: "编辑业务字段" });
  if (await editFieldButton.count() > 0) {
    await editFieldButton.click();
    const editor = page.locator(".sync-event-editor");
    await editor.waitFor({ state: "visible" });
    await editor.getByRole("button", { name: "保存修改" }).click();
    await editor.waitFor({ state: "hidden" });
    await helpers.capture(page, contextName, "event-edited");
  }

  // 删除一个 pending 事件（确认对话框）
  const deleteButton = page.locator(".sync-event-row-actions button[aria-label^='删除整组']").first();
  if (await deleteButton.count() > 0) {
    await deleteButton.click();
    const deleteDialog = page.getByRole("alertdialog", { name: "删除整个 change-set？" });
    await deleteDialog.waitFor({ state: "visible" });
    await deleteDialog.getByRole("button", { name: "删除整组" }).click();
    await deleteDialog.waitFor({ state: "hidden" });
    await helpers.capture(page, contextName, "event-deleted");
  }

  // 批量抽屉（已同步/待同步分组）
  const batchSections = page.locator(".sync-event-batch");
  harness.assert.ok(await batchSections.count() >= 1, "event manager must render batch sections");
  await helpers.capture(page, contextName, "event-batches");

  // 真实同步（mock 后端）：清空全部待同步事件
  const mgmtFields = page.locator(".settings-card").first().locator("input");
  await mgmtFields.nth(0).fill("qa");
  await mgmtFields.nth(1).fill("mgmt-vault");
  await mgmtFields.nth(3).fill("tok");
  await mgmtFields.nth(4).fill(mockServer.url);
  await helpers.clickTextButton(page, "立即同步");
  await page.locator(".simple-dialog").filter({ hasText: "正在同步云端数据" }).waitFor({ state: "hidden", timeout: 20_000 }).catch(() => {});
  const syncToast = await page.locator(".toast").first().innerText().catch(() => "");
  harness.assert.match(syncToast, /v9 同步完成/, "management events should sync successfully");
  await helpers.capture(page, contextName, "events-synced");

  // 本次同步抽屉：搜索输入框必须无边框、聚焦只靠边框变色（统一输入框样式，避免内外两个矩形或聚焦光环）
  await page.locator(".sync-queue-trigger").click();
  await page.locator(".sync-event-drawer").waitFor({ state: "visible" });
  // 抽屉工具栏下方展示与同步页一致的热窗口信息面板。
  const drawerHotLabels = (await page.locator(".sync-event-drawer .sync-hot-window dt").allInnerTexts()).map((text) => text.trim());
  harness.assert.ok(
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
  harness.assert.equal(drawerInputBorder.borderWidth, "0px", "drawer search input must be borderless (unified single-rectangle input)");
  harness.assert.equal(drawerInputBorder.boxShadow, "none", "drawer search input must not add a focus box-shadow ring");
  harness.assert.equal(drawerInputBorder.labelBorder, "11px", "drawer search input must stay inside the rounded container");
  harness.assert.equal(drawerInputBorder.labelBoxShadow, "none", "drawer search container must not show a focus glow ring");
  harness.assert.notEqual(drawerInputBorder.labelBorderColor, "rgba(0, 0, 0, 0)", "drawer search container must still signal focus via border color");
  await helpers.capture(page, contextName, "sync-drawer-search");
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
  harness.assert.ok(before && /^第 \d+ 代$/.test(before.generation ?? ""), `同步页面板应有当前头代数（实际 ${before?.generation}）`);
  // 通过应用层接口制造 1 条 pending（收藏切换走完整 change-set 入队路径）。
  await page.evaluate(async () => {
    const { dbV7, updateQuestionV7 } = await import(["/exam-study-app/src/lib/db", "db-v7.ts"].join("/"));
    const question = await dbV7.questions.orderBy("id").first();
    if (!question) throw new Error("题库为空，无法制造同步事件");
    await updateQuestionV7(question.id, { favorite: !question.favorite });
  });
  // 抽屉内点「立即同步」（外部同步路径），完成后抽屉面板与同步页面板都必须立即更新。
  await page.locator(".sync-queue-trigger").click();
  await page.locator(".sync-event-drawer").waitFor({ state: "visible" });
  await page.locator(".sync-event-drawer .sync-event-manager-actions button").click();
  await helpers.expectNotice(page, /v9 同步完成/, "drawer quick sync notice");
  await page.waitForTimeout(600);
  const drawerPanel = await readPanel(".sync-event-drawer .sync-hot-window");
  harness.assert.ok(drawerPanel, "抽屉面板应在同步后存在");
  harness.assert.ok(parseGeneration(drawerPanel.generation) > parseGeneration(before.generation), `抽屉当前头应前进（${before.generation} → ${drawerPanel.generation}）`);
  harness.assert.match(drawerPanel.lastSync ?? "", /^\d{2}\/\d{2} \d{2}:\d{2}$/, `上次同步应显示本地上次成功同步时间（实际 ${drawerPanel.lastSync}）`);
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
  harness.assert.ok(parseGeneration(after.generation) > parseGeneration(before.generation), `外部快速同步后同步页面板也应及时前进（${before.generation} → ${after.generation}）`);
  await helpers.capture(page, contextName, "sync-panel-fresh");
}
