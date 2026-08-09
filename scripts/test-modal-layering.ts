import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const portal = read("app/modal-portal.tsx");
const styles = read("app/styles/components.css");

assert.match(portal, /createPortal\(children, document\.body\)/, "modal portal must escape the scrollable app shell");
assert.match(portal, /workspace\.style\.overflow = "hidden"/, "open overlays must lock workspace scrolling");

const overlaySources = [
  ["app/confirm-dialog.tsx", "simple-dialog-backdrop"],
  ["app/question-editor.tsx", "editor-backdrop"],
  ["app/bank-library-view.tsx", "simple-dialog-backdrop"],
  ["app/search-view.tsx", "search-detail-backdrop"],
  ["app/search-view.tsx", "search-practice-backdrop"],
  ["app/study-app.tsx", "overview-backdrop"],
] as const;

for (const [path, className] of overlaySources) {
  const source = read(path);
  assert.ok(source.includes(className), `${path} must still render ${className}`);
  assert.ok(source.includes("<ModalPortal>"), `${path} overlays must render through ModalPortal`);
}

assert.match(styles, /\.simple-dialog-backdrop\{z-index:130\}/, "dialogs must layer above the mobile tab bar");
assert.match(styles, /\.editor-backdrop \{ position:fixed; inset:0; z-index:120;/, "nested question editor must layer above detail drawers");
assert.match(styles, /@media\(max-width:760px\)\{\.restore-card-actions\{grid-column:1\/-1;width:100%;display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/, "mobile restore actions must occupy their own full-width row");

console.log("modal layering tests passed: body portals, scroll lock, z-order and mobile restore layout");
