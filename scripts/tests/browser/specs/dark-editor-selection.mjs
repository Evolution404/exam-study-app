import * as harness from "../harness.mjs";
import * as helpers from "../helpers.mjs";

function parseRgb(value) {
  const match = /rgba?\(([^)]+)\)/.exec(value ?? "");
  if (!match) return null;
  const values = match[1].split(",").slice(0, 3).map((part) => Number(part.trim()));
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) return null;
  return { r: values[0], g: values[1], b: values[2] };
}

function isLightText(value) {
  const rgb = parseRgb(value);
  return Boolean(rgb && rgb.r >= 220 && rgb.g >= 220 && rgb.b >= 220);
}

export async function runDarkEditorSelectionQA(page) {
  const contextName = "dark-editor-selection";
  await page.goto(`${harness.baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await helpers.importFixture(page);
  await page.evaluate(() => {
    const raw = JSON.parse(window.localStorage.getItem("study-v7-preferences") ?? "{}");
    window.localStorage.setItem("study-v7-preferences", JSON.stringify({ ...raw, themeMode: "dark" }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");

  await helpers.clickButton(page, "题库");
  const firstBank = page.locator("button.bank-management-main").first();
  await firstBank.waitFor({ state: "visible" });
  await firstBank.click();
  await page.getByRole("button", { name: /试题管理/ }).click();
  await page.locator(".managed-question-list article").first().waitFor({ state: "visible" });
  await page.getByRole("button", { name: "编辑题目" }).first().click();
  await page.locator(".question-editor").waitFor({ state: "visible" });

  const selected = page.locator(".question-editor .editor-options button.answer-selected");
  harness.assert.ok(await selected.count() >= 1, "编辑题目时必须明确标出至少一个正确答案");

  const selectedStyle = await selected.first().evaluate((button) => {
    const style = getComputedStyle(button);
    return { color: style.color, background: style.backgroundColor, border: style.borderColor };
  });
  const unselectedStyle = await page.locator(".question-editor .editor-options > div > button:not(.answer-selected)").first().evaluate((button) => {
    const style = getComputedStyle(button);
    return { color: style.color, background: style.backgroundColor, border: style.borderColor };
  });

  harness.assert.ok(isLightText(selectedStyle.color), `夜间编辑器正确答案字母必须是浅色，实际 ${selectedStyle.color}`);
  harness.assert.notEqual(selectedStyle.background, unselectedStyle.background, "夜间编辑器正确答案底色必须与未选答案明显不同");
  harness.assert.notEqual(selectedStyle.border, unselectedStyle.border, "夜间编辑器正确答案边框必须与未选答案明显不同");

  const buttonA = page.getByRole("button", { name: "将 A 设为正确答案" });
  const buttonB = page.getByRole("button", { name: "将 B 设为正确答案" });
  if (await buttonA.count() && await buttonB.count()) {
    await buttonB.click();
    harness.assert.ok(await buttonB.evaluate((button) => button.classList.contains("answer-selected")), "点击 B 后 B 应显示为正确答案");
    harness.assert.ok(!(await buttonA.evaluate((button) => button.classList.contains("answer-selected"))), "单选题切到 B 后 A 不应继续显示为正确答案");
  }

  await helpers.capture(page, contextName, "question-editor-answer-selected-dark");
  console.log("dark editor answer selection audit passed");
}
