import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const entry = path.join(root, "proxy", "pages-function.js");
const outfile = path.join(root, "functions", "api-github", "[[path]].js");

await mkdir(path.dirname(outfile), { recursive: true });

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  banner: {
    js: "// AUTO-GENERATED from proxy/pages-function.js by scripts/tools/emit-pages-relay.mjs. Do not edit.",
  },
});

console.log(`pages relay emitted: ${path.relative(root, outfile)}`);
