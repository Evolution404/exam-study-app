import * as harness from "../harness.mjs";
import * as helpers from "../helpers.mjs";

export async function runPracticeSetupComboQA(page) {
  const contextName = "practice-combo";
  await page.goto(`${harness.baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await helpers.importFixture(page);
  await helpers.setPracticePreferences(page, { autoNextCorrect: false, shuffleOptions: false, wrongRemovalStreak: 1 });

  // C. 「随机指定题数」卡片只填充三段（不立即开始），输入 99 越界 → 错误文案 + 开始按钮禁用。
  await helpers.clickButton(page, "练习");
  await helpers.expectText(page, "练习中心");
  await helpers.selectBankOnPracticeSetup(page);
  await helpers.clickTextButton(page, "随机指定题数");
  await page.getByRole("spinbutton", { name: "本次随机题数" }).fill("99");
  await helpers.expectText(page, "请输入 1–5 之间的题数");
  harness.assert.equal(await page.locator(".setup-footer > button.primary").isDisabled(), true, "越界自定义题数必须禁用开始按钮");
  await helpers.capture(page, contextName, "setup-custom-count-error");
  await page.getByRole("spinbutton", { name: "本次随机题数" }).fill("2");

  // 全量顺序练习答 5 题：Q1、Q2 各答错一次，Q3–Q5 答对（错题集合 = 2 道单选）。
  await helpers.clickTextButton(page, "全量顺序练习");
  await page.locator(".question-card").waitFor({ state: "visible" });
  await helpers.answerCurrentQuestion(page, [1]); // Q1 导线（单选 A）→ 错
  await helpers.expectText(page, "这次没有答对");
  await helpers.clickTextButton(page, "下一题");
  await helpers.waitForQuestion(page, 2, 5);
  await helpers.answerCurrentQuestion(page, [0]); // Q2 发现异常（单选 B）→ 错
  await helpers.expectText(page, "这次没有答对");
  await helpers.clickTextButton(page, "下一题");
  await helpers.waitForQuestion(page, 3, 5);
  await helpers.answerCurrentQuestion(page, [0, 1], true); // Q3 安全巡视（多选 AB）→ 对
  await helpers.expectText(page, "回答正确");
  await helpers.clickTextButton(page, "下一题");
  await helpers.waitForQuestion(page, 4, 5);
  await helpers.answerCurrentQuestion(page, [0]); // Q4 判断 → 对
  await helpers.expectText(page, "回答正确");
  await helpers.clickTextButton(page, "下一题");
  await helpers.waitForQuestion(page, 5, 5);
  await page.getByRole("spinbutton", { name: "第1空答案" }).fill("10");
  await page.getByRole("spinbutton", { name: "第2空答案" }).fill("20");
  await helpers.clickTextButton(page, "确认答案");
  await helpers.expectText(page, "回答正确");
  await helpers.clickButton(page, "暂停并返回首页");

  // A. 正交组合：出题范围=错题 × 顺序=随机 × 题量=全部 → 2 道错题的随机练习。
  // 不断言题目顺序：随机 = 题型分组内随机（TYPE_ORDER 语义），只保证恰好 2 道且都是错题口径。
  await helpers.clickButton(page, "练习");
  await helpers.expectText(page, "练习中心");
  await helpers.selectBankOnPracticeSetup(page);
  // 错题卡实时计数（liveQuery 异步重算，等到计数出现再断言）。
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll(".mode-grid button")].find((button) => button.textContent?.includes("练习错题"));
    return card?.textContent?.includes("当前口径下 2 道错题");
  }, undefined, { timeout: 10_000 });
  harness.assert.equal(await page.locator(".mode-grid button").filter({ hasText: "练习错题" }).isDisabled(), false, "有错题时错题卡必须可点击");
  await page.locator('.practice-segment-row[aria-label="出题范围"]').getByRole("button", { name: "错题", exact: true }).click();
  await page.locator('.practice-segment-row[aria-label="顺序"]').getByRole("button", { name: "随机", exact: true }).click();
  await page.locator('.practice-segment-row[aria-label="题量"]').getByRole("button", { name: "全部题目", exact: true }).click();
  await page.locator(".setup-footer > button.primary").click();
  await page.locator(".practice-progress span").filter({ hasText: /^1 \/ 2 · 错题/ }).waitFor({ state: "visible" });
  await helpers.capture(page, contextName, "combo-wrong-random");
  const stemsSeen = [];
  for (let answered = 0; answered < 2; answered += 1) {
    if (answered > 0) {
      // 进度条（同步 state）先于题目内容更新：activeQuestion 走 liveQuery 异步解析，
      // 等「2 / 2」出现时旧题卡可能仍挂在 DOM——必须等题干真正换成另一道题再读，
      // 否则会按上一题的答案点当前题（随机顺序下两题答案不同 → 判错）。
      await page.waitForFunction((previous) => {
        const text = document.querySelector(".practice-stem")?.textContent ?? "";
        return text.length > 0 && text !== previous;
      }, stemsSeen[stemsSeen.length - 1], { timeout: 10_000 });
    }
    const stem = await page.locator(".practice-stem").innerText();
    stemsSeen.push(stem);
    const optionIndexes = stem.includes("导线") ? [0] : [1]; // 导线→A 传输电能；发现异常→B 按流程记录
    await helpers.answerCurrentQuestion(page, optionIndexes);
    try {
      await helpers.expectText(page, "回答正确");
    } catch (error) {
      console.error(`[practice-combo] 作答未判正确：iteration=${answered} stem="${stem.slice(0, 40)}" indexes=[${optionIndexes.join(",")}]`);
      console.error(`[practice-combo] result-box="${(await page.locator(".result-box").innerText().catch(() => "<无>")).slice(0, 120)}"`);
      console.error(`[practice-combo] 进度="${await page.locator(".practice-progress span").innerText().catch(() => "<无>")}"`);
      await page.screenshot({ path: harness.path.join(harness.runRoot, `${Date.now()}-combo-answer-fail.png`), fullPage: true });
      throw error;
    }
    if (answered === 0) {
      await helpers.clickTextButton(page, "下一题");
      await helpers.waitForQuestion(page, 2, 2);
    }
  }
  await helpers.clickButton(page, "暂停并返回首页");

  // B. 连对移出：两道错题已各连对一次（wrongRemovalStreak=1）→ 错题卡计数归零并禁用。
  await helpers.clickButton(page, "练习");
  await helpers.expectText(page, "练习中心");
  await helpers.selectBankOnPracticeSetup(page);
  const wrongCard = page.locator(".mode-grid button").filter({ hasText: "练习错题" });
  await wrongCard.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll(".mode-grid button")].find((button) => button.textContent?.includes("练习错题"));
    return card instanceof HTMLButtonElement && card.disabled;
  }, undefined, { timeout: 10_000 });
  harness.assert.match(await wrongCard.innerText(), /当前口径下 0 道错题/, "错题卡计数应实时反映进度口径");
  await helpers.capture(page, contextName, "wrong-card-empty");
  // 组合路径同样无题可练：出题范围=错题 → 开始 → 空集提示。
  await page.locator('.practice-segment-row[aria-label="出题范围"]').getByRole("button", { name: "错题", exact: true }).click();
  await page.locator(".setup-footer > button.primary").click();
  await helpers.expectNotice(page, /没有符合当前条件的题目/, "连对移出后错题组合应无题可练（进度口径）");
}

// 练习进行中删除题目/题库的竞争状态：直接经页面内 import 数据层触发删除（等价后台同步拉取删除），
// 验证练习界面不会卡死或静默丢答案。
