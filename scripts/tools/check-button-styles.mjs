import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = process.cwd();
const styleFiles = [
  "components.css",
  "controls.css",
  "content-blocks.css",
  "hint.css",
  "practice-setup.css",
  "review-scope.css",
  "sync-events.css",
];
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const fail = (message) => { throw new Error(`按钮样式守卫失败：${message}`); };

// These two values are deliberately rewritten downward after a successful run.
// A fresh checkout starts with null so the existing baseline is seeded once.
let buttonHexBudget = 139;
let bareButtonBudget = {
  "src/app/bank/bank-library/bank-dashboard-widgets.tsx": 0,
  "src/app/bank/bank-library/bank-delete-dialog.tsx": 2,
  "src/app/bank/bank-library/bank-detail.tsx": 2,
  "src/app/bank/bank-library/bank-dialogs.tsx": 3,
  "src/app/bank/bank-library/bank-export-dialog.tsx": 2,
  "src/app/bank/bank-library/bank-folder-section.tsx": 4,
  "src/app/bank/bank-library/bank-question-delete-dialog.tsx": 2,
  "src/app/bank/bank-library/question-manager.tsx": 6,
  "src/app/bank/bank-library/unfiled-question-section.tsx": 1,
  "src/app/bank/bank-library-view.tsx": 1,
  "src/app/bank/content-block-editor.tsx": 8,
  "src/app/bank/content-block-renderer.tsx": 0,
  "src/app/bank/excel-import.tsx": 1,
  "src/app/bank/knowledge-view.tsx": 8,
  "src/app/bank/question-detail.tsx": 0,
  "src/app/bank/question-editor.tsx": 0,
  "src/app/practice/practice-history.tsx": 6,
  "src/app/practice/practice-setup.tsx": 1,
  "src/app/practice/progress-scope-setting.tsx": 0,
  "src/app/practice/review-round-manager.tsx": 4,
  "src/app/search/quick-search.tsx": 1,
  "src/app/search/search-filter-drawer.tsx": 1,
  "src/app/search/search-view.tsx": 9,
  "src/app/shell/app-shell.tsx": 1,
  "src/app/shell/views/build-version-card.tsx": 0,
  "src/app/shell/views/dashboard.tsx": 1,
  "src/app/shell/views/empty-import.tsx": 0,
  "src/app/shell/views/goal-setting.tsx": 0,
  "src/app/shell/views/group-size-setting.tsx": 0,
  "src/app/shell/views/image-cache-setting.tsx": 0,
  "src/app/shell/views/number-preference.tsx": 0,
  "src/app/shell/views/practice.tsx": 1,
  "src/app/shell/views/preference-select.tsx": 0,
  "src/app/shell/views/preferences-view.tsx": 0,
  "src/app/shell/views/pull-to-refresh.tsx": 0,
  "src/app/shell/views/question-overview.tsx": 0,
  "src/app/shell/views/stat.tsx": 0,
  "src/app/shell/views/sync-automation-setting.tsx": 0,
  "src/app/shell/views/theme-setting.tsx": 0,
  "src/app/shell/views/tolerance-setting.tsx": 0,
  "src/app/shell/views.tsx": 0,
  "src/app/sync/sync-event-drawer.tsx": 0,
  "src/app/sync/sync-event-manager.tsx": 3,
  "src/app/sync/sync-hot-window.tsx": 0,
  "src/app/sync/sync-view.tsx": 0,
  "src/app/ui/app-select.tsx": 0,
  "src/app/ui/asset-image.tsx": 0,
  "src/app/ui/confirm-dialog.tsx": 1,
  "src/app/ui/hint.tsx": 0,
  "src/app/ui/math-text.tsx": 0,
  "src/app/ui/modal-portal.tsx": 0,
  "src/app/ui/note-markdown.tsx": 0,
  "src/app/ui/scope-summary-chips.tsx": 0,
  "src/app/ui/shortcut-setting.tsx": 1
};

