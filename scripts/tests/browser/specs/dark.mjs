import * as harness from "../harness.mjs";
import * as helpers from "../helpers.mjs";

// ===== 夜间模式按钮适配审计 =====
// 在深色主题下遍历全部主视图与关键弹窗，任何「近白背景 / 浅灰边框」的可见按钮
// 都视为未适配夜间模式（曾因 :where 零特异性被基础规则的 #fff 压回而回退过）。
// 刻意保持浅色的按钮（彩色卡片上的奶油色强调按钮等）登记在 ALLOWLIST，
// 新增按钮若被标记请先改 token 再放行。
const DARK_BUTTON_ALLOWLIST = [
  /^开始这一组$/, // 焦点卡片（绿色底）上的奶油色强调按钮，双主题刻意恒定
];

function parseRgbChannels(value) {
  const match = /rgba?\(([^)]+)\)/.exec(value ?? "");
  if (!match) return null;
  const parts = match[1].split(",").map((part) => Number(part.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

function looksLightInDark(channels, minChannel, minAlpha = 0.5) {
  if (!channels || channels.a < minAlpha) return false;
  return channels.r >= minChannel && channels.g >= minChannel && channels.b >= minChannel;
}

async function auditVisibleButtons(page, viewName, offenders) {
  const buttons = await page.evaluate(() => {
    const rows = [];
    for (const button of document.querySelectorAll("button")) {
      if (!(button instanceof HTMLElement) || button.offsetParent === null) continue;
      const style = getComputedStyle(button);
      rows.push({
        label: (button.getAttribute("aria-label") || button.textContent || "").replace(/\s+/g, " ").trim().slice(0, 36),
        bg: style.backgroundColor,
        border: style.borderColor,
        // border:0 的按钮 computed border-color 只是 currentColor 默认值，无视觉意义。
        borderWidth: Number.parseFloat(style.borderTopWidth) || 0,
      });
    }
    return rows;
  });
  for (const button of buttons) {
    const bg = parseRgbChannels(button.bg);
    const border = parseRgbChannels(button.border);
    const lightBg = looksLightInDark(bg, 225);
    const lightBorder = button.borderWidth > 0 && looksLightInDark(border, 195, 0.25);
    if (!lightBg && !lightBorder) continue;
    if (DARK_BUTTON_ALLOWLIST.some((pattern) => pattern.test(button.label))) continue;
    offenders.push(`${viewName} · ${button.label || "(图标按钮)"} bg=${button.bg} border=${button.border}`);
  }
}

// 直接文本夜间可读性审计：只检查可见、非禁用元素自己的文本节点，并向上寻找
// 第一个不透明背景。这样能抓住「深色 surface + 深色前景」这类主题泄漏，同时避开
// 渐变/透明容器中的大部分误报。阈值故意低于完整 WCAG 审计，只做明显回退守卫。
async function auditVisibleTextContrast(page, viewName, offenders) {
  const rows = await page.evaluate(() => {
    const parse = (value) => {
      const match = /rgba?\(([^)]+)\)/.exec(value ?? "");
      if (!match) return null;
      const parts = match[1].split(",").map((part) => Number(part.trim()));
      if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const channel = (value) => {
      const x = value / 255;
      return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4;
    };
    const luminance = (rgb) => .2126 * channel(rgb.r) + .7152 * channel(rgb.g) + .0722 * channel(rgb.b);
    const contrast = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    const out = [];
    for (const element of document.querySelectorAll("body *")) {
      if (!(element instanceof HTMLElement) || element.offsetParent === null) continue;
      if (element.matches(":disabled,[aria-disabled='true'],.sr-only") || element.closest(".sr-only")) continue;
      const style = getComputedStyle(element);
      if (Number.parseFloat(style.opacity || "1") < .65 || style.visibility === "hidden") continue;
      const text = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      const fg = parse(style.color);
      if (!fg || fg.a < .85) continue;
      let bg = null;
      let cursor = element;
      while (cursor instanceof HTMLElement) {
        const candidate = parse(getComputedStyle(cursor).backgroundColor);
        if (candidate && candidate.a >= .92) { bg = candidate; break; }
        cursor = cursor.parentElement;
      }
      if (!bg) continue;
      const fgLum = luminance(fg);
      const bgLum = luminance(bg);
      const ratio = contrast(fgLum, bgLum);
      if (bgLum < .16 && fgLum < .32 && ratio < 3) {
        out.push({ text: text.slice(0, 42), color: style.color, bg: `rgb(${bg.r}, ${bg.g}, ${bg.b})`, ratio: ratio.toFixed(2) });
      }
      if (out.length >= 30) break;
    }
    return out;
  });
  for (const row of rows) offenders.push(`${viewName} · “${row.text}” color=${row.color} bg=${row.bg} contrast=${row.ratio}`);
}

// 夜间透明输入框审计：搜索类 input 的底色必须保持透明（旧 bug：全站夜间 input
// 规则带 !important 强制 #111813，压进本应透明的搜索框，容器与 input 呈两种深色）。
async function auditSearchInputsDark(page, offenders) {
  const rows = await page.evaluate(() => {
    const out = [];
    for (const input of document.querySelectorAll(".searchbox input, .search-home-query input")) {
      if (!(input instanceof HTMLInputElement) || input.offsetParent === null) continue;
      out.push({ container: input.closest(".searchbox, .search-home-query")?.className ?? "?", bg: getComputedStyle(input).backgroundColor });
    }
    return out;
  });
  harness.assert.ok(rows.length >= 2, `夜间审计应同时看到顶栏搜索框与搜索页搜索框（实际 ${rows.length} 个）`);
  for (const row of rows) {
    const bg = parseRgbChannels(row.bg);
    if (bg && bg.a > 0.01) offenders.push(`夜间搜索框 input 底色不透明（.${row.container} bg=${row.bg}）`);
  }
}

export async function runDarkModeAudit(page) {
  const contextName = "dark";
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

  // 夜间 hover 审计（静态 CSSOM）：浅色 :hover 规则的特异性高于夜间基础列表，
  // 悬浮时会把浅底带回来（bank-priority-grid 曾中招）；元素级巡检采样的是
  // 静止态，看不到悬浮样式，这里直接扫样式表做项目级守卫。
  const hoverOffenders = await page.evaluate(() => {
    const isLight = (channels, min) => channels && channels.r >= min && channels.g >= min && channels.b >= min;
    const resolve = (value, min) => {
      if (!value || value.includes("var(")) return false;
      const toChannels = (text) => {
        if (text.startsWith("#")) {
          const hex = text.slice(1);
          if (hex.length === 3) return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16) };
          if (hex.length === 6) return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
          return null;
        }
        const match = /rgba?\(([^)]+)\)/.exec(text);
        if (!match) return null;
        const parts = match[1].split(",").map((part) => Number(part.trim()));
        return parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite) ? { r: parts[0], g: parts[1], b: parts[2] } : null;
      };
      return isLight(toChannels(value), min);
    };
    const rules = [];
    const walk = (list) => {
      for (const rule of list) {
        // 分组规则（@media/@supports）没有 selectorText；样式规则一律收录。
        // 不能用 rule.cssRules 判断分组——CSSStyleRule 也带空 cssRules（嵌套语法），
        // 那样会把所有样式规则当分组规则吞掉，守卫变成空扫。
        if (rule.selectorText !== undefined) {
          rules.push(rule);
          continue;
        }
        try { walk(rule.cssRules); } catch { /* 跨域或受限表跳过 */ }
      }
    };
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules); } catch { /* skip */ }
    }
    const darkSelectors = rules.filter((rule) => rule.selectorText?.includes('[data-theme="dark"]')).map((rule) => rule.selectorText);
    const offenders = [];
    for (const rule of rules) {
      const selector = rule.selectorText ?? "";
      if (!selector.includes(":hover") || selector.includes('[data-theme="dark"]')) continue;
      const style = rule.style;
      const bgValue = style.backgroundColor || style.background;
      const borderValue = style.borderTopColor || style.borderColor;
      if (!resolve(bgValue, 225) && !resolve(borderValue, 195)) continue;
      const hoverParts = selector.split(",").map((part) => part.trim()).filter((part) => part.includes(":hover"));
      // 覆盖判定：任一暗色选择器包含该 hover 选择器文本（共享 :where/:is 列表也成立）。
      const uncovered = hoverParts.filter((part) => !darkSelectors.some((dark) => dark.includes(part)));
      if (!uncovered.length) continue;
      offenders.push(`${uncovered.join(", ")} bg=${bgValue || "-"} border=${borderValue || "-"}`);
    }
    return offenders;
  });
  harness.assert.deepEqual(hoverOffenders, [], `夜间模式下存在未适配的 :hover 浅色规则（请补 html[data-theme="dark"] 覆盖或改用主题 token）：\n${hoverOffenders.join("\n")}`);

  const offenders = [];
  const textOffenders = [];
  for (const nav of ["今日", "题库", "练习", "知识整理", "配置", "同步"]) {
    await helpers.clickButton(page, nav);
    await page.waitForTimeout(450);
    await auditVisibleButtons(page, nav, offenders);
    await auditVisibleTextContrast(page, nav, textOffenders);
  }

  // 题库详情夜间层级：Hero 是深色 surface，主文字必须保持浅色；文件夹标签
  // 与题库说明同属辅助信息，禁止再回退成高饱和橙色。
  await helpers.clickButton(page, "题库");
  const firstBank = page.locator("button.bank-management-main").first();
  await firstBank.waitFor({ state: "visible" });
  await firstBank.click();
  await page.locator(".bank-progress-hero").waitFor({ state: "visible" });
  const bankDetailColors = await page.evaluate(() => {
    const color = (selector) => getComputedStyle(document.querySelector(selector)).color;
    return {
      headingKicker: color(".bank-detail-heading .section-kicker"),
      headingDescription: color(".bank-detail-heading p"),
      heroCompletion: color(".bank-progress-ring strong"),
      heroTitle: color(".bank-progress-copy h2"),
      heroSideValue: color(".bank-progress-side strong"),
    };
  });
  harness.assert.equal(bankDetailColors.headingKicker, bankDetailColors.headingDescription, "题库详情文件夹标签应与辅助说明使用同一夜间文字层级");
  for (const [label, value] of Object.entries({
    "完成度数字": bankDetailColors.heroCompletion,
    "进度主标题": bankDetailColors.heroTitle,
    "最近作答值": bankDetailColors.heroSideValue,
  })) {
    const channels = parseRgbChannels(value);
    harness.assert.ok(looksLightInDark(channels, 220), `题库进度 Hero 的${label}必须保持浅色，实际 ${value}`);
  }
  await auditVisibleButtons(page, "题库详情", offenders);
  await auditVisibleTextContrast(page, "题库详情", textOffenders);
  await helpers.capture(page, contextName, "bank-detail-dark");
  await helpers.clickTextButton(page, "返回题库管理");

  // 题组编辑器编辑态（历史漏检点）：取消编辑的叉按钮与条目移除按钮只在编辑
  // 已有题组时渲染，常规视图巡检看不到，曾在夜间保持白底。必须进入编辑态审计。
  await helpers.clickButton(page, "知识整理");
  await helpers.expectText(page, "标签");
  await helpers.clickTextButton(page, "题组");
  await page.getByLabel("题组名称").fill("夜间审计题组");
  const groupSearch = page.locator(".group-search input");
  await groupSearch.fill("巡视");
  await page.waitForTimeout(600);
  const firstGroupResult = page.locator(".group-search-results button").first();
  await firstGroupResult.waitFor({ state: "visible" });
  await firstGroupResult.click();
  await page.getByRole("button", { name: "保存题组" }).click();
  await helpers.expectNotice(page, /题组“夜间审计题组”已保存/, "dark audit group save");
  const groupCard = page.locator(".group-list article").filter({ hasText: "夜间审计题组" }).first();
  await groupCard.waitFor({ state: "visible" });
  await groupCard.getByRole("button", { name: "编辑" }).click();
  await page.getByRole("button", { name: "取消编辑" }).waitFor({ state: "visible" });
  await auditVisibleButtons(page, "题组编辑器编辑态", offenders);
  await auditVisibleTextContrast(page, "题组编辑器编辑态", textOffenders);
  await helpers.capture(page, contextName, "group-editor-edit-dark");
  await page.getByRole("button", { name: "取消编辑" }).click();
  // 搜索视图：透明输入框审计（顶栏 + 搜索页两个搜索框）。
  await helpers.clickButton(page, "今日");
  await helpers.clickButton(page, "进入搜索主页");
  await helpers.expectText(page, "搜索题库");
  await auditSearchInputsDark(page, offenders);
  // 搜索详情面板底部操作按钮（历史回退点：夜间规则 >footer>button 子选择器
  // 匹配不到 .search-detail-actions 内的按钮，三按钮保持浅色 #fff）。
  await page.getByLabel("搜索题库").fill("巡视");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await helpers.expectText(page, /“巡视”找到 \d+ 道题/);
  await page.locator(".search-result-list article").first().locator(".search-result-main").click();
  await page.getByRole("dialog", { name: "题目详情" }).waitFor({ state: "visible" });
  await auditVisibleButtons(page, "搜索详情面板", offenders);
  await auditVisibleTextContrast(page, "搜索详情面板", textOffenders);
  await helpers.capture(page, contextName, "search-detail-dark");
  await page.getByRole("dialog", { name: "题目详情" }).getByRole("button", { name: "关闭题目详情" }).click();
  await page.getByRole("dialog", { name: "题目详情" }).waitFor({ state: "hidden" });
  await helpers.clickButton(page, "题库");
  // 清除数据确认弹窗（历史回退点）：三个按钮必须全部适配。
  await helpers.clickButton(page, "同步");
  await helpers.expectText(page, "GitHub 同步");
  const clearButton = page.getByRole("button", { name: "清除数据" }).first();
  await clearButton.scrollIntoViewIfNeeded();
  await clearButton.click();
  await page.locator(".confirm-dialog").waitFor({ state: "visible" });
  await auditVisibleButtons(page, "清除数据弹窗", offenders);
  await auditVisibleTextContrast(page, "清除数据弹窗", textOffenders);
  await helpers.capture(page, contextName, "clear-data-dialog-dark");
  await page.getByRole("button", { name: "取消" }).click();
  await page.locator(".confirm-dialog").waitFor({ state: "hidden" });

  // 练习答题页（提交后还有结果操作按钮）。
  await helpers.clickButton(page, "练习");
  await helpers.expectText(page, "练习中心");
  await helpers.selectBankOnPracticeSetup(page);
  await helpers.clickTextButton(page, "全量顺序练习");
  await page.locator(".question-card").waitFor({ state: "visible" });
  await helpers.answerCurrentQuestion(page, [0]);
  await auditVisibleButtons(page, "练习作答", offenders);
  await auditVisibleTextContrast(page, "练习作答", textOffenders);

  harness.assert.deepEqual(textOffenders, [], `夜间模式下存在明显低对比正文（${textOffenders.length} 个，请改用语义前景 token）：\n${textOffenders.join("\n")}`);
  harness.assert.deepEqual(offenders, [], `夜间模式下存在未适配按钮（${offenders.length} 个，请改用主题 token 或登记 ALLOWLIST）：\n${offenders.join("\n")}`);
  console.log(`dark mode audit passed: 6 视图 + 题库详情 + 清除数据弹窗 + 练习作答，按钮与正文均无明显主题泄漏`);
}
