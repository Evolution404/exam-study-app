import * as harness from "../harness.mjs";
import * as helpers from "../helpers.mjs";

export async function runHistoryResult(page) {
  const contextName = "history";
  await page.goto(`${harness.baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await helpers.importFixture(page);
  await helpers.expectText(page, "送电线路工-初级工");
  await helpers.setPracticePreferences(page, { autoNextCorrect: false, shuffleOptions: false });

  // 完成一次 5 题练习（第 2 题答错，其余答对 → 80%）
  await helpers.clickButton(page, "练习");
  await helpers.expectText(page, "练习中心");
  await helpers.selectBankOnPracticeSetup(page);
  await helpers.clickTextButton(page, "全量顺序练习");
  await page.locator(".question-card").waitFor({ state: "visible" });
  // 1 导线（单选 A）→ 对
  await helpers.answerCurrentQuestion(page, [0]);
  await helpers.expectText(page, "回答正确");
  await helpers.clickTextButton(page, "下一题");
  // 2 发现异常（单选 B）→ 答错
  await helpers.waitForQuestion(page, 2, 5);
  await helpers.answerCurrentQuestion(page, [0]);
  await helpers.expectText(page, "这次没有答对");
  await helpers.clickTextButton(page, "下一题");
  // 3 哪些做法（多选 AB）→ 对
  await helpers.waitForQuestion(page, 3, 5);
  await helpers.answerCurrentQuestion(page, [0, 1], true);
  await helpers.expectText(page, "回答正确");
  await helpers.clickTextButton(page, "下一题");
  // 4 巡视前（判断 A）→ 对
  await helpers.waitForQuestion(page, 4, 5);
  await helpers.answerCurrentQuestion(page, [0]);
  await helpers.expectText(page, "回答正确");
  await helpers.clickTextButton(page, "下一题");
  // 5 图片（计算 10、20）→ 对
  await helpers.waitForQuestion(page, 5, 5);
  await page.getByRole("spinbutton", { name: "第1空答案" }).fill("10");
  await page.getByRole("spinbutton", { name: "第2空答案" }).fill("20");
  await helpers.clickTextButton(page, "确认答案");
  await helpers.expectText(page, "回答正确");
  await helpers.clickTextButton(page, "查看本次结果");
  await helpers.expectText(page, "本次正确率");
  harness.assert.match(await page.locator(".result-score strong").innerText(), /^80/, "four correct of five answered must show 80% accuracy");
  await helpers.capture(page, contextName, "result-page");

  // 结果页选中题目以主色软背景作唯一反馈：按钮基础 border:0 无四周边框，边框/描边
  // 方案会同时改动顶边（inset 线）与底部分隔线成上下等宽绿边（用户否决），因此选中
  // 不得叠加边框或描边，且底部分隔线必须保持浅灰。
  const firstResultQuestion = page.locator(".result-question-groups button[aria-label^='查看第']").first();
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
  harness.assert.equal(detailHighlight.background, detailHighlight.expectSoftBg, "结果页选中题目用主色软背景作选中反馈");
  harness.assert.equal(detailHighlight.boxShadow, "none", "结果页选中不叠加边框/描边（底色已足够明显）");
  harness.assert.equal(detailHighlight.borderBottom, detailHighlight.expectSeparator, "结果页选中不得改动底部分隔线颜色（防止上下等宽绿边）");
  await page.getByRole("dialog", { name: "题目详情" }).getByRole("button", { name: "关闭题目详情" }).click();
  await page.getByRole("dialog", { name: "题目详情" }).waitFor({ state: "hidden" });
  await helpers.capture(page, contextName, "result-question-selected");

  // 结果筛选 + 只练本次错题
  await helpers.clickTextButton(page, "只看错题");
  harness.assert.equal(await page.locator(".result-question-groups button[aria-label^='查看第']").count(), 1, "wrong filter must narrow to the one wrong question");
  await helpers.clickTextButton(page, "全部题目");
  await helpers.capture(page, contextName, "result-filter-wrong");

  // 题目总览（与做题界面同款）：题号网格按题型分组，点击题号跳到该题详情。
  await page.locator(".result-filters .result-overview-trigger").click();
  await page.getByRole("dialog", { name: "题目总览" }).waitFor({ state: "visible" });
  harness.assert.equal(await page.locator(".question-overview .overview-number-grid button").count(), 5, "结果页总览应列出全部 5 题");
  await helpers.capture(page, contextName, "result-overview-open");
  await page.getByRole("button", { name: "第 2 题，单选" }).click();
  await page.getByRole("dialog", { name: "题目详情" }).waitFor({ state: "visible" });
  harness.assert.match(await page.getByRole("dialog", { name: "题目详情" }).innerText(), /发现异常/, "总览点击题号应打开对应题目详情");
  await page.getByRole("dialog", { name: "题目详情" }).getByRole("button", { name: "关闭题目详情" }).click();
  await page.getByRole("dialog", { name: "题目详情" }).waitFor({ state: "hidden" });
  await helpers.capture(page, contextName, "result-overview-jump");

  // 题型分组折叠：默认展开，点分组头折叠（列表隐藏），再点恢复。
  const singleGroupToggle = page.locator(".result-question-groups .result-group-toggle").first();
  harness.assert.equal(await singleGroupToggle.getAttribute("aria-expanded"), "true", "题型分组默认展开");
  await singleGroupToggle.click();
  harness.assert.equal(await singleGroupToggle.getAttribute("aria-expanded"), "false", "点击分组头应折叠");
  harness.assert.equal(await page.locator(".result-question-groups section").first().locator("div>button").count(), 0, "折叠后该组题目列表应整体隐藏");
  await helpers.capture(page, contextName, "result-group-collapse");
  await singleGroupToggle.click();
  harness.assert.equal(await page.locator(".result-question-groups section").first().locator("div>button").count(), 2, "再次点击应恢复该组题目（单选 2 题）");

  await helpers.clickTextButton(page, "只练本次错题");
  await page.locator(".question-card").waitFor({ state: "visible" });
  await helpers.waitForQuestion(page, 1, 1);
  await helpers.answerCurrentQuestion(page, [1]);
  await helpers.expectText(page, "回答正确");
  await helpers.clickTextButton(page, "查看本次结果");
  await helpers.expectText(page, "本次正确率");
  await helpers.capture(page, contextName, "result-repeat-wrong");
  await helpers.clickTextButton(page, "返回练习记录");

  // 练习记录：已完成 tab
  await page.locator(".history-filters button").filter({ hasText: /已完成/ }).click();
  await page.locator(".history-list article .run-status").filter({ hasText: "已完成" }).first().waitFor({ state: "visible" });
  await helpers.capture(page, contextName, "history-completed");

  // 进行中 → 继续练习 → 放弃 → 删除
  await page.locator(".practice-hub-tabs button").filter({ hasText: "开始练习" }).click();
  await helpers.selectBankOnPracticeSetup(page);
  await helpers.clickTextButton(page, "随机指定题数");
  await page.getByRole("spinbutton", { name: "本次随机题数" }).fill("2");
  await page.locator(".setup-footer > button.primary").click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await helpers.clickButton(page, "暂停并返回首页");
  await helpers.expectText(page, "继续上次练习");
  await helpers.clickButton(page, "练习");
  await helpers.expectText(page, "练习中心");
  await page.locator(".practice-hub-tabs button").filter({ hasText: "练习记录" }).click();
  await helpers.expectText(page, "练习记录");
  const inProgressTab = page.locator(".history-filters button").filter({ hasText: /进行中/ });
  await inProgressTab.click();
  const inProgressRun = page.locator(".history-list article").first();
  await inProgressRun.waitFor({ state: "visible" });
  await helpers.capture(page, contextName, "history-in-progress");
  await inProgressRun.getByRole("button", { name: "继续练习" }).click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await helpers.clickButton(page, "暂停并返回首页");
  await helpers.expectText(page, "继续上次练习");
  await helpers.clickButton(page, "练习");
  await page.locator(".practice-hub-tabs button").filter({ hasText: "练习记录" }).click();
  await inProgressTab.click();
  const resumedRun = page.locator(".history-list article").first();
  await resumedRun.waitFor({ state: "visible" });
  await resumedRun.getByRole("button", { name: "放弃练习" }).click();
  await helpers.expectNotice(page, /已放弃这次练习，记录仍会保留/, "abandon run notice");
  await page.locator(".history-filters button").filter({ hasText: /已放弃/ }).click();
  await page.locator(".history-list article .run-status").filter({ hasText: "已放弃" }).first().waitFor({ state: "visible" });
  await helpers.capture(page, contextName, "history-abandoned");
  // 删除按钮平时被 swipe-content 覆盖（需先滑动暴露）——用 dispatchEvent 直接触发其
  // 点击处理器作为替代（滑动手势见 docs/TESTING.md 已知限制）。
  await page.locator(".history-list article .history-delete-action").first().dispatchEvent("click");
  await helpers.expectNotice(page, /练习记录已删除，并加入同步队列/, "delete record notice");
  await helpers.expectText(page, "这里还没有记录");
  await helpers.capture(page, contextName, "history-deleted");

  // 排序口径：X 先开始、只答 1 题暂停；Y 开始更晚但先完整完成；随后续答 X。
  // 旧口径（按开始时间）Y 在前；新口径（最后活动时间）续答过的 X 必须在最前。
  await helpers.clickButton(page, "练习");
  await helpers.expectText(page, "练习中心");
  await helpers.selectBankOnPracticeSetup(page);
  await helpers.clickTextButton(page, "全量顺序练习");
  await page.locator(".question-card").waitFor({ state: "visible" });
  await helpers.answerCurrentQuestion(page, [0]);
  await helpers.expectText(page, "回答正确");
  await helpers.clickButton(page, "暂停并返回首页");
  await helpers.expectText(page, "继续上次练习");
  // Y：完整答完 5 题 → 已完成，完成时间早于 X 的续答。
  await helpers.clickButton(page, "练习");
  await helpers.selectBankOnPracticeSetup(page);
  await helpers.clickTextButton(page, "全量顺序练习");
  await page.locator(".question-card").waitFor({ state: "visible" });
  await helpers.answerCurrentQuestion(page, [0]);
  await helpers.expectText(page, "回答正确");
  await helpers.clickTextButton(page, "下一题");
  await helpers.waitForQuestion(page, 2, 5);
  await helpers.answerCurrentQuestion(page, [1]);
  await helpers.expectText(page, "回答正确");
  await helpers.clickTextButton(page, "下一题");
  await helpers.waitForQuestion(page, 3, 5);
  await helpers.answerCurrentQuestion(page, [0, 1], true);
  await helpers.expectText(page, "回答正确");
  await helpers.clickTextButton(page, "下一题");
  await helpers.waitForQuestion(page, 4, 5);
  await helpers.answerCurrentQuestion(page, [0]);
  await helpers.expectText(page, "回答正确");
  await helpers.clickTextButton(page, "下一题");
  await helpers.waitForQuestion(page, 5, 5);
  await page.getByRole("spinbutton", { name: "第1空答案" }).fill("10");
  await page.getByRole("spinbutton", { name: "第2空答案" }).fill("20");
  await helpers.clickTextButton(page, "确认答案");
  await helpers.expectText(page, "回答正确");
  await helpers.clickTextButton(page, "查看本次结果");
  await helpers.expectText(page, "本次正确率");
  await helpers.clickTextButton(page, "返回练习记录");
  // 续答 X 的第 2 题 → X 的最后活动时间晚于 Y 的完成时间。
  await page.locator(".history-filters button").filter({ hasText: /进行中/ }).click();
  const suspendedRun = page.locator(".history-list article").first();
  await suspendedRun.getByRole("button", { name: "继续练习" }).click();
  await page.locator(".question-card").waitFor({ state: "visible" });
  await helpers.waitForQuestion(page, 2, 5);
  await helpers.answerCurrentQuestion(page, [1]);
  await helpers.expectText(page, "回答正确");
  await helpers.clickButton(page, "暂停并返回首页");
  await helpers.expectText(page, "继续上次练习");
  await helpers.clickButton(page, "练习");
  await page.locator(".practice-hub-tabs button").filter({ hasText: "练习记录" }).click();
  await helpers.expectText(page, "练习记录");
  await page.locator(".history-filters button").filter({ hasText: /全部/ }).click();
  const firstHistoryCard = page.locator(".history-list article").first();
  await firstHistoryCard.locator(".run-status").filter({ hasText: "进行中" }).waitFor({ state: "visible" });
  harness.assert.match(await firstHistoryCard.locator(".history-metrics span").first().innerText(), /2 \/ 5/, "记录排序应按最后活动时间：续答过的旧练习（X）必须排在后完成的记录（Y）之前");
  await helpers.capture(page, contextName, "history-activity-order");
}

// ===== 练习中心「快捷卡片 + 正交组合」重构回归 =====
// A. 错题 × 随机组合（旧 UI 的 mode 写死顺序，做不出这个组合）；
// B. 连对移出错题端到端（错题跟随进度口径，wrongRemovalStreak=1 时答对一次即移出）；
// C. 自定义题数越界 → 错误文案 + 开始按钮禁用。
