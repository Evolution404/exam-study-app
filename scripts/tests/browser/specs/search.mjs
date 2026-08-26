import * as harness from "../harness.mjs";
import * as helpers from "../helpers.mjs";
import * as fixtures from "../fixtures.mjs";
import * as searchPin from "./search-pin.mjs";

export async function runSearchBatch(page) {
  const contextName = "search";
  await page.goto(`${harness.baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await helpers.importFixture(page);
  await helpers.expectText(page, "送电线路工-初级工");
  await helpers.setPracticePreferences(page, { autoNextCorrect: false, shuffleOptions: false });

  // 关键词搜索 + 题型标签
  await helpers.clickButton(page, "进入搜索主页");
  await helpers.expectText(page, "搜索题库");
  const contentScopeTrigger = page.getByLabel("搜索内容范围");
  harness.assert.equal(await page.locator('select[aria-label="搜索内容范围"]').count(), 0, "search page scope must not use the native select menu");
  harness.assert.ok(await contentScopeTrigger.evaluate((element) => element.classList.contains("app-select-trigger")), "search page scope must use the shared custom trigger");
  await page.getByLabel("搜索题库").fill("巡视");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await helpers.expectText(page, /“巡视”找到 \d+ 道题/);
  await helpers.capture(page, contextName, "search-results");
  // 内容范围必须真正限制匹配字段：该词只在第二题选项中出现，题干范围不得命中。
  await page.getByLabel("搜索题库").fill("按规程");
  await contentScopeTrigger.click();
  await page.getByRole("option", { name: "选项", exact: true }).click();
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await helpers.expectText(page, /“按规程”找到 1 道题/);
  await contentScopeTrigger.click();
  await page.getByRole("option", { name: "题干", exact: true }).click();
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await helpers.expectText(page, /“按规程”找到 0 道题/);
  await contentScopeTrigger.click();
  await page.getByRole("option", { name: "全部", exact: true }).click();
  await page.getByLabel("搜索题库").fill("巡视");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await helpers.expectText(page, /“巡视”找到 \d+ 道题/);
  // 吸附几何：搜索框钉顶、批量栏紧贴、全局顶栏滚走（桌面）。
  // 导入加长题库 + 清空关键词做条件搜索，让列表足够长以保证真正吸顶。
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.bigFixtureFile);
  await page.waitForTimeout(600);
  // 导入可能把视图带回首页，重新进入搜索页。
  if (await page.locator(".search-page").count() === 0) {
    await helpers.clickButton(page, "进入搜索主页");
    await helpers.expectText(page, "搜索题库");
  }
  await page.getByLabel("搜索题库").fill("");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await helpers.expectText(page, /条件搜索找到 \d+ 道题/);
  await helpers.assertActionButtonRow(page, ".search-batch-bar", { minHeight: 36, maxHeight: 36 });
  await searchPin.assertSearchPinGeometry(page, "desktop", { requireScroll: true });
  // 恢复关键词搜索，后续详情导航依赖“巡视”结果集与排序。
  await page.getByLabel("搜索题库").fill("巡视");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await helpers.expectText(page, /“巡视”找到 \d+ 道题/);
  await page.locator(".search-type-tabs button").filter({ hasText: "单选" }).click();
  harness.assert.equal(await page.locator(".search-result-list article").count(), 1, "single-choice tab must narrow the results");
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
  await helpers.expectNotice(page, /已收藏这道题/, "detail favorite notice");
  await page.keyboard.press("Escape");
  await detail.waitFor({ state: "hidden" });
  await helpers.capture(page, contextName, "search-detail-esc");

  // 批量：收藏所选 + 批量添加标签
  await helpers.clickButton(page, "进入搜索主页");
  await helpers.expectText(page, "搜索题库");
  // 离开搜索视图会清空 query，重新进入需重新输入关键词
  await page.getByLabel("搜索题库").fill("巡视");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const checkboxes = page.locator(".search-result-list .result-checkbox input");
  harness.assert.ok(await checkboxes.count() >= 2, "expected at least two search results for batch operations");
  await checkboxes.nth(0).check({ force: true });
  await checkboxes.nth(1).check({ force: true });
  await helpers.expectText(page, "已选择 2 道");
  await helpers.clickTextButton(page, "收藏所选");
  await helpers.expectNotice(page, /已收藏 \d+ 道题/, "batch favorite notice");
  await page.locator(".batch-tag input").fill("易混");
  await helpers.clickTextButton(page, "添加");
  await helpers.expectNotice(page, /已给 2 道题添加标签“易混”/, "batch tag notice");
  await helpers.capture(page, contextName, "search-batch-ops");

  // 练习已选 → 起手 2 题
  const practiceDialog = page.getByRole("dialog", { name: "搜索练习配置" });
  await helpers.clickTextButton(page, "练习已选");
  await practiceDialog.waitFor({ state: "visible" });
  await helpers.expectText(page, /共有 \d+ 道可练题目/);
  await practiceDialog.getByRole("button", { name: /开始练习/ }).click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await helpers.waitForQuestion(page, 1, 2);
  await helpers.answerCurrentQuestion(page, [1]);
  await helpers.clickButton(page, "暂停并返回首页");
  await helpers.expectText(page, "继续上次练习");

  // 练习全部结果
  await helpers.clickButton(page, "进入搜索主页");
  await helpers.expectText(page, "搜索题库");
  // 离开搜索视图会清空 query，重新进入需重新输入关键词
  await page.getByLabel("搜索题库").fill("巡视");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const allCheckboxes = page.locator(".search-result-list .result-checkbox input");
  await allCheckboxes.nth(0).check({ force: true });
  await allCheckboxes.nth(1).check({ force: true });
  await helpers.clickTextButton(page, "练习全部结果");
  await practiceDialog.waitFor({ state: "visible" });
  await helpers.expectText(page, /共有 \d+ 道可练题目/);
  await practiceDialog.getByRole("button", { name: /开始练习/ }).click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await helpers.waitForQuestion(page, 1, 3);
  await helpers.capture(page, contextName, "search-practice-all");
  await helpers.clickButton(page, "暂停并返回首页");
  await helpers.expectText(page, "继续上次练习");

  // 加入题组 → 题组编辑器预填 + 上/下移排序（拖拽排序的替代覆盖）
  await helpers.clickButton(page, "进入搜索主页");
  await helpers.expectText(page, "搜索题库");
  // 离开搜索视图会清空 query，重新进入需重新输入关键词
  await page.getByLabel("搜索题库").fill("巡视");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const lastCheckboxes = page.locator(".search-result-list .result-checkbox input");
  await lastCheckboxes.nth(0).check({ force: true });
  await lastCheckboxes.nth(1).check({ force: true });
  await helpers.clickTextButton(page, "加入题组");
  await helpers.expectText(page, "新建题组");
  const groupItems = page.locator(".group-items article");
  harness.assert.equal(await groupItems.count(), 2, "加入题组 must prefill the two selected questions");
  const firstStem = await groupItems.first().innerText();
  const firstHandle = groupItems.first().locator(".group-drag");
  const secondHandle = groupItems.nth(1).locator(".group-drag");
  const firstBox = await firstHandle.boundingBox();
  const secondBox = await secondHandle.boundingBox();
  harness.assert.ok(firstBox && secondBox, "拖动前两个题组项应可见");
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction((previous) => {
    const first = document.querySelector(".group-items article")?.innerText ?? "";
    return first.trim() !== previous;
  }, firstStem);
  await helpers.capture(page, contextName, "search-to-group");
}
