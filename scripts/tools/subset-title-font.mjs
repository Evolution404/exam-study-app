/**
 * 构建时自动子集化标题衬线字体（Noto Serif SC）。
 *
 * 扫描 app/ 与 lib/ 源码里的静态中文文案，提取唯一汉字 + 常用中文标点，
 * 从完整简体中文字体里只切出这些字形，输出一个极小的 woff2 和一个
 * @font-face。每次 build / dev 前由 prebuild / predev 自动运行，因此文案
 * 一旦改动，下一次构建就会生成包含新字的字体，避免「字不在子集里导致
 * 回退系统字体」的不一致。
 *
 * 动态内容（题干、题库名、题组名、标签名等用户数据）不走这个衬线字体，
 * 而是用正文黑体；这里只覆盖代码里写死的 UI 标题文案。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const subsetFont = require("subset-font");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_FONT = path.join(root, "node_modules/@fontsource/noto-serif-sc/files/noto-serif-sc-chinese-simplified-600-normal.woff2");
const OUT_DIR = path.join(root, "src/generated");
const OUT_FONT = path.join(OUT_DIR, "noto-serif-sc-title.woff2");
const OUT_CSS = path.join(OUT_DIR, "title-font.css");

// 标题文案里可能出现的常用中文标点/符号（英文数字由 Georgia 覆盖，无需打包）。
const EXTRA_GLYPHS = "，。、；：！？（）《》【】“”‘’…—·×÷±%‰→←↑↓①②③④⑤⑥⑦⑧⑨⑩";

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "styles" || entry.name === "dist" || entry.name === ".vinext") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function collectChars() {
  const files = [...walk(path.join(root, "src/app")), ...walk(path.join(root, "src/lib"))];
  const chars = new Set(EXTRA_GLYPHS);
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const ch of source) if (/[一-鿿]/.test(ch)) chars.add(ch);
  }
  return [...chars].join("");
}

async function main() {
  const text = collectChars();
  const source = fs.readFileSync(SOURCE_FONT);
  const subset = await subsetFont(source, text, { targetFormat: "woff2" });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FONT, subset);
  // 与 @fontsource 同名，静态标题的 CSS 无需改动；字重 range 覆盖 500/600。
  fs.writeFileSync(OUT_CSS, [
    '@font-face {',
    '  font-family: "Noto Serif SC";',
    '  font-style: normal;',
    '  font-weight: 500 600;',
    '  font-display: swap;',
    '  src: url("./noto-serif-sc-title.woff2") format("woff2");',
    '}',
    '',
  ].join("\n"));

  const kb = (subset.length / 1024).toFixed(1);
  console.log(`标题字体子集化完成：${[...text].length} 个字形 → ${kb} KB（源 ${(source.length / 1024 / 1024).toFixed(1)} MB）`);
}

main().catch((error) => {
  console.error("标题字体子集化失败：", error);
  process.exit(1);
});
