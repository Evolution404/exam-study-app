import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const stylesRoot = path.join(root, "src/app");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith(".css") ? [full] : [];
  });
}

const files = walk(stylesRoot).map((full) => {
  const source = fs.readFileSync(full, "utf8");
  const relative = path.relative(root, full);
  const bytes = Buffer.byteLength(source);
  const hexColors = source.match(/#[0-9a-fA-F]{3,8}\b/g)?.length ?? 0;
  const darkSelectors = source.match(/html\[data-theme=["']dark["']\]/g)?.length ?? 0;
  const important = source.match(/!important\b/g)?.length ?? 0;
  const globalEscapes = source.match(/:global\(/g)?.length ?? 0;
  const legacyTokenUses = source.match(/var\(--(?:paper|ink|muted|line|green|green-soft|orange|white)\)/g)?.length ?? 0;
  return { relative, bytes, hexColors, darkSelectors, important, globalEscapes, legacyTokenUses };
}).sort((a, b) => b.bytes - a.bytes);

const totals = files.reduce((sum, file) => ({
  bytes: sum.bytes + file.bytes,
  hexColors: sum.hexColors + file.hexColors,
  darkSelectors: sum.darkSelectors + file.darkSelectors,
  important: sum.important + file.important,
  globalEscapes: sum.globalEscapes + file.globalEscapes,
  legacyTokenUses: sum.legacyTokenUses + file.legacyTokenUses,
}), { bytes: 0, hexColors: 0, darkSelectors: 0, important: 0, globalEscapes: 0, legacyTokenUses: 0 });

console.log("CSS governance baseline");
console.log(`files: ${files.length}`);
console.log(`total bytes: ${totals.bytes}`);
console.log(`hard-coded colors: ${totals.hexColors}`);
console.log(`dark-theme selectors: ${totals.darkSelectors}`);
console.log(`!important uses: ${totals.important}`);
console.log(`CSS Module :global escapes: ${totals.globalEscapes}`);
console.log(`legacy token alias uses: ${totals.legacyTokenUses}`);
console.log("\nLargest CSS files:");
for (const file of files.slice(0, 12)) {
  console.log(`${String(file.bytes).padStart(7)}  ${file.relative}  hex=${file.hexColors} dark=${file.darkSelectors} important=${file.important} global=${file.globalEscapes} legacyTokens=${file.legacyTokenUses}`);
}
