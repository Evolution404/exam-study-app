import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const portal = read("src/app/ui/modal-portal.tsx");
const styles = read("src/app/styles/components.css");
const confirmDialog = read("src/app/ui/confirm-dialog.tsx");
const studyApp = read("src/app/shell/app-shell.tsx");
const practiceView = read("src/app/shell/views.tsx");
const syncView = read("src/app/sync/sync-view.tsx");
const credentials = read("src/lib/sync/github-credentials.ts");

assert.match(portal, /createPortal\(children, document\.body\)/, "modal portal must escape the scrollable app shell");
assert.match(portal, /workspace\.style\.overflow = "hidden"/, "open overlays must lock workspace scrolling");

const overlaySources = [
  ["src/app/ui/confirm-dialog.tsx", "simple-dialog-backdrop"],
  ["src/app/bank/question-editor.tsx", "editor-backdrop"],
  ["src/app/bank/bank-library-view.tsx", "simple-dialog-backdrop"],
  ["src/app/bank/question-detail.tsx", "search-detail-backdrop"],
  ["src/app/search/search-view.tsx", "search-practice-backdrop"],
  ["src/app/search/search-filter-drawer.tsx", "search-filter-backdrop"],
  ["src/app/shell/views.tsx", "overview-backdrop"],
] as const;

for (const [path, className] of overlaySources) {
  const source = read(path);
  assert.ok(source.includes(className), `${path} must still render ${className}`);
  assert.ok(source.includes("<ModalPortal>"), `${path} overlays must render through ModalPortal`);
}

assert.match(styles, /\.simple-dialog-backdrop\{z-index:130\}/, "dialogs must layer above the mobile tab bar");
assert.match(styles, /\.editor-backdrop \{ position:fixed; inset:0; z-index:120;/, "nested question editor must layer above detail drawers");
assert.match(styles, /@media\(max-width:760px\)\{\.restore-card-actions\{grid-column:1\/-1;width:100%;display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/, "mobile restore actions must occupy their own full-width row");
assert.ok(confirmDialog.includes("dialog-progress"), "busy confirmation dialogs must render operation progress");
assert.ok(studyApp.includes("top-sync-progress"), "top-bar sync must expose page-level progress");
assert.ok(syncView.includes("progress={smoothProgress}"), "sync view must show (smoothed) progress in a modal");
assert.ok(credentials.includes("localStorage.setItem(tokenKey, token)"), "GitHub token must survive a closed mobile tab");
assert.match(styles, /\.mobile-sync-settings\{display:block/, "mobile configuration must include sync settings");
assert.match(styles, /\.desktop-shortcut-settings[^}]*display:none!important/, "mobile configuration must hide keyboard shortcuts");
assert.ok(practiceView.includes('matchMedia("(max-width: 760px)").matches) return'), "mobile practice must disable keyboard shortcut listeners");

console.log("modal and mobile UI tests passed: layering, progress, persistent credentials, merged settings and shortcut disabling");
