import * as harness from "../harness.mjs";
import * as helpers from "../helpers.mjs";

export async function runInFlightDeletionQA(page) {
  const contextName = "inflight";
  const dbModuleUrl = new URL("/src/lib/db/db.ts", harness.baseUrl).href;
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
  const currentId = await page.evaluate(async ({ stemText, dbModuleUrl }) => {
    const { studyDb } = await import(dbModuleUrl);
    const all = await studyDb.questions.toArray();
    const hit = all.find((q) => q.content.some((b) => b.type === "text" && b.text === stemText));
    return hit ? hit.id : null;
  }, { stemText: firstStem, dbModuleUrl });
  harness.assert.ok(currentId, "应能定位当前题 id");
  await page.evaluate(async ({ id, dbModuleUrl }) => {
    const { deleteQuestions } = await import(dbModuleUrl);
    await deleteQuestions([id]);
  }, { id: currentId, dbModuleUrl });
  await helpers.expectNotice(page, /题目已删除，自动跳过/, "delete-current-question skip notice");
  await page.waitForTimeout(400);
  const nextStem = (await page.locator(".practice-stem").innerText()).trim();
  harness.assert.notEqual(nextStem, firstStem, "删除当前题后应前进到下一道存活题");
  await helpers.capture(page, contextName, "skipped-current-question");

  // S1.1b：一次性删除剩余全部题 → 优雅结束进结果页（练习中题目被删光）
  await page.evaluate(async (dbModuleUrl) => {
    const { studyDb, deleteQuestions } = await import(dbModuleUrl);
    const all = await studyDb.questions.toArray();
    await deleteQuestions(all.map((q) => q.id));
  }, dbModuleUrl);
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
  const bankId = await page.evaluate(async (dbModuleUrl) => {
    const { studyDb } = await import(dbModuleUrl);
    const bank = (await studyDb.banks.toArray())[0];
    return bank?.id;
  }, dbModuleUrl);
  harness.assert.ok(bankId, "应能定位练习题库 id");
  await page.evaluate(async ({ id, dbModuleUrl }) => {
    const { deleteBank } = await import(dbModuleUrl);
    await deleteBank(id);
  }, { id: bankId, dbModuleUrl });
  await helpers.expectNotice(page, /题库已被删除|练习已结束/, "bank-deleted-during-practice notice (E3)");
  await page.waitForTimeout(400);
  harness.assert.equal(await page.locator(".question-card").isVisible(), false, "删除题库后应离开练习界面（无幽灵会话）");
  await helpers.capture(page, contextName, "bank-deleted-no-phantom");

  // S1.4：上一条 run 已确认不存在后立即开始新练习。useLiveQuery 在依赖切换时
  // 可能短暂保留上一条 run 的 `false` 查询结果；这个旧值绝不能把新 run 误判为
  // “题库已删除”并无操作返回首页。
  await helpers.importFixture(page);
  await helpers.clickButton(page, "练习");
  await helpers.expectText(page, "练习中心");
  await helpers.selectBankOnPracticeSetup(page);
  await helpers.clickTextButton(page, "全量顺序练习");
  await page.locator(".question-card").waitFor({ state: "visible" });
  await page.waitForTimeout(500);
  harness.assert.equal(await page.locator(".question-card").isVisible(), true, "新 run 不得继承上一条已删除 run 的 false 存在性结果而自动返回首页");
  harness.assert.equal(await page.getByText(/本次练习记录已被删除|练习已结束/).count(), 0, "新 run 不得收到上一条 run 的删除提示");
  await helpers.capture(page, contextName, "new-run-survives-stale-existence-result");

  // S1.5：系统/浏览器自行重建页面时，仍应回到用户正在进行的练习，而不是
  // 因为 React 内存态丢失就静默落回首页。先停在第 2 题，再整页 reload 验证
  // 当前题位置也能恢复；随后显式点“暂停并返回首页”，不仅 reload 要留在首页，
  // 关闭当前页面再创建新页面（模拟 App/WKWebView 冷启动）也必须留在首页。
  await helpers.answerCurrentQuestion(page, [1]); // 第 1 题故意答错，避免自动前进
  await helpers.clickTextButton(page, "下一题");
  await helpers.waitForQuestion(page, 2, 5);
  const secondStemBeforeReload = (await page.locator(".practice-stem").innerText()).trim();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await page.locator(".question-card").waitFor({ state: "visible" });
  await helpers.waitForQuestion(page, 2, 5);
  harness.assert.equal((await page.locator(".practice-stem").innerText()).trim(), secondStemBeforeReload, "页面重建后应恢复到原来的当前题");
  await helpers.capture(page, contextName, "system-reload-resumes-active-run");

  await helpers.clickButton(page, "暂停并返回首页");
  await helpers.expectText(page, "继续上次练习");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await helpers.expectText(page, "继续上次练习");
  harness.assert.equal(await page.locator(".question-card").count(), 0, "用户显式暂停后刷新不得自动重新进入练习");

  const relaunchedPage = await page.context().newPage();
  await relaunchedPage.goto(`${harness.baseUrl}/`, { waitUntil: "domcontentloaded" });
  await relaunchedPage.locator(".app-shell").waitFor({ state: "visible" });
  await helpers.expectText(relaunchedPage, "继续上次练习");
  harness.assert.equal(await relaunchedPage.locator(".question-card").count(), 0, "用户显式暂停后冷启动不得自动重新进入练习");
  await relaunchedPage.close();
}