function matchingBrace(source, open) {
  let depth = 1;
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function collectCssRules(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  const scan = (start, end) => {
    let cursor = start;
    let headerStart = start;
    while (cursor < end) {
      const open = css.indexOf("{", cursor);
      if (open < 0 || open >= end) break;
      const close = matchingBrace(css, open);
      if (close < 0 || close > end) break;
      const header = css.slice(headerStart, open).trim();
      const body = css.slice(open + 1, close);
      if (header.startsWith("@") || body.includes("{")) scan(open + 1, close);
      else if (header) rules.push({ selector: header, body });
      cursor = close + 1;
      headerStart = cursor;
    }
  };
  scan(0, css.length);
  return rules;
}

function normalizeSelector(selector) {
  return selector.replace(/\s+/g, "").replace(/^[^{]*?:is\(/, "");
}

function lastCompound(selector) {
  const compact = selector.trim().split(/\s+|>|\+|~/).filter(Boolean).at(-1) ?? "";
  return compact.replace(/:(?:hover|focus-visible|focus|disabled|active|checked|not\([^)]*\)|first-child|last-child)$/, "");
}

function isButtonSelector(selector) {
  const compound = lastCompound(selector);
  return compound === "button" || [".primary", ".secondary", ".danger-button", ".icon-button", ".text-button"].includes(compound);
}

function buttonSelectors(rule) {
  return rule.selector.split(",").map((selector) => selector.trim()).filter(isButtonSelector);
}

function declarations(body, property) {
  return [...body.matchAll(new RegExp(`${property}\\s*:\\s*([^;}]*)`, "gi"))].map((match) => match[1].trim());
}

const cssRules = styleFiles.flatMap((file) => collectCssRules(read(`src/app/styles/${file}`)).map((rule) => ({ ...rule, file })));
const buttonRules = cssRules.flatMap((rule) => buttonSelectors(rule).map((selector) => ({ ...rule, selector })));

const shared = new Map();
for (const rule of cssRules.filter(({ file, selector }) => file === "components.css" && /^\.(primary|secondary|danger-button)$/.test(selector.trim()))) {
  shared.set(rule.selector.trim(), rule);
}
for (const name of [".primary", ".secondary", ".danger-button"]) {
  const rule = shared.get(name);
  if (!rule) fail(`components.css 缺少 ${name} 基础规则`);
  const body = rule.body.replace(/\s+/g, "");
  if (!/min-height:42px/.test(body) || !/border-radius:10px/.test(body)) fail(`${name} 必须为 42px 高、10px 圆角`);
  if (/#(?:[0-9a-f]{3,8})\b/i.test(rule.body)) fail(`${name} 基础规则不得包含 hex 颜色`);
  if (name === ".primary" && /box-shadow\s*:/.test(rule.body)) fail(".primary 基础规则不得包含 box-shadow");
}

const allowlistedSmall = new Set([".mobile-tabbar button", ".sync-event-mutations>section>button"].map((selector) => selector.replace(/\s+/g, "")));
for (const rule of buttonRules) {
  for (const value of declarations(rule.body, "font-size")) {
    const match = /^(\d+(?:\.\d+)?)px$/i.exec(value);
    if (match && Number(match[1]) < 12 && !allowlistedSmall.has(normalizeSelector(rule.selector))) {
      fail(`${rule.file} 的 ${rule.selector} 声明了 ${value}，按钮字号下限为 12px`);
    }
  }
}

const buttonHexCount = buttonRules.reduce((total, rule) => total + (rule.body.match(/#[0-9a-f]{3,8}\b/gi)?.length ?? 0), 0);
if (buttonHexBudget === null) buttonHexBudget = buttonHexCount;
if (buttonHexCount > buttonHexBudget) fail(`按钮规则 hex 颜色由 ${buttonHexBudget} 增至 ${buttonHexCount}，只能减少`);

const tsxFiles = [];
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".tsx")) tsxFiles.push(full);
  }
};
walk(path.join(root, "src/app"));

const bareCounts = Object.fromEntries(tsxFiles.map((file) => {
  const source = read(path.relative(root, file));
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  const visit = (node) => {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined;
    if (opening && opening.tagName.getText(sourceFile) === "button"
      && !opening.attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.text === "className")) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [path.relative(root, file), count];
}));

if (bareButtonBudget === null) bareButtonBudget = bareCounts;
for (const [file, count] of Object.entries(bareCounts)) {
  const budget = bareButtonBudget[file] ?? 0;
  if (count > budget) fail(`${file} 裸 <button> 由 ${budget} 增至 ${count}，必须挂共享按钮类`);
}

const scriptPath = fileURLToPath(import.meta.url);
let scriptSource = fs.readFileSync(scriptPath, "utf8");
const tightenedHexBudget = Math.min(buttonHexBudget, buttonHexCount);
const tightenedBareBudget = Object.fromEntries(Object.entries(bareButtonBudget).map(([file, budget]) => [file, Math.min(budget, bareCounts[file] ?? 0)]));
const shouldWrite = buttonHexBudget !== tightenedHexBudget || JSON.stringify(bareButtonBudget) !== JSON.stringify(tightenedBareBudget)
  || scriptSource.includes("let buttonHexBudget = null;") || scriptSource.includes("let bareButtonBudget = null;");
if (shouldWrite) {
  const previousHex = buttonHexBudget;
  buttonHexBudget = tightenedHexBudget;
  bareButtonBudget = tightenedBareBudget;
  scriptSource = scriptSource
    .replace(/let buttonHexBudget = (?:null|\d+);/, `let buttonHexBudget = ${buttonHexBudget};`)
    .replace(/let bareButtonBudget = (?:null|\{[\s\S]*?\});/, `let bareButtonBudget = ${JSON.stringify(bareButtonBudget, null, 2)};`);
  fs.writeFileSync(scriptPath, scriptSource);
  if (previousHex !== buttonHexBudget) console.log(`按钮 hex 预算棘轮已收紧：${previousHex}→${buttonHexBudget}`);
}

console.log(`按钮样式守卫通过：共享类契约、字号下限、按钮 hex ${buttonHexCount}/${buttonHexBudget}、TSX 裸按钮棘轮均正常。`);
