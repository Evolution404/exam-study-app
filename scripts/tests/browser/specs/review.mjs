import * as harness from "../harness.mjs";
import * as helpers from "../helpers.mjs";

export async function runReviewRounds(page) {
  const contextName = "review";
  await page.goto(`${harness.baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await helpers.importFixture(page);
  await helpers.expectText(page, "送电线路工-初级工");
  await helpers.setPracticePreferences(page, { autoNextCorrect: false, shuffleOptions: false });

  // 复习轮次挂在「配置」的「出题与复习」卡片
  await helpers.clickButton(page, "配置");
  await helpers.expectText(page, "答题配置");
  const managerHeading = page.getByRole("heading", { name: "命名并追踪复习轮次" });
  await managerHeading.scrollIntoViewIfNeeded();
  await helpers.expectText(page, "还没有复习轮次");
  // 复习轮次卡片宽度应与配置页其他卡片一致（不窄于 preference-card）
  const roundWidth = await page.locator(".review-round-manager").evaluate((el) => el.getBoundingClientRect().width);
  const cardWidth = await page.locator(".preference-card").first().evaluate((el) => el.getBoundingClientRect().width);
  harness.assert.ok(Math.abs(roundWidth - cardWidth) <= 1, `复习轮次宽度(${roundWidth}px)应与配置卡片一致(${cardWidth}px)`);
  await helpers.capture(page, contextName, "review-round-empty");

  // 新建轮次：命名 + 选择题库
  await helpers.clickTextButton(page, "新建轮次");
  const editor = page.locator(".review-round-editor");
  await editor.waitFor({ state: "visible" });
  await helpers.expectText(page, "命名复习轮次");
  await editor.locator(".review-round-name-field input").fill("春季第一轮");
  await editor.locator(".review-round-bank-picker label").filter({ hasText: "送电线路工-初级工" }).click();
  await helpers.clickTextButton(page, "保存轮次");
  await helpers.expectNotice(page, /已创建复习轮次「春季第一轮」/, "review round create notice");
  const roundCard = page.locator(".review-round-card").filter({ hasText: "春季第一轮" }).first();
  await roundCard.waitFor({ state: "visible" });
  const metricsText = await roundCard.locator(".review-round-metrics").innerText();
  harness.assert.match(metricsText, /5/, "created round must show the fixture bank question count");
  harness.assert.match(metricsText, /0/, "created round must start at zero completed");
  await helpers.capture(page, contextName, "review-round-created");

  // 编辑轮次：改名 + 调整范围
  await roundCard.getByRole("button", { name: "编辑范围" }).click();
  await editor.waitFor({ state: "visible" });
  await helpers.expectText(page, "调整轮次范围");
  await editor.locator(".review-round-name-field input").fill("春季第一轮-改");
  await helpers.clickTextButton(page, "保存轮次");
  await helpers.expectNotice(page, /复习轮次已更新/, "review round update notice");
  await page.locator(".review-round-card").filter({ hasText: "春季第一轮-改" }).first().waitFor({ state: "visible" });

  // 绑定轮次发起练习（复习轮次选择器自动选中轮次题库）
  await helpers.clickButton(page, "练习");
  await helpers.expectText(page, "练习中心");
  const roundSelect = page.getByLabel("复习轮次");
  await roundSelect.scrollIntoViewIfNeeded();
  await roundSelect.click();
  await page.getByRole("option", { name: /春季第一轮/ }).click();
  await page.waitForFunction(() => {
    const bank = [...document.querySelectorAll(".scope-bank-list button")].find((button) => button.textContent?.includes("送电线路工-初级工"));
    return bank?.getAttribute("aria-pressed") === "true";
  }, undefined, { timeout: 5_000 });
  await helpers.clickTextButton(page, "全量顺序练习");
  await page.locator(".question-card").waitFor({ state: "visible" });
  await helpers.answerCurrentQuestion(page, [0]);
  await helpers.expectText(page, "回答正确");
  await helpers.capture(page, contextName, "review-round-practice");
  await helpers.clickButton(page, "暂停并返回首页");
  await helpers.expectText(page, "继续上次练习");

  // 提前结束轮次（两次确认）→ 已完成 + 最终快照
  await helpers.clickButton(page, "配置");
  await helpers.expectText(page, "答题配置");
  await managerHeading.scrollIntoViewIfNeeded();
  const updatedCard = page.locator(".review-round-card").filter({ hasText: "春季第一轮-改" }).first();
  await updatedCard.getByRole("button", { name: "提前结束轮次" }).click();
  await helpers.expectText(page, "再次确认结束");
  await updatedCard.getByRole("button", { name: "再次确认结束" }).click();
  await helpers.expectNotice(page, /复习轮次已完成并保存最终快照/, "review round complete notice");
  await updatedCard.locator(".review-round-status.completed").waitFor({ state: "visible" });
  harness.assert.match(await updatedCard.locator(".review-round-snapshot").innerText(), /结束时共 5 道题/, "completed round must freeze the final snapshot");
  await helpers.capture(page, contextName, "review-round-completed");

  // 归档 → 卡片消失回到空态
  await updatedCard.getByRole("button", { name: "归档" }).click();
  await helpers.expectNotice(page, /复习轮次已归档/, "review round archive notice");
  await page.locator(".review-round-card").waitFor({ state: "detached" });
  await helpers.expectText(page, "还没有复习轮次");
  await helpers.capture(page, contextName, "review-round-archived");
}
