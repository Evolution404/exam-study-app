import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const write = (p, s) => { const f = path.join(root, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

function splitAtTopLevel(source, target = 12000) {
  const lines = source.split(/(?<=\n)/);
  const chunks = [];
  let chunk = "", depth = 0, comment = false, quote = null, escape = false;
  const scan = (text) => {
    for (let i = 0; i < text.length; i++) {
      const c = text[i], n = text[i + 1];
      if (comment) { if (c === "*" && n === "/") { comment = false; i++; } continue; }
      if (quote) { if (escape) { escape = false; continue; } if (c === "\\") { escape = true; continue; } if (c === quote) quote = null; continue; }
      if (c === "/" && n === "*") { comment = true; i++; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === "{") depth++; else if (c === "}") depth--;
      if (depth < 0) throw new Error("CSS brace underflow");
    }
  };
  for (const line of lines) {
    chunk += line; scan(line);
    if (Buffer.byteLength(chunk) >= target && depth === 0 && !comment && !quote) { chunks.push(chunk.trimEnd() + "\n"); chunk = ""; }
  }
  if (depth !== 0 || comment || quote) throw new Error("CSS ended inside a rule/comment/string");
  if (chunk.trim()) chunks.push(chunk.trimEnd() + "\n");
  return chunks;
}

const specs = [
  { old:"src/app/styles/bank.css", import:"./bank.css", dir:"src/app/bank", stem:"bank-main", rel:(n)=>`../bank/bank-main-${n}.css` },
  { old:"src/app/search/search.css", import:"../search/search.css", dir:"src/app/search", stem:"search-main", rel:(n)=>`../search/search-main-${n}.css` },
  { old:"src/app/styles/shared.css", import:"./shared.css", dir:"src/app/styles", stem:"shared-core", rel:(n)=>`./shared-core-${n}.css` },
  { old:"src/app/styles/practice.css", import:"./practice.css", dir:"src/app/practice", stem:"practice-main", rel:(n)=>`../practice/practice-main-${n}.css` },
  { old:"src/app/styles/sync-events.css", import:null, dir:"src/app/styles", stem:"sync-events", rel:(n)=>`./sync-events-${n}.css`, featureLocal:true },
];

let components = read("src/app/styles/components.css");
let checker = read("scripts/tools/check-css-architecture.mjs");
const baselinePath = "scripts/tools/css-architecture-baseline.json";
const baseline = JSON.parse(read(baselinePath));
const splitFeatureLocal = [];

for (const spec of specs) {
  const source = read(spec.old);
  if (Buffer.byteLength(source) <= 16384) continue;
  const chunks = splitAtTopLevel(source);
  if (chunks.some((c) => Buffer.byteLength(c) > 16384)) throw new Error(`${spec.old}: splitter produced >16 KiB chunk`);
  const imports = [], orderEntries = [];
  const oldMetrics = baseline.files[spec.old] ?? { bytes: Buffer.byteLength(source), hexColors:0, darkSelectors:0, important:0 };
  chunks.forEach((content, i) => {
    const n = i + 1;
    const out = `${spec.dir}/${spec.stem}-${n}.css`;
    write(out, content);
    imports.push(`@import "${spec.rel(n)}";`);
    orderEntries.push(`  "${spec.rel(n)}",`);
    baseline.files[out] = { ...oldMetrics, bytes: Math.min(oldMetrics.bytes, Buffer.byteLength(content)) };
    if (spec.featureLocal) splitFeatureLocal.push(out);
  });
  if (spec.import) {
    components = components.replace(`@import "${spec.import}";`, imports.join("\n"));
    checker = checker.replace(`  "${spec.import}",`, orderEntries.join("\n"));
  }
  delete baseline.files[spec.old];
  fs.unlinkSync(path.join(root, spec.old));
  console.log(`${spec.old} -> ${chunks.length} chunks: ${chunks.map((c)=>Buffer.byteLength(c)).join(", ")}`);
}

if (splitFeatureLocal.length) {
  checker = checker.replace('const featureLocalStyles = new Set(["src/app/styles/sync-events.css"]);', `const featureLocalStyles = new Set(${JSON.stringify(splitFeatureLocal)});`);
}

write("src/app/styles/components.css", components);
write("scripts/tools/check-css-architecture.mjs", checker);
write(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
