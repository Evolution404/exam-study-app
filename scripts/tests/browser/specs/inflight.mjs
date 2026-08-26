import * as harness from "../harness.mjs";
import * as helpers from "../helpers.mjs";

export async function runInFlightDeletionQA(page) {
  const contextName = "inflight";
  await page.goto(`${harness.baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await helpers.importFixture(page);
  await helpers.setPracticePreferences(page, { autoNextCorrect: false, shuffleOptions: false });

  // 开启全量顺序练习
  await helpers.clickButton(page, "练习");
  await helpers.expectText(page, "练习中心");
  await helpers.selectBankOnPracticeSetup(page);
  await helpers.clickTextButton(page, "全量顺序练习");
  await page.locator(".question-card").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  const firstStem = (await page.locator(".practice-stem").innerText()).trim();

  // S1.1a：删除「当前题」→ 自动跳过到下一道存活题（skip-effect）
  const currentId = await page.evaluate(async (stemText) => {
    const { dbV7 } = await import(["/exam-study-app/src/lib/db", "db-v7.ts"].join("/"));
    const all = await dbV7.questions.toArray();
    const hit = all.find((q) => q.content.some((b) => b.type === "text" && b.text === stemText));
    return hit ? hit.id : null;
  }, firstStem);
  harness.assert.ok(currentId, "应能定位当前题 id");
  await page.evaluate(async (id) => {
    const { deleteQuestionsV7 } = await import(["/exam-study-app/src/lib/db", "db-v7.ts"].join("/"));
    await deleteQuestionsV7([id]);
  }, currentId);
  await helpers.expectNotice(page, /题目已删除，自动跳过/, "delete-current-question skip notice");
  await page.waitForTimeout(400);
  const nextStem = (await page.locator(".practice-stem").innerText()).trim();
  harness.assert.notEqual(nextStem, firstStem, "删除当前题后应前进到下一道存活题");
  await helpers.capture(page, contextName, "skipped-current-question");

  // S1.1b：一次性删除剩余全部题 → 优雅结束进结果页（练习中题目被删光）
  await page.evaluate(async () => {
    const { dbV7, deleteQuestionsV7 } = await import(["/exam-study-app/src/lib/db", "db-v7.ts"].join("/"));
    const all = await dbV7.questions.toArray();
    await deleteQuestionsV7(all.map((q) => q.id));
  });
  await helpers.expectNotice(page, /练习中的题目已被删除，本次练习结束/, "all-questions-deleted end notice");
  await page.locator(".run-result").waitFor({ state: "visible" });
  await helpers.capture(page, contextName, "ended-all-deleted");

  // S1.3：新开一次练习，删除其题库 → run 行被硬删，练习会话应被置空并提示（E3 修复，避免幽灵会话丢答案）
  // 上一段已删光全部题目，这里重新导入题库以恢复可练题目。
  await helpers.importFixture(page);
  await helpers.clickButton(page, "练习");
  await helpers.expectText(page, "练习中心");
  await helpers.selectBankOnPracticeSetup(page);
  await helpers.clickTextButton(page, "全量顺序练习");
  await page.locator(".question-card").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  const bankId = await page.evaluate(async () => {
    const { dbV7 } = await import(["/exam-study-app/src/lib/db", "db-v7.ts"].join("/"));
    const bank = (await dbV7.banks.toArray())[0];
    return bank?.id;
  });
  harness.assert.ok(bankId, "应能定位练习题库 id");
  await page.evaluate(async (id) => {
    const { deleteBankV7 } = await import(["/exam-study-app/src/lib/db", "db-v7.ts"].join("/"));
    await deleteBankV7(id);
  }, bankId);
  await helpers.expectNotice(page, /题库已被删除|练习已结束/, "bank-deleted-during-practice notice (E3)");
  await page.waitForTimeout(400);
  harness.assert.equal(await page.locator(".question-card").isVisible(), false, "删除题库后应离开练习界面（无幽灵会话）");
  await helpers.capture(page, contextName, "bank-deleted-no-phantom");
}
