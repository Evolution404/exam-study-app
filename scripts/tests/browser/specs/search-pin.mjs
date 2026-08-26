import * as harness from "../harness.mjs";
import * as helpers from "../helpers.mjs";
import * as fixtures from "../fixtures.mjs";

// ===== 搜索页吸附几何断言 =====
// 设计（2026-08 用户确认）：搜索页内全局顶栏随内容滚走，页面自己的搜索框钉在
// 视口顶部，批量操作栏紧贴搜索框正下方。滚动后逐一断言，防止吸附目标回退到
// 全局顶栏（旧 bug：批量栏与顶部搜索框之间隔出大段距离）。
export async function assertSearchPinGeometry(page, label, { requireScroll = false } = {}) {
  await page.evaluate(() => {
    const workspace = document.querySelector(".workspace");
    const scroller = workspace && getComputedStyle(workspace).overflowY === "auto" ? workspace : window;
    scroller.scrollBy(0, 5000);
  });
  await page.waitForTimeout(250);
  const geo = await page.evaluate(() => {
    const query = document.querySelector(".search-home-query")?.getBoundingClientRect();
    const bar = document.querySelector(".search-batch-bar")?.getBoundingClientRect();
    const topbar = document.querySelector(".topbar")?.getBoundingClientRect();
    const workspace = document.querySelector(".workspace");
    const usesWorkspaceScroll = workspace !== null && getComputedStyle(workspace).overflowY === "auto";
    const scroller = usesWorkspaceScroll ? workspace : document.scrollingElement;
    return {
      queryTop: query?.top,
      queryBottom: query?.bottom,
      barTop: bar?.top,
      topbarBottom: topbar?.bottom,
      scrollTop: scroller?.scrollTop ?? window.scrollY,
      atScrollBottom: scroller ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1 : true,
    };
  });
  harness.assert.ok(geo.queryTop !== undefined && geo.barTop !== undefined, `${label}: 搜索结果页缺少搜索框或批量栏`);
  if (geo.scrollTop < 10) {
    // 内容不足以产生滚动：sticky 无从验证。专用组必须滚动（requireScroll），
    // 顺路检查组（桌面 search）允许跳过。
    harness.assert.ok(!requireScroll, `${label}: 搜索结果应长于视口以验证吸附（scrollTop=${geo.scrollTop}）`);
    console.log(`  · ${label}: 内容未超出视口，跳过吸附几何断言`);
    return;
  }
  harness.assert.ok(Math.abs(geo.queryTop) <= 1, `${label}: 搜索框应钉在视口顶部（实际 top=${geo.queryTop}）`);
  harness.assert.ok((geo.topbarBottom ?? 0) <= geo.queryTop + 1, `${label}: 全局顶栏应随滚动离场、不压在搜索框上（topbar.bottom=${geo.topbarBottom}）`);
  // 批量栏必须紧贴搜索框下方；唯一例外是内容太短、滚动到底后批量栏天然位置仍在下方。
  if (geo.barTop > geo.queryBottom + 1) {
    harness.assert.ok(geo.atScrollBottom, `${label}: 批量栏与搜索框之间不得有空隙（bar.top=${geo.barTop} vs query.bottom=${geo.queryBottom}），且未滚到底`);
  }
  await helpers.capture(page, "search-pin", `pinned-${label}`);
}

export async function runSearchPinMobile(page) {
  await page.goto(`${harness.baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await helpers.importFixture(page);
  await helpers.expectText(page, "送电线路工-初级工");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.bigFixtureFile);
  await page.waitForTimeout(600);
  await helpers.clickButton(page, "进入搜索主页");
  await helpers.expectText(page, "搜索题库");
  // 空关键词条件搜索：展示全部题目，保证列表足够长可滚动。
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await helpers.expectText(page, /条件搜索找到 \d+ 道题/);
  await assertSearchPinGeometry(page, "mobile", { requireScroll: true });
  await page.evaluate(() => {
    const query = document.querySelector(".search-home-query");
    if (query instanceof HTMLElement) query.style.minHeight = "72px";
    const workspace = document.querySelector(".workspace");
    const scroller = workspace && getComputedStyle(workspace).overflowY === "auto" ? workspace : window;
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTo(0, Math.min(1600, Math.max(0, maxScroll - 200)));
  });
  await page.waitForTimeout(150);
  const adaptiveGeometry = await page.evaluate(() => {
    const query = document.querySelector(".search-home-query")?.getBoundingClientRect();
    const batch = document.querySelector(".search-batch-bar");
    const batchRect = batch?.getBoundingClientRect();
    return {
      queryLeft: query?.left,
      queryRight: query?.right,
      queryTop: query?.top,
      queryBottom: query?.bottom,
      batchTop: batchRect?.top,
      batchBottom: batchRect?.bottom,
      batchPosition: batch ? getComputedStyle(batch).position : undefined,
      viewportWidth: document.documentElement.clientWidth,
    };
  });
  harness.assert.equal(adaptiveGeometry.batchPosition, "sticky", "mobile shared: 批量栏必须保持第二级吸顶");
  harness.assert.ok((adaptiveGeometry.queryLeft ?? -1) >= 0 && (adaptiveGeometry.queryRight ?? Infinity) <= adaptiveGeometry.viewportWidth + 1, "mobile shared: 搜索框不得被横向裁切");
  harness.assert.ok(Math.abs(adaptiveGeometry.queryTop ?? Infinity) <= 1, `mobile shared: 搜索栏必须固定在视口顶部（top=${adaptiveGeometry.queryTop}）`);
  harness.assert.ok(Math.abs((adaptiveGeometry.batchTop ?? Infinity) - (adaptiveGeometry.queryBottom ?? 0)) <= 1, `mobile shared: 搜索栏高度变化后批量栏仍须紧贴（batch.top=${adaptiveGeometry.batchTop}, query.bottom=${adaptiveGeometry.queryBottom}）`);
  harness.assert.ok((adaptiveGeometry.batchBottom ?? 0) > (adaptiveGeometry.batchTop ?? Infinity), "mobile shared: 固定批量栏必须保持可见高度");
  await helpers.capture(page, "search-pin", "adaptive-sticky-mobile");
}
