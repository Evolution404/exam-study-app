import * as harness from "../harness.mjs";
import * as helpers from "../helpers.mjs";

async function readStandardActionLayout(page) {
  return page.locator(".practice-actions > div").evaluate((row) => {
    const rowRect = row.getBoundingClientRect();
    const visibleChildren = Array.from(row.children)
      .filter((child) => child instanceof HTMLElement && getComputedStyle(child).display !== "none")
      .map((child) => {
        const rect = child.getBoundingClientRect();
        return { text: child.textContent?.trim() ?? "", left: rect.left, right: rect.right, width: rect.width };
      });
    const hint = row.querySelector(".answer-action-hint");
    const hintRect = hint instanceof HTMLElement ? hint.getBoundingClientRect() : null;
    const hintStyle = hint instanceof HTMLElement ? getComputedStyle(hint) : null;
    return {
      clientWidth: row.clientWidth,
      scrollWidth: row.scrollWidth,
      left: rowRect.left,
      right: rowRect.right,
      visibleChildren,
      hint: hintRect && hintStyle ? {
        text: hint?.textContent?.trim() ?? "",
        width: hintRect.width,
        height: hintRect.height,
        fontSize: Number.parseFloat(hintStyle.fontSize),
      } : null,
    };
  });
}

function assertStandardActionLayout(layout, label) {
  harness.assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `${label} 操作区不得横向溢出`);
  const overflow = layout.visibleChildren
    .filter((item) => item.left < layout.left - 1 || item.right > layout.right + 1)
    .map((item) => item.text);
  harness.assert.deepEqual(overflow, [], `${label} 每个操作项都必须保持在动作行内`);
}

