import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const fromRoot = (...parts) => path.join(root, ...parts);
const read = (file) => fs.readFileSync(fromRoot(file), "utf8");
const write = (file, content) => {
  fs.mkdirSync(path.dirname(fromRoot(file)), { recursive: true });
  fs.writeFileSync(fromRoot(file), content);
};

function mustReplace(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`one-shot migration: missing ${label}`);
  return source.replace(search, replacement);
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let quote = null;
  let comment = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (comment) {
      if (char === "*" && next === "/") { comment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (char === "\\") { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "*") { comment = true; index += 1; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`one-shot migration: unmatched CSS brace at ${openIndex}`);
}

function parseTopLevel(source) {
  const items = [];
  let start = 0;
  let index = 0;
  let quote = null;
  let comment = false;
  let parens = 0;
  let brackets = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (comment) {
      if (char === "*" && next === "/") { comment = false; index += 2; continue; }
      index += 1;
      continue;
    }
    if (quote) {
      if (char === "\\") { index += 2; continue; }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") { comment = true; index += 2; continue; }
    if (char === '"' || char === "'") { quote = char; index += 1; continue; }
    if (char === "(") parens += 1;
    else if (char === ")") parens = Math.max(0, parens - 1);
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets = Math.max(0, brackets - 1);
    else if (parens === 0 && brackets === 0 && char === "{") {
      const close = findMatchingBrace(source, index);
      items.push({ type: "block", header: source.slice(start, index), body: source.slice(index + 1, close), raw: source.slice(start, close + 1) });
      start = close + 1;
      index = start;
      continue;
    } else if (parens === 0 && brackets === 0 && char === ";") {
      items.push({ type: "statement", header: source.slice(start, index + 1), body: "", raw: source.slice(start, index + 1) });
      start = index + 1;
    }
    index += 1;
  }
  if (start < source.length) items.push({ type: "trailing", header: source.slice(start), body: "", raw: source.slice(start) });
  return items;
}

const stripComments = (value) => value.replace(/\/\*[\s\S]*?\*\//g, " ").trim();
const compactSelector = (value) => stripComments(value).replace(/\s+/g, "").toLowerCase();
const isNestedContainer = (header) => /^@(media|supports|container|layer|scope|starting-style)\b/i.test(stripComments(header));

function collectSelectors(source, target = new Set()) {
  for (const item of parseTopLevel(source)) {
    if (item.type !== "block") continue;
    const header = stripComments(item.header);
    if (isNestedContainer(header)) collectSelectors(item.body, target);
    else if (!header.startsWith("@")) target.add(compactSelector(header));
  }
  return target;
}

function pruneSelectors(source, selectorSet) {
  return parseTopLevel(source).map((item) => {
    if (item.type !== "block") return item.raw;
    const header = stripComments(item.header);
    if (isNestedContainer(header)) {
      const body = pruneSelectors(item.body, selectorSet);
      return body.trim() ? `${item.header}{${body}}` : "";
    }
    if (!header.startsWith("@") && selectorSet.has(compactSelector(header))) return "";
    return item.raw;
  }).join("");
}

function cssCategory(item) {
  const header = stripComments(item.header);
  const normalized = header.toLowerCase();
  const compact = normalized.replace(/\s+/g, "");
  if (/html\[data-theme=["']dark["']\]/i.test(header)) return "dark-overrides";
  if (/^@(media|supports|container|scope|starting-style)\b/i.test(header)) return "responsive";
  if (/^@(?:font-face|charset|namespace|property)\b/i.test(header)) return "base";
  if (/^@(?:keyframes|-webkit-keyframes)\b/i.test(header)) return "shared";
  if (item.type !== "block") return "shared";
  if (["*", "html,body", "body", "button,input,textarea", "button"].includes(compact)) return "base";
  if (/search|quick-search|searchbox|filter-drawer|match-group/.test(normalized)) return "search";
  if (/bank-|bank\b|library|question-manager|question-editor|editor-|knowledge|folder-|excel-|import-|content-block/.test(normalized)) return "bank";
  if (/practice|answer-|option-|question-card|calculation|result-|review-|progress-orbit|question-nav|finish-/.test(normalized)) return "practice";
  if (/preference|preferences|settings-|setting-|shortcut|goal-|tolerance|image-cache|build-version|toggle/.test(normalized)) return "preferences";
  if (/home-|hero-|focus-|quote-|resume-|dashboard|today-|stat-|scope-summary/.test(normalized)) return "dashboard";
  if (/\.primary\b|\.secondary\b|\.toast\b|\.page-heading\b|\.eyebrow\b|\.section-kicker\b|\.app-select\b|modal|dialog|\.chip\b|\.pill\b|\.copy-question\b/.test(normalized)) return "primitives";
  return "shared";
}

function walk(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, predicate);
    return entry.isFile() && predicate(full) ? [full] : [];
  });
}

function cssMetrics(source) {
  return {
    bytes: Buffer.byteLength(source),
    hexColors: source.match(/#[0-9a-fA-F]{3,8}\b/g)?.length ?? 0,
    darkSelectors: source.match(/html\[data-theme=["']dark["']\]/g)?.length ?? 0,
    important: source.match(/!important\b/g)?.length ?? 0,
  };
}

// --- Retire the last v7/v8 remote compatibility reads. ---------------------
{
  const file = "src/lib/sync/sync-v7-checkpoint.ts";
  let source = read(file);
  source = mustReplace(source,
    "/** 旧远程检查点格式：仅用于读取已发布的 v7 检查点，新检查点一律写 7。 */\nconst SYNC_V7_CHECKPOINT_LEGACY_FORMAT = 6 as const;\n",
    "",
    "legacy checkpoint format constant");
  source = mustReplace(source,
    "  if (!isRecord(value) || (value.formatVersion !== SYNC_V7_CHECKPOINT_FORMAT && value.formatVersion !== SYNC_V7_CHECKPOINT_LEGACY_FORMAT)) fail(\"formatVersion must be 7（读取旧检查点时允许 6）\");",
    "  if (!isRecord(value) || value.formatVersion !== SYNC_V7_CHECKPOINT_FORMAT) fail(\"formatVersion must be 7\");",
    "legacy checkpoint validation");
  source = mustReplace(source,
    "    // Legacy namespaces remain readable for one release cycle so the one-time\n    // protocol migration can ingest unmigrated vaults and re-upload their\n    // assets into the current namespace.\n    const legacyExpectedPaths = [`sync/v8/assets/${asset.id}.${extension}`, `sync/v7/assets/${asset.id}.${extension}`, `sync/v6/assets/${asset.id}.${extension}`];\n    if (asset.remote.path !== expectedPath && !legacyExpectedPaths.includes(asset.remote.path)) {",
    "    if (asset.remote.path !== expectedPath) {",
    "legacy asset namespaces");
  source = mustReplace(source,
    "  if ((checkpoint as { formatVersion?: unknown }).formatVersion === SYNC_V7_CHECKPOINT_LEGACY_FORMAT) {\n    (checkpoint as { formatVersion: number }).formatVersion = SYNC_V7_CHECKPOINT_FORMAT;\n  }\n",
    "",
    "legacy checkpoint normalization");
  write(file, source);
}

// --- Physically split the historical CSS monolith. -------------------------
const legacyFile = "src/app/styles/legacy-components.css";
const shellFile = "src/app/styles/shell.css";
if (!fs.existsSync(fromRoot(legacyFile))) throw new Error("one-shot migration: legacy-components.css is already absent");
const legacySource = read(legacyFile);
const shellSource = read(shellFile);
const migratedShellSelectors = collectSelectors(shellSource);
const prunedLegacy = pruneSelectors(legacySource, migratedShellSelectors);
const buckets = new Map([
  ["base", []], ["primitives", []], ["shared", []], ["dashboard", []], ["search", []],
  ["bank", []], ["practice", []], ["preferences", []], ["responsive", []], ["dark-overrides", []],
]);
for (const item of parseTopLevel(prunedLegacy)) {
  if (!item.raw.trim()) continue;
  buckets.get(cssCategory(item)).push(item.raw);
}

const copyModuleFile = "src/app/ui/copy-question-button.module.css";
if (fs.existsSync(fromRoot(copyModuleFile))) {
  const copyGlobal = read(copyModuleFile).replace(/\.scope\s+:global\(([^)]+)\)/g, "$1");
  if (/:global\(/.test(copyGlobal)) throw new Error("one-shot migration: copy-question module still contains :global()");
  buckets.get("primitives").push(`\n/* Copy-question button: retired the fake document-scoped CSS Module bridge. */\n${copyGlobal}`);
  fs.rmSync(fromRoot(copyModuleFile));
}

const labels = {
  base: "Document reset and global element defaults.",
  primitives: "Shared UI primitives and low-level controls.",
  shared: "Cross-feature layout and reusable presentation rules.",
  dashboard: "Dashboard and home-view presentation.",
  search: "Quick search and advanced search presentation.",
  bank: "Question-bank, management and editor presentation.",
  practice: "Practice, answer, result and review presentation.",
  preferences: "Preferences and settings presentation.",
  responsive: "Cross-feature responsive rules kept in original cascade order.",
  "dark-overrides": "Centralized legacy dark-theme overrides; semantic tokens remain preferred for new code.",
};
for (const [name, rules] of buckets) {
  write(`src/app/styles/${name}.css`, `/* ${labels[name]} */\n${rules.join("\n").trim()}\n`);
}
fs.rmSync(fromRoot(legacyFile));

write("src/app/styles/components.css", `/* Component style composition. Feature files own declarations; this file owns order only. */\n@import "./base.css";\n@import "./primitives.css";\n@import "./shared.css";\n@import "./shell.css";\n@import "./dashboard.css";\n@import "./search.css";\n@import "./bank.css";\n@import "./practice.css";\n@import "./preferences.css";\n@import "./responsive.css";\n@import "./dark-overrides.css";\n`);

// Remove the document-wide CSS-Module scope bridge from bootstrap.
{
  const file = "src/main.tsx";
  let source = read(file);
  source = mustReplace(source, "import copyQuestionButtonStyles from \"./app/ui/copy-question-button.module.css\";\n", "", "copy-question module import");
  source = mustReplace(source, "// Scope the first incremental CSS-module migration around the existing app.\ndocument.documentElement.classList.add(copyQuestionButtonStyles.scope);\n", "", "copy-question html scope");
  write(file, source);
}

// Replace temporary color aliases everywhere, then delete the aliases.
const aliasMap = new Map([
  ["var(--paper)", "var(--color-canvas)"],
  ["var(--ink)", "var(--color-text)"],
  ["var(--muted)", "var(--color-text-muted)"],
  ["var(--line)", "var(--color-border)"],
  ["var(--green)", "var(--color-primary)"],
  ["var(--green-soft)", "var(--color-primary-soft)"],
  ["var(--orange)", "var(--color-accent)"],
  ["var(--white)", "var(--color-surface-raised)"],
]);
for (const full of walk(fromRoot("src/app"), (file) => file.endsWith(".css"))) {
  let source = fs.readFileSync(full, "utf8");
  for (const [before, after] of aliasMap) source = source.split(before).join(after);
  fs.writeFileSync(full, source);
}
{
  const file = "src/app/styles/theme-tokens.css";
  let source = read(file);
  source = source.replace(/\n  \/\* Temporary aliases keep existing components on the same semantic contract\. \*\/\n(?:  --(?:paper|ink|muted|line|green|green-soft|orange|white):[^\n]+\n)+/, "\n");
  if (!source.includes("--space-1:")) {
    source = source.replace("  --motion-ease: cubic-bezier(.2, .8, .2, 1);\n", `  --motion-ease: cubic-bezier(.2, .8, .2, 1);\n\n  /* Shared geometry tokens for new/refactored UI. */\n  --space-1: 4px;\n  --space-2: 8px;\n  --space-3: 12px;\n  --space-4: 16px;\n  --space-5: 20px;\n  --space-6: 24px;\n  --space-8: 32px;\n  --radius-sm: 8px;\n  --radius-md: 10px;\n  --radius-lg: 14px;\n  --radius-xl: 18px;\n  --control-height: 42px;\n  --z-sticky: 20;\n  --z-navigation: 30;\n  --z-popover: 45;\n  --z-toast: 140;\n`);
  }
  write(file, source);
}

// --- Split presentational shell chrome out of the orchestration component. --
write("src/app/shell/navigation.tsx", `"use client";\nimport { Cloud, Home, Library, Link2, ListFilter, Settings2 } from "lucide-react";\nimport { formatBuildTimestampShort, type View } from "./helpers";\n\nconst navItems = [\n  { id: "home" as const, label: "今日", icon: Home },\n  { id: "banks" as const, label: "题库", icon: Library },\n  { id: "practiceSetup" as const, label: "练习", icon: ListFilter },\n  { id: "relations" as const, label: "知识整理", icon: Link2 },\n  { id: "preferences" as const, label: "配置", icon: Settings2 },\n  { id: "settings" as const, label: "同步", icon: Cloud },\n];\nconst mobileNavItems = navItems.filter(({ id }) => id !== "settings").map((item) => item.id === "relations" ? { ...item, label: "整理" } : item);\n\nexport function ShellSidebar({ view, open, pending, onOpenView, onClose }: { view: View; open: boolean; pending: number; onOpenView: (view: View) => void; onClose: () => void }) {\n  return <>\n    <aside className={\`sidebar \${open ? "sidebar-open" : ""}\`}>\n      <div className="brand"><span className="brand-mark">拾</span><span>拾卷</span></div>\n      <nav>\n        {navItems.map(({ id, label, icon: Icon }) => (\n          <button key={id} className={\`\${view === id ? "nav-active" : ""} \${id === "settings" ? "desktop-sync-nav" : ""}\`} aria-current={view === id ? "page" : undefined} onClick={() => onOpenView(id)}>\n            <Icon size={19} strokeWidth={1.8} /><span>{label}</span>\n          </button>\n        ))}\n      </nav>\n      <div className="sidebar-foot">\n        <span className="local-dot" />本地数据已保存\n        <small>{pending ? \`\${pending} 条等待同步\` : "没有待同步更改"}</small>\n        <small className="sidebar-build"><code>{__APP_COMMIT_SHA__.slice(0, 7)}</code> · {formatBuildTimestampShort()}</small>\n      </div>\n    </aside>\n    <button className={\`sidebar-backdrop \${open ? "visible" : ""}\`} aria-label="关闭导航" onClick={onClose} />\n  </>;\n}\n\nexport function MobileTabbar({ view, onOpenView }: { view: View; onOpenView: (view: View) => void }) {\n  return <nav className={\`mobile-tabbar \${view === "practice" ? "hidden" : ""}\`} aria-label="手机主导航">\n    {mobileNavItems.map(({ id, label, icon: Icon }) => (\n      <button key={id} className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => onOpenView(id)}>\n        <Icon size={20} strokeWidth={view === id ? 2.2 : 1.8} />\n        <span>{label}</span>\n      </button>\n    ))}\n  </nav>;\n}\n`);

write("src/app/shell/topbar.tsx", `"use client";\nimport type { PointerEventHandler } from "react";\nimport { ChevronRight, LoaderCircle, Menu, RefreshCw } from "lucide-react";\nimport { QuickSearch } from "@/app/search/quick-search";\nimport type { SearchContentScope } from "@/app/search/search-matching";\nimport type { BankV7 } from "@/lib/db/v7-types";\nimport type { SyncProgress } from "@/lib/sync/sync-application";\n\ntype PointerHandler = PointerEventHandler<HTMLButtonElement>;\n\nexport function ShellTopbar({ menuOpen, banks, activeBankIds, syncing, restoring, holding, pending, progress, onToggleMenu, onOpenSearch, onSync, onOpenQueue, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture }: {\n  menuOpen: boolean;\n  banks: BankV7[];\n  activeBankIds: string[];\n  syncing: boolean;\n  restoring: boolean;\n  holding: boolean;\n  pending: number;\n  progress?: SyncProgress;\n  onToggleMenu: () => void;\n  onOpenSearch: (keyword: string, questionId?: string, contentScope?: SearchContentScope) => void;\n  onSync: () => void;\n  onOpenQueue: () => void;\n  onPointerDown: PointerHandler;\n  onPointerMove: PointerHandler;\n  onPointerUp: PointerHandler;\n  onPointerCancel: PointerHandler;\n  onLostPointerCapture: PointerHandler;\n}) {\n  const busy = syncing || restoring;\n  return <>\n    <header className="topbar">\n      <button className="icon-button mobile-menu" aria-label="打开导航" onClick={onToggleMenu}><Menu size={20} /></button>\n      <QuickSearch banks={banks} activeBankIds={activeBankIds} onOpenSearch={onOpenSearch} />\n      <div className="quick-sync-split"><button className={\`sync-pill quick-sync \${busy ? "syncing" : ""} \${holding ? "holding" : ""}\`} disabled={busy} aria-label="单击立即同步，长按恢复本地记录" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onLostPointerCapture={onLostPointerCapture} onContextMenu={(event) => event.preventDefault()} onClick={(event) => { if (event.detail === 0) onSync(); }}><span className="quick-sync-icon"><svg className="quick-sync-progress" viewBox="0 0 32 32" aria-hidden="true"><circle className="track" cx="16" cy="16" r="14" /><circle className="value" cx="16" cy="16" r="14" /></svg>{busy ? <LoaderCircle className="spin" size={18} /> : <RefreshCw size={18} />}</span><span className="quick-sync-label">{holding ? "恢复" : restoring ? "恢复中" : syncing ? "同步中" : "同步"}</span></button><button className="sync-queue-trigger" type="button" aria-label={\`查看本次同步，共 \${pending} 组待同步事件\`} onClick={onOpenQueue}>{pending.toLocaleString("zh-CN")}<ChevronRight size={14} /></button></div>\n    </header>\n    {progress && <div className="top-sync-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><span>{progress.label}<em>{progress.percent}%</em></span><i aria-hidden="true"><b style={{ width: \`\${progress.percent}%\` }} /></i></div>}\n  </>;\n}\n`);

{
  const file = "src/app/shell/app-shell.tsx";
  let source = read(file);
  source = mustReplace(source,
    "import { ChevronRight, ClipboardCheck, Cloud, Home, Library, Link2, ListFilter, LoaderCircle, Menu, Play, RefreshCw, Settings2, Sparkles, X } from \"lucide-react\";",
    "import { ClipboardCheck, LoaderCircle, Play, Sparkles, X } from \"lucide-react\";",
    "app-shell lucide import");
  source = mustReplace(source, "import { QuickSearch } from \"@/app/search/quick-search\";\n", "", "QuickSearch import");
  source = mustReplace(source,
    "import { Dashboard, Practice, PreferencesView, PullToRefresh } from \"./views\";\n",
    "import { Dashboard, Practice, PreferencesView, PullToRefresh } from \"./views\";\nimport { MobileTabbar, ShellSidebar } from \"./navigation\";\nimport { ShellTopbar } from \"./topbar\";\n",
    "shell presentational imports");
  source = source.replace(/\n  const navItems = \[[\s\S]*?\n  const mobileNavItems = [^\n]+\n\n  function openMainView/, "\n  function openMainView");
  if (/const navItems =/.test(source)) throw new Error("one-shot migration: nav declarations were not removed");
  const sidebarPattern = /      <aside className=\{`sidebar \$\{sidebarOpen \? "sidebar-open" : ""\}`\}>[\s\S]*?      <button className=\{`sidebar-backdrop \$\{sidebarOpen \? "visible" : ""\}`\} aria-label="关闭导航" onClick=\{\(\) => setSidebarOpen\(false\)\} \/>/;
  if (!sidebarPattern.test(source)) throw new Error("one-shot migration: sidebar markup not found");
  source = source.replace(sidebarPattern, "      <ShellSidebar view={view} open={sidebarOpen} pending={stats.pending} onOpenView={openMainView} onClose={() => setSidebarOpen(false)} />");
  const topbarPattern = /        <header className="topbar">[\s\S]*?        <\/header>\n\n        \{smoothQuickSyncProgress && <div className="top-sync-progress"[\s\S]*?<\/div>\}/;
  if (!topbarPattern.test(source)) throw new Error("one-shot migration: topbar markup not found");
  source = source.replace(topbarPattern, `        <ShellTopbar\n          menuOpen={sidebarOpen}\n          banks={banks}\n          activeBankIds={activeBankIds}\n          syncing={quickSyncing}\n          restoring={quickRestoring}\n          holding={quickSyncHolding}\n          pending={stats.pending}\n          progress={smoothQuickSyncProgress}\n          onToggleMenu={() => setSidebarOpen(!sidebarOpen)}\n          onOpenSearch={(keyword, questionId, contentScope) => { setQuery(keyword); openSearch(questionId, keyword, contentScope); }}\n          onSync={() => void quickSync()}\n          onOpenQueue={() => setSyncDrawerOpen(true)}\n          onPointerDown={beginQuickSyncPress}\n          onPointerMove={moveQuickSyncPress}\n          onPointerUp={endQuickSyncPress}\n          onPointerCancel={cancelQuickSyncPress}\n          onLostPointerCapture={cancelQuickSyncPress}\n        />`);
  const mobilePattern = /      <nav className=\{`mobile-tabbar \$\{view === "practice" \? "hidden" : ""\}`\} aria-label="手机主导航">[\s\S]*?      <\/nav>/;
  if (!mobilePattern.test(source)) throw new Error("one-shot migration: mobile tabbar markup not found");
  source = source.replace(mobilePattern, "      <MobileTabbar view={view} onOpenView={openMainView} />");
  write(file, source);
}

// --- CSS governance: strict zero for transitional escapes/aliases, per-file ratchets for legacy debt. ---
const baselineFile = "scripts/tools/css-architecture-baseline.json";
const cssFiles = walk(fromRoot("src/app"), (file) => file.endsWith(".css")).sort();
const baselineFiles = {};
let totalBytes = 0;
let maxFileBytes = 0;
for (const full of cssFiles) {
  const relative = path.relative(root, full).replaceAll(path.sep, "/");
  const metrics = cssMetrics(fs.readFileSync(full, "utf8"));
  baselineFiles[relative] = metrics;
  totalBytes += metrics.bytes;
  maxFileBytes = Math.max(maxFileBytes, metrics.bytes);
}
write(baselineFile, `${JSON.stringify({ totalBytes, maxFileBytes, files: baselineFiles }, null, 2)}\n`);

write("scripts/tools/check-css-architecture.mjs", `import fs from "node:fs";\nimport path from "node:path";\n\nconst root = process.cwd();\nconst appRoot = path.join(root, "src/app");\nconst stylesRoot = path.join(appRoot, "styles");\nconst baselinePath = path.join(root, "scripts/tools/css-architecture-baseline.json");\nconst fail = (message) => { throw new Error(\`CSS 架构检查失败：\${message}\`); };\nconst requiredStyles = ["base.css", "primitives.css", "shared.css", "shell.css", "dashboard.css", "search.css", "bank.css", "practice.css", "preferences.css", "responsive.css", "dark-overrides.css"];\n\nfunction walk(dir) {\n  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {\n    const full = path.join(dir, entry.name);\n    if (entry.isDirectory()) return walk(full);\n    return entry.isFile() && entry.name.endsWith(".css") ? [full] : [];\n  });\n}\nfunction metrics(source) {\n  return {\n    bytes: Buffer.byteLength(source),\n    hexColors: source.match(/#[0-9a-fA-F]{3,8}\\b/g)?.length ?? 0,\n    darkSelectors: source.match(/html\\[data-theme=["']dark["']\\]/g)?.length ?? 0,\n    important: source.match(/!important\\b/g)?.length ?? 0,\n  };\n}\n\nif (fs.existsSync(path.join(stylesRoot, "legacy-components.css"))) fail("legacy-components.css 必须保持删除，禁止恢复单体样式文件");\nfor (const file of requiredStyles) if (!fs.existsSync(path.join(stylesRoot, file))) fail(\`缺少已拆分样式文件 \${file}\`);\nconst entryPath = path.join(stylesRoot, "components.css");\nconst entrySource = fs.readFileSync(entryPath, "utf8");\nif (Buffer.byteLength(entrySource) > 2048 || /[{}]/.test(entrySource)) fail("components.css 只能维护 @import 顺序，不得承载声明");\nfor (const file of requiredStyles) if (!entrySource.includes(\`@import "./\${file}";\`)) fail(\`components.css 必须导入 \${file}\`);\n\nconst files = walk(appRoot).sort();\nconst sources = files.map((file) => ({ file, source: fs.readFileSync(file, "utf8") }));\nconst globalEscapes = sources.reduce((sum, item) => sum + (item.source.match(/:global\\(/g)?.length ?? 0), 0);\nconst legacyTokenUses = sources.reduce((sum, item) => sum + (item.source.match(/var\\(--(?:paper|ink|muted|line|green|green-soft|orange|white)\\)/g)?.length ?? 0), 0);\nif (globalEscapes !== 0) fail(\`CSS Module :global() 必须为 0，当前为 \${globalEscapes}\`);\nif (legacyTokenUses !== 0) fail(\`旧主题别名必须为 0，当前仍有 \${legacyTokenUses} 处\`);\n\nconst baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));\nconst current = {};\nlet totalBytes = 0;\nlet maxFileBytes = 0;\nfor (const { file, source } of sources) {\n  const relative = path.relative(root, file).replaceAll(path.sep, "/");\n  const value = metrics(source);\n  current[relative] = value;\n  totalBytes += value.bytes;\n  maxFileBytes = Math.max(maxFileBytes, value.bytes);\n  const allowed = baseline.files[relative];\n  if (!allowed) {\n    if (value.hexColors || value.darkSelectors || value.important) fail(\`新 CSS \${relative} 不得新增硬编码颜色、页面级 dark patch 或 !important\`);\n    continue;\n  }\n  for (const key of ["hexColors", "darkSelectors", "important"]) {\n    if (value[key] > allowed[key]) fail(\`\${relative} 的 \${key} 由 \${allowed[key]} 增至 \${value[key]}，历史样式债务只能减少\`);\n  }\n}\nif (totalBytes > baseline.totalBytes) fail(\`CSS 总体积由 \${baseline.totalBytes} 增至 \${totalBytes} bytes；必须先抵消或明确调整基线\`);\nif (maxFileBytes > baseline.maxFileBytes) fail(\`最大 CSS 文件由 \${baseline.maxFileBytes} 增至 \${maxFileBytes} bytes；禁止重建新单体文件\`);\n\nlet tightened = false;\nfor (const relative of Object.keys(baseline.files)) {\n  if (!current[relative]) { delete baseline.files[relative]; tightened = true; continue; }\n  for (const key of ["hexColors", "darkSelectors", "important"]) {\n    if (current[relative][key] < baseline.files[relative][key]) { baseline.files[relative][key] = current[relative][key]; tightened = true; }\n  }\n  baseline.files[relative].bytes = current[relative].bytes;\n}\nfor (const [relative, value] of Object.entries(current)) {\n  if (!baseline.files[relative]) { baseline.files[relative] = value; tightened = true; }\n}\nif (totalBytes < baseline.totalBytes) { baseline.totalBytes = totalBytes; tightened = true; }\nif (maxFileBytes < baseline.maxFileBytes) { baseline.maxFileBytes = maxFileBytes; tightened = true; }\nif (tightened) {\n  fs.writeFileSync(baselinePath, \`\${JSON.stringify(baseline, null, 2)}\\n\`);\n  console.log("CSS 预算棘轮已自动收紧；请提交 css-architecture-baseline.json");\n}\nconsole.log(\`CSS 架构检查通过：\${files.length} files，\${totalBytes} bytes，最大单文件 \${maxFileBytes} bytes，:global=0，legacy aliases=0。\`);\n`);

// Architecture checker delegates CSS debt to the dedicated ratchet and no longer reads the deleted monolith.
{
  const file = "scripts/tools/check-architecture.mjs";
  let source = read(file);
  source = source.replace('import { fileURLToPath } from "node:url";\n', "");
  source = source.replace('const legacyComponents = read("src/app/styles/legacy-components.css");\n', "");
  const cssLegacyBlock = /for \(const \{ file, source \} of appSources\) \{\n  if \(file === "styles\/theme-tokens\.css" \|\| file === "styles\/legacy-components\.css"\)[\s\S]*?\n\}\n\nlet legacyColorBudget[\s\S]*?\n\}\n\nconst studyApp/;
  if (!cssLegacyBlock.test(source)) throw new Error("one-shot migration: legacy CSS architecture block not found");
  source = source.replace(cssLegacyBlock, "const studyApp");
  source = source.replace(/console\.log\(`架构检查通过：[\s\S]*?`\);/, 'console.log("架构检查通过：全新 shijuan-study 数据库命名空间、同步 application boundary、主题令牌完整；公开同步仅写入 v9 namespace/head/checkpoint。");');
  write(file, source);
}

// Keep the CSS ratchet in the ordinary fast-check path, not only the governance workflow.
{
  const file = "package.json";
  let source = read(file);
  source = mustReplace(source,
    '"test:architecture": "node scripts/tools/check-architecture.mjs && node scripts/tools/check-no-native-tooltip-titles.mjs && node scripts/tools/check-button-styles.mjs && node scripts/tools/check-test-registration.mjs"',
    '"test:architecture": "node scripts/tools/check-css-architecture.mjs && node scripts/tools/check-architecture.mjs && node scripts/tools/check-no-native-tooltip-titles.mjs && node scripts/tools/check-button-styles.mjs && node scripts/tools/check-test-registration.mjs"',
    "test:architecture command");
  write(file, source);
}

// Governance audit must verify the external CSS baseline file as well.
{
  const file = ".github/workflows/governance-audit.yml";
  let source = read(file);
  source = mustReplace(source,
    "run: git diff --exit-code -- scripts/tools/check-css-architecture.mjs",
    "run: git diff --exit-code -- scripts/tools/check-css-architecture.mjs scripts/tools/css-architecture-baseline.json",
    "governance CSS baseline diff");
  write(file, source);
}

// Add safe architectural stylelint rules that already hold across the codebase.
{
  const file = "stylelint.config.mjs";
  let source = read(file);
  source = source.replace('    "property-no-unknown": true,\n', '    "property-no-unknown": true,\n    "selector-max-id": 0,\n    "custom-property-pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",\n');
  write(file, source);
}

// Handoff is an operational contract: move all remote protocol wording to v9 and remove obsolete migration instructions.
{
  const file = "docs/HANDOFF.md";
  let source = read(file);
  source = source.replace("更新时间：2026-08-22", "更新时间：2026-08-23");
  source = source.replaceAll("Sync v8", "Sync v9").replaceAll("sync/v8/", "sync/v9/").replaceAll("sync/v8", "sync/v9");
  source = source.replaceAll("v8 历史索引", "v9 历史索引").replaceAll("远端 transport 已完整升级为 v8", "远端 transport 已完整升级为 v9");
  source = source.replace(/^.*一次性远端迁移使用 `npm run migrate:vault:v8.*\n/m, "");
  source = source.replace(/^.*并保留旧 `sync\/v7` 数据.*\n/m, "");
  source = source.replace("公开同步只读写 `sync/v9/*`；旧 `sync/v7/*` 只能由隔离的一次性迁移工具读取。", "公开同步只读写 `sync/v9/*`；运行时代码不得访问已退役的 `sync/v7/*`、`sync/v8/*` 远端命名空间。");
  write(file, source);
}

// Final invariants before the workflow runs the normal test suite.
const allCss = walk(fromRoot("src/app"), (file) => file.endsWith(".css")).map((file) => fs.readFileSync(file, "utf8")).join("\n");
if (/var\(--(?:paper|ink|muted|line|green|green-soft|orange|white)\)/.test(allCss)) throw new Error("one-shot migration: legacy theme aliases remain");
if (/:global\(/.test(allCss)) throw new Error("one-shot migration: :global CSS escape remains");
const syncSources = walk(fromRoot("src/lib/sync"), (file) => file.endsWith(".ts")).filter((file) => path.basename(file) !== "sync-v7-head.ts").map((file) => fs.readFileSync(file, "utf8")).join("\n");
if (/sync\/v[78]\//.test(syncSources)) throw new Error("one-shot migration: retired sync/v7 or sync/v8 namespace remains in runtime sync code");

// The one-shot runner deletes itself and its workflow in the generated commit.
fs.rmSync(fromRoot(".github/workflows/css-migration-once.yml"), { force: true });
fs.rmSync(fromRoot("scripts/tools/migrate-css-architecture-once.mjs"), { force: true });

console.log(`one-shot migration complete: CSS ${legacySource.length} chars split into ${[...buckets.values()].reduce((sum, rules) => sum + rules.length, 0)} ordered rule groups; shell duplicates removed=${migratedShellSelectors.size}; app-shell bytes=${Buffer.byteLength(read("src/app/shell/app-shell.tsx"))}`);
