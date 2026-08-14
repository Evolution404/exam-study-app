import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseNoteMarkdown } from "../lib/note-markdown";

// 个人解析的 Markdown + LaTeX 渲染：解析器是纯函数（lib/note-markdown.ts），
// 渲染组件（app/note-markdown.tsx）复用题干的 katex 懒加载。本测试覆盖块级
// 语法、行内语法、公式哨兵与「未识别内容保持原样」原则，并断言两处解析
// 展示面（题目详情 / 练习结果详情）已接入渲染组件。

// --- 块级语法 -------------------------------------------------------------
{
  const blocks = parseNoteMarkdown("# 口诀\n\n弧垂与安全距离反向变化。\n第二行同段。\n\n- 要点一\n- 要点二\n\n1. 第一步\n2. 第二步\n\n> 引用块\n\n```\ncode $x$ **raw**\n```\n\n---");
  assert.deepEqual(blocks[0], { kind: "heading", level: 1, children: [{ kind: "text", text: "口诀" }] });
  assert.equal(blocks[1]!.kind, "paragraph");
  assert.equal(blocks[1]!.children.length, 1, "纯文字段落保持单一 text 节点");
  assert.deepEqual(blocks[2], { kind: "list", ordered: false, items: [[{ kind: "text", text: "要点一" }], [{ kind: "text", text: "要点二" }]] });
  assert.deepEqual(blocks[3], { kind: "list", ordered: true, items: [[{ kind: "text", text: "第一步" }], [{ kind: "text", text: "第二步" }]] });
  assert.equal(blocks[4]!.kind, "quote");
  assert.deepEqual(blocks[5], { kind: "code", text: "code $x$ **raw**" }, "代码块内不解析任何 markdown/公式");
  assert.deepEqual(blocks[6], { kind: "divider" });
}

// 中文顿号有序列表（1、）也是合法列表项。
assert.deepEqual(
  parseNoteMarkdown("1、检查接地\n2、核对编号")[0],
  { kind: "list", ordered: true, items: [[{ kind: "text", text: "检查接地" }], [{ kind: "text", text: "核对编号" }]] },
);

// 未闭合代码围栏：一直吃到笔记末尾也不丢内容。
assert.deepEqual(parseNoteMarkdown("```\nabc")[0], { kind: "code", text: "abc" });

// --- 行内语法 -------------------------------------------------------------
{
  const [paragraph] = parseNoteMarkdown("弧垂 $h$ 与 $$H$$ 以及 **加粗** *斜体* _下划斜体_ `代码` [链接](https://example.com/a?b=1)");
  const children = paragraph!.children;
  assert.deepEqual(children[1], { kind: "formula", source: "h", display: false });
  assert.deepEqual(children[3], { kind: "formula", source: "H", display: true });
  assert.deepEqual(children[5], { kind: "bold", children: [{ kind: "text", text: "加粗" }] });
  assert.deepEqual(children[7], { kind: "italic", children: [{ kind: "text", text: "斜体" }] });
  assert.deepEqual(children[9], { kind: "italic", children: [{ kind: "text", text: "下划斜体" }] });
  assert.deepEqual(children[11], { kind: "code", text: "代码" });
  assert.deepEqual(children[13], { kind: "link", href: "https://example.com/a?b=1", children: [{ kind: "text", text: "链接" }] });
}

// 行内代码优先于公式提取：反引号里的 $x$ 保持代码字面。
{
  const [paragraph] = parseNoteMarkdown("参数 `$x$` 是代码，而 $y$ 是公式");
  const children = paragraph!.children;
  assert.deepEqual(children[1], { kind: "code", text: "$x$" });
  assert.deepEqual(children[3], { kind: "formula", source: "y", display: false });
}

// 加粗内嵌公式与斜体：强调结构包住公式 token。
{
  const [paragraph] = parseNoteMarkdown("**弧垂 $f$ 很关键**");
  const bold = paragraph!.children[0];
  assert.equal(bold!.kind, "bold");
  assert.deepEqual((bold as { children: unknown[] }).children[1], { kind: "formula", source: "f", display: false });
}

// 未识别 / 不安全的内容保持字面：非 http 链接、未闭合强调、普通数字。
{
  const [paragraph] = parseNoteMarkdown("第 1 题 **未闭合 [文本](javascript:alert(1))");
  const text = paragraph!.children.filter((node) => node.kind === "text").map((node) => (node as { text: string }).text).join("");
  assert.ok(text.includes("第 1 题"), "普通数字文本不受哨兵影响");
  assert.ok(text.includes("**未闭合"), "未闭合强调保持字面");
  assert.ok(text.includes("javascript:alert(1)"), "非 http(s) 链接不渲染为链接");
  assert.ok(!paragraph!.children.some((node) => node.kind === "link"), "危险协议不得产生 link 节点");
}

// 空白笔记 → 空块数组（组件返回 null，调用方展示空态文案）。
assert.deepEqual(parseNoteMarkdown("  \n "), []);

// --- 接线断言 -------------------------------------------------------------
const detail = await readFile(new URL("../app/question-detail.tsx", import.meta.url), "utf8");
const history = await readFile(new URL("../app/practice-history.tsx", import.meta.url), "utf8");
const mathText = await readFile(new URL("../app/math-text.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/styles/components.css", import.meta.url), "utf8");
const renderer = await readFile(new URL("../app/note-markdown.tsx", import.meta.url), "utf8");

assert.match(detail, /import \{ NoteMarkdown \} from "@\/app\/note-markdown"/, "题目详情接入 NoteMarkdown");
assert.match(detail, /\{note \? <NoteMarkdown text=\{note\} \/> : <p>/, "有解析时渲染 markdown，空态保留原提示");
assert.match(history, /import \{ NoteMarkdown \} from "@\/app\/note-markdown"/, "练习结果详情接入 NoteMarkdown");
assert.match(mathText, /export \{ loadKatex \}/, "math-text 导出懒加载供解析渲染复用");
assert.match(renderer, /loadKatex/, "解析渲染复用 katex 懒加载");
assert.match(renderer, /parseNoteMarkdown/, "渲染组件驱动纯解析器");
assert.match(styles, /\.note-markdown p\{/, "note-markdown 样式存在");
assert.match(styles, /html\[data-theme="dark"\] :is\([^)]*\.note-markdown p/, "夜间模式并入既有选择器（不新增页面级夜间规则）");

console.log("note markdown tests passed: 解析器块级/行内/公式/安全性 + 详情双端接线");