async function installPracticeFrameAudit(page) {
  await page.evaluate(() => {
    const audit = { blankFrames: 0, mismatchedFrames: [], samples: [] };
    const sample = () => {
      const progress = document.querySelector(".practice-progress span");
      if (!(progress instanceof HTMLElement)) return;
      const cards = document.querySelectorAll(".question-card");
      if (cards.length !== 1) {
        audit.blankFrames += cards.length === 0 ? 1 : 0;
        audit.mismatchedFrames.push(`card-count:${cards.length}`);
        return;
      }
      const card = cards[0];
      const index = Number(card.getAttribute("data-question-index"));
      const match = progress.textContent?.trim().match(/^(\d+)\s*\//);
      if (!match || Number(match[1]) !== index + 1) audit.mismatchedFrames.push(`index:${index}:progress:${progress.textContent?.trim() ?? ""}`);
      audit.samples.push({ id: card.getAttribute("data-question-id"), index, stem: document.querySelector(".practice-stem")?.textContent?.trim() ?? "" });
    };
    sample();
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-question-id", "data-question-index", "data-transition-pending"] });
    window.__practiceFrameAudit = { audit, observer };
  });
}

async function readPracticeFrameAudit(page) {
  return page.evaluate(() => {
    window.__practiceFrameAudit?.observer.disconnect();
    return window.__practiceFrameAudit?.audit ?? { blankFrames: 0, mismatchedFrames: [], samples: [] };
  });
}

async function assertDisplayedFrameMatchesRun(page) {
  const dbModuleUrl = new URL("/src/lib/db/db-v7.ts", harness.baseUrl).href;
  const result = await page.evaluate(async ({ dbModuleUrl }) => {
    const card = document.querySelector(".question-card");
    if (!(card instanceof HTMLElement)) return { ok: false, reason: "missing-card" };
    const index = Number(card.dataset.questionIndex);
    const questionId = card.dataset.questionId;
    const { dbV7, getPracticeRunV7 } = await import(dbModuleUrl);
    const records = await dbV7.practiceRuns.where("status").equals("in_progress").toArray();
    const record = records.sort((left, right) => left.activityAt.localeCompare(right.activityAt)).at(-1);
    const run = record ? await getPracticeRunV7(record.id) : undefined;
    return {
      ok: Boolean(run && Number.isInteger(index) && questionId && run.questionIds[index] === questionId),
      index,
      questionId,
      expectedQuestionId: run?.questionIds[index],
    };
  }, { dbModuleUrl });
  harness.assert.equal(result.ok, true, `displayed practice frame must match practiceRun.questionIds[index]: ${JSON.stringify(result)}`);
}

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
  await installPracticeFrameAudit(page);
  const immediateActionLayout = await readStandardActionLayout(page);
  assertStandardActionLayout(immediateActionLayout, "单选立即判定");
  harness.assert.equal(immediateActionLayout.hint?.text, "选择答案后立即判定", "单选立即判定提示必须存在");
  harness.assert.ok(Boolean(immediateActionLayout.hint), "单选立即判定提示必须可测量");
  harness.assert.ok((immediateActionLayout.hint?.height ?? Number.POSITIVE_INFINITY) <= (immediateActionLayout.hint?.fontSize ?? 0) * 2, "单选立即判定提示必须保持单行，不能被下一题按钮挤成竖排");
  const immediateNext = immediateActionLayout.visibleChildren.find((item) => item.text.includes("下一题"));
  harness.assert.ok(Boolean(immediateNext) && (immediateNext?.width ?? Number.POSITIVE_INFINITY) < 180, "标准练习的下一题按钮必须保持内容宽度，不能占满动作行");
  await helpers.answerCurrentQuestion(page, [1]); // Q1 导线（单选 A）→ 错
  await helpers.expectText(page, "这次没有答对");
  await helpers.clickTextButton(page, "下一题");
  await helpers.waitForQuestion(page, 2, 5);
  await assertDisplayedFrameMatchesRun(page);
  await helpers.answerCurrentQuestion(page, [0]); // Q2 发现异常（单选 B）→ 错
  await helpers.expectText(page, "这次没有答对");
  await helpers.clickTextButton(page, "下一题");
  await helpers.waitForQuestion(page, 3, 5);
  await assertDisplayedFrameMatchesRun(page);
  const multiSelectActionLayout = await readStandardActionLayout(page);
  assertStandardActionLayout(multiSelectActionLayout, "多选手动确认");
  harness.assert.ok(multiSelectActionLayout.visibleChildren.some((item) => item.text.includes("确认答案")), "多选题必须保留确认答案操作");
  harness.assert.ok(multiSelectActionLayout.visibleChildren.some((item) => item.text.includes("下一题")), "多选题必须保留下一题操作");
  await helpers.answerCurrentQuestion(page, [0, 1], true); // Q3 安全巡视（多选 AB）→ 对
  await helpers.expectText(page, "回答正确");
  await helpers.clickTextButton(page, "下一题");
  await helpers.waitForQuestion(page, 4, 5);
  await assertDisplayedFrameMatchesRun(page);
  await helpers.answerCurrentQuestion(page, [0]); // Q4 判断 → 对
  await helpers.expectText(page, "回答正确");
  await helpers.clickTextButton(page, "下一题");
  await helpers.waitForQuestion(page, 5, 5);
  await assertDisplayedFrameMatchesRun(page);
  const frameAudit = await readPracticeFrameAudit(page);
  harness.assert.equal(frameAudit.blankFrames, 0, "连续切题过程中不得出现 question-card 空白帧");
  harness.assert.deepEqual(frameAudit.mismatchedFrames, [], "切题过程中进度题号必须与 displayed practice frame 的 index 原子一致");
  harness.assert.ok(frameAudit.samples.every((sample) => sample.id && sample.stem), "切题帧必须始终同时具备题目 ID 与题干内容");
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

  // 快速连续切题：允许用户很快连续发出导航意图，但 displayed frame 在异步
  // Dexie 查询交接期间必须始终是一个完整快照，不能显示旧题配新题号。
  await helpers.clickTextButton(page, "全量顺序练习");
  await page.locator(".question-card").waitFor({ state: "visible" });
  await installPracticeFrameAudit(page);
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("下一题"));
    if (!(button instanceof HTMLButtonElement)) throw new Error("rapid navigation next button missing");
    button.click();
    button.click();
  });
  await helpers.waitForQuestion(page, 3, 5);
  await assertDisplayedFrameMatchesRun(page);
  const rapidAudit = await readPracticeFrameAudit(page);
  harness.assert.equal(rapidAudit.blankFrames, 0, "快速连续切题不得出现空白 question-card");
  harness.assert.deepEqual(rapidAudit.mismatchedFrames, [], "快速连续切题不得出现旧题内容与新题号错配");
}

// 练习进行中删除题目/题库的竞争状态：直接经页面内 import 数据层触发删除（等价后台同步拉取删除），
// 验证练习界面不会卡死或静默丢答案。
