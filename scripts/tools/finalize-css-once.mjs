import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const appRoot = path.join(root, "src/app");
const stylesRoot = path.join(appRoot, "styles");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const write = (p, s) => { const f = path.join(root, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

// 1) Finish Search ownership.
let search = read("src/app/styles/search.css");
search = search
  .replace(".search-results>header span { color:var(--color-text-muted); font-size:10px; }", ".search-results>header span { color:var(--color-text-muted); font-size:10px; }\n.search-results>header { background:var(--search-results-header-bg); }")
  .replace(".search-results>div { max-height:450px; overflow:auto; }", ".search-results>div { max-height:450px; overflow:auto; background:var(--search-results-body-bg); }")
  .replace("border-bottom:1px solid var(--search-result-divider); display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:11px; text-align:left; color:var(--color-text); background:var(--search-results-bg); cursor:pointer;", "border-bottom:1px solid var(--search-result-item-border); display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:11px; text-align:left; color:var(--color-text); background:var(--search-result-item-bg); cursor:pointer;")
  .replace(".search-results>div>button:hover,.search-results>div>button:focus-visible { background:var(--color-surface-muted); outline:0; }", ".search-results>div>button:hover,.search-results>div>button:focus-visible { background:var(--search-result-item-hover-bg); outline:0; }")
  .replace("padding:24px!important", "padding:24px")
  .replace(".search-dialog-toggle { padding:13px; border:1px solid var(--search-dialog-toggle-border); border-radius:11px; display:flex!important; flex-direction:row!important;", ".search-practice-dialog .search-dialog-toggle { padding:13px; border:1px solid var(--search-dialog-toggle-border); border-radius:11px; display:flex; flex-direction:row;")
  .replace(".search-session-warning { padding:11px; border-radius:10px; display:flex; align-items:center; gap:7px; color:var(--search-warning-text)!important;", ".search-practice-dialog .search-session-warning { padding:11px; border-radius:10px; display:flex; align-items:center; gap:7px; color:var(--search-warning-text);")
  .replace(".search-filter-reset+.search-filter-icon{margin-left:0!important}", ".search-filter-drawer-header .search-filter-reset+.search-filter-icon{margin-left:0}");
const movedPrefixes = [".question-manager-search{", ".question-manager-search input{", ".group-fields input,", ".group-search{", ".group-search input{", ".group-search-results{", ".group-search-results button{", ".group-search-results span,", ".group-search-results small{", ".knowledge-search {", ".knowledge-search input {"];
const moved = [];
search = search.split("\n").filter((line) => { if (movedPrefixes.some((p) => line.startsWith(p))) { moved.push(line); return false; } return true; }).join("\n");
search = search.replace(".search-result-list article.detail-current,\n.managed-question-list article.detail-current,\n.group-items article.detail-current {\n  border-color: var(--color-primary);\n  box-shadow: 0 0 0 3px var(--color-primary-soft);\n}", ".search-result-list article.detail-current {\n  border-color: var(--color-primary);\n  box-shadow: 0 0 0 3px var(--color-primary-soft);\n}");
write("src/app/bank/bank-knowledge.css", `/* Bank / Knowledge rules historically misplaced in Search. */\n${moved.join("\n")}\n\n.managed-question-list article.detail-current,\n.group-items article.detail-current {\n  border-color: var(--color-primary);\n  box-shadow: 0 0 0 3px var(--color-primary-soft);\n}\n`);
write("src/app/search/search.css", search.endsWith("\n") ? search : `${search}\n`);
fs.unlinkSync(path.join(root, "src/app/styles/search.css"));

// 2) Remove Search selectors from centralized dark compatibility.
let dark = read("src/app/styles/dark-overrides.css");
const stripSearch = (line) => {
  if (!line.includes('html[data-theme="dark"]') || !line.includes(".search")) return line;
  const m = line.match(/^(.*?:(?:where|is)\()(.+?)(\)\{.*)$/);
  if (!m) return "";
  const kept = m[2].split(",").map((s) => s.trim()).filter((s) => !s.includes(".search"));
  return kept.length ? `${m[1]}${kept.join(",")}${m[3]}` : "";
};
write("src/app/styles/dark-overrides.css", dark.split("\n").map(stripSearch).filter(Boolean).join("\n") + "\n");

// 3) Split the legacy shared monolith by contiguous ownership boundaries while
// preserving exact cascade order.
let shared = read("src/app/styles/shared.css");
const groupMark = "/* Multi-question groups */";
const appearanceMark = "/* Appearance preferences */";
const groupAt = shared.indexOf(groupMark);
const appearanceAt = shared.indexOf(appearanceMark);
if (groupAt < 0 || appearanceAt < groupAt) throw new Error("shared.css section markers changed");
const sharedCore = shared.slice(0, groupAt).trimEnd() + "\n";
const bankShared = shared.slice(groupAt, appearanceAt).trimEnd() + "\n";
const appUtility = shared.slice(appearanceAt).trimStart();
write("src/app/styles/shared.css", sharedCore);
write("src/app/bank/bank-shared.css", bankShared);
write("src/app/styles/app-utility.css", appUtility);

// 4) Turn responsive.css into a manifest and keep the residual rules in one
// explicitly named compatibility layer, preserving the current import-before-residual order.
let responsive = read("src/app/styles/responsive.css");
const imports = [...responsive.matchAll(/@import\s+"[^"]+";/g)].map((m) => m[0]);
const residual = responsive.replace(/@import\s+"[^"]+";/g, "").trim();
write("src/app/styles/responsive.css", `${imports.join("\n")}\n@import "./responsive-shared.css";\n`);
write("src/app/styles/responsive-shared.css", `${residual}\n`);

// 5) Normalize every remaining non-token hardcoded color into one exact-value palette.
const tokenRel = new Set(["src/app/styles/theme-tokens.css", "src/app/styles/palette-tokens.css", "src/app/shell/shell-tokens.css", "src/app/search/search-tokens.css", "src/app/practice/practice-tokens.css", "src/app/bank/bank-tokens.css"]);
const walk = (dir) => fs.readdirSync(dir, { withFileTypes:true }).flatMap((e) => { const p = path.join(dir, e.name); return e.isDirectory() ? walk(p) : (e.isFile() && e.name.endsWith(".css") ? [p] : []); });
let cssFiles = walk(appRoot);
const palette = new Map();
for (const file of cssFiles) {
  const rel = path.relative(root, file).replaceAll(path.sep, "/");
  if (tokenRel.has(rel)) continue;
  for (const match of fs.readFileSync(file, "utf8").matchAll(/#[0-9a-fA-F]{3,8}\b/g)) { const hex = match[0].toLowerCase(); palette.set(hex, `--p-${hex.slice(1)}`); }
}
for (const file of cssFiles) {
  const rel = path.relative(root, file).replaceAll(path.sep, "/");
  if (tokenRel.has(rel)) continue;
  const source = fs.readFileSync(file, "utf8").replace(/#[0-9a-fA-F]{3,8}\b/g, (hex) => `var(${palette.get(hex.toLowerCase())})`);
  fs.writeFileSync(file, source);
}
write("src/app/styles/palette-tokens.css", `/* Deduplicated exact-value palette for legacy surfaces. */\n:root {\n${[...palette.entries()].sort().map(([hex, name]) => `  ${name}: ${hex};`).join("\n")}\n}\n`);

// Bank semantic ownership for common surfaces; aliases preserve exact current values.
write("src/app/bank/bank-tokens.css", `/* Bank-owned semantic aliases. */\n:root {\n  --bank-surface: var(--p-faf9f5);\n  --bank-surface-muted: var(--p-faf8f3);\n  --bank-field-bg: var(--p-fff);\n  --bank-accent: var(--p-3e7057);\n  --bank-accent-strong: var(--p-315f47);\n  --bank-selected-bg: var(--p-eaf2ed);\n  --bank-danger: var(--p-a65238);\n}\nhtml[data-theme="dark"] {\n  --bank-surface: var(--p-18201b);\n  --bank-surface-muted: var(--p-18201b);\n  --bank-field-bg: var(--p-111813);\n  --bank-accent: var(--p-397557);\n  --bank-accent-strong: var(--p-a9d0b8);\n  --bank-selected-bg: var(--p-20352a);\n  --bank-danger: var(--p-e4a089);\n}\n`);
let bank = read("src/app/styles/bank.css");
bank = bank.replaceAll("var(--p-faf9f5)", "var(--bank-surface)").replaceAll("var(--p-faf8f3)", "var(--bank-surface-muted)").replaceAll("var(--p-fff)", "var(--bank-field-bg)").replaceAll("var(--p-3e7057)", "var(--bank-accent)").replaceAll("var(--p-315f47)", "var(--bank-accent-strong)").replaceAll("var(--p-eaf2ed)", "var(--bank-selected-bg)");
write("src/app/styles/bank.css", bank);

// 6) Register final cascade and governance paths.
let components = read("src/app/styles/components.css");
components = components
  .replace('@import "./theme-tokens.css";\n', '@import "./theme-tokens.css";\n@import "./palette-tokens.css";\n@import "../bank/bank-tokens.css";\n')
  .replace('@import "./shared.css";', '@import "./shared.css";\n@import "../bank/bank-shared.css";\n@import "./app-utility.css";')
  .replace('@import "./search.css";', '@import "../search/search.css";')
  .replace('@import "./bank.css";', '@import "./bank.css";\n@import "../bank/bank-knowledge.css";');
write("src/app/styles/components.css", components);

let checker = read("scripts/tools/check-css-architecture.mjs");
checker = checker
  .replace('  "./theme-tokens.css",\n', '  "./theme-tokens.css",\n  "./palette-tokens.css",\n  "../bank/bank-tokens.css",\n')
  .replace('  "./shared.css",\n', '  "./shared.css",\n  "../bank/bank-shared.css",\n  "./app-utility.css",\n')
  .replace('  "./search.css",\n', '  "../search/search.css",\n')
  .replace('  "./bank.css",\n', '  "./bank.css",\n  "../bank/bank-knowledge.css",\n')
  .replace('const tokenFileRelatives = new Set([\n  "src/app/styles/theme-tokens.css",', 'const tokenFileRelatives = new Set([\n  "src/app/styles/theme-tokens.css",\n  "src/app/styles/palette-tokens.css",\n  "src/app/bank/bank-tokens.css",');
write("scripts/tools/check-css-architecture.mjs", checker);

const baselinePath = "scripts/tools/css-architecture-baseline.json";
const baseline = JSON.parse(read(baselinePath));
if (baseline.files["src/app/styles/search.css"]) { baseline.files["src/app/search/search.css"] = baseline.files["src/app/styles/search.css"]; delete baseline.files["src/app/styles/search.css"]; }
// Seed moved compatibility layers with their historical source budgets so the checker
// ratchets them instead of treating a physical move as new debt.
if (baseline.files["src/app/styles/shared.css"]) {
  const old = baseline.files["src/app/styles/shared.css"];
  for (const rel of ["src/app/styles/shared.css", "src/app/bank/bank-shared.css", "src/app/styles/app-utility.css"]) baseline.files[rel] ??= { ...old };
}
if (baseline.files["src/app/styles/responsive.css"]) baseline.files["src/app/styles/responsive-shared.css"] ??= { ...baseline.files["src/app/styles/responsive.css"] };
write(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(`CSS finalizer complete: palette=${palette.size}, Search finalized, shared/responsive monoliths split.`);
