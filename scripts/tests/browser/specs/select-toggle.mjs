import * as harness from "../harness.mjs";
import * as helpers from "../helpers.mjs";

export async function runSelectToggleMobile(page) {
  const contextName = "select-toggle-mobile";
  await page.goto(`${harness.baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });

  const quickScope = page.getByLabel("快速搜索范围");
  const box = await quickScope.boundingBox();
  harness.assert.ok(box, "quick-search scope trigger must have a mobile hit box");

  await quickScope.tap();
  await page.waitForFunction(() => document.querySelector('[aria-label="快速搜索范围"]')?.getAttribute("aria-expanded") === "true");

  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y) ?? document.documentElement;
    target.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerType: "touch",
      pointerId: 1,
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
    }));
  }, point);

  await page.waitForFunction(() => document.querySelector('[aria-label="快速搜索范围"]')?.getAttribute("aria-expanded") === "false");

  // iOS/WebKit can deliver a follow-up click after the pointerdown-based close.
  // That click must be consumed rather than reopening Radix Select.
  await quickScope.dispatchEvent("click");
  await page.waitForTimeout(50);
  harness.assert.equal(await quickScope.getAttribute("aria-expanded"), "false", "a trailing click from the same trigger-area tap must not reopen the select");

  await helpers.capture(page, contextName, "closed-after-second-trigger-tap");
}
