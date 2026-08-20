import fs from "node:fs";

const path = "scripts/tools/apply-v7-live-gc.mjs";
let source = fs.readFileSync(path, "utf8");
const broken = '            const prefix = \\`${storageKey}/\\`;';
const fixed = '            const prefix = storageKey + "/";';
if (!source.includes(broken)) throw new Error("v7 GC migration fix target not found");
source = source.replace(broken, fixed);
fs.writeFileSync(path, source);
console.log("v7 GC migration nested template fixed");
