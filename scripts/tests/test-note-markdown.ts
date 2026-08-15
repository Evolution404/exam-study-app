import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseNoteMarkdown } from "../../lib/note-markdown";

// 个人解析的 Markdown + LaTeX 渲染：解析器是纯函数（lib/note-markdown.ts），
// 渲染组件（app/note-markdown.tsx）复用题干的 katex 懒加载。覆盖块级语法、
// 嵌套列表、续行、行内语法、公式哨兵与「未识别内容保持原样」原则，并断言
// 三处展示面（题目详情 / 练习结果详情 / 答题面板点击切换）的接线。

// --- 块级语法 -------------------------------------------------------------
{
  const blocks = parseNoteMarkdown("# 口诀\n\n弧垂与安全距离反向变化。\n第二行同段。\n\n- 要点一\n- 要点二\n\n> 引用块\n\n```\ncode $x$ **raw**\n```\n\n---");
  assert.deepEqual(blocks[0], { kind: "heading", level: 1, children: [{ kind: "text", text: "口诀" }] });
  assert.equal(blocks[1]!.kind, "paragraph");
  assert.equal(blocks[1]!.children.length, 1, "纯文字段落保持单一 text 节点");
  assert.deepEqual(blocks[2], { kind: "list", ordered: false, items: [{ inline: [{ kind: "text", text: "要点一" }], children: [] }, { inline: [{ kind: "text", text: "要点二" }], children: [] }] });
  assert.equal(blocks[3]!.kind, "quote");
  assert.deepEqual(blocks[4], { kind: "code", text: "code $x$ **raw**" }, "代码块内不解析任何 markdown/公式");
  assert.deepEqual(blocks[5], { kind: "divider" });
}

// --- 嵌套列表（缩进栈）---------------------------------------------------
{
  const [nested] = parseNoteMarkdown("- 父项一\n  - 子项 a\n  - 子项 b\n    - 孙项\n- 父项二");
  assert.equal(nested!.kind, "list");
  const items = (nested as { items: Array<{ inline: unknown[]; children: unknown[] }> }).items;
  assert.equal(items.length, 2, "两个顶级项");
  assert.equal(items[0]!.children.length, 1, "父项一下挂一个子列表");
  const childList = items[0]!.children[0] as { kind: string; items: Array<{ inline: unknown[]; children: unknown[] }> };
  assert.equal(childList.kind, "list");
  assert.equal(childList.items.length, 2);
  assert.equal(childList.items[1]!.children.length, 1, "子项 b 下还有孙列表");
}
{
  // 有序列表内嵌无序子列表：归入子级而不是断块重启序号。
  const [ordered] = parseNoteMarkdown("1. 第一步\n   - 细节一\n   - 细节二\n2. 第二步");
  assert.equal(ordered!.kind, "list");
  const outer = ordered as { ordered: boolean; items: Array<{ children: unknown[] }> };
  assert.equal(outer.ordered, true);
  assert.equal(outer.items.length, 2, "外层保持 2 项，序号不断");
  assert.equal(outer.items[0]!.children.length, 1, "细节归入第一步的子列表");
}
{
  // 同级 marker 类型切换：拆成两个列表块（不再把有序项并进无序列表）。
  const blocks = parseNoteMarkdown("- 甲\n- 乙\n1. 一\n2. 二");
  assert.equal(blocks.length, 2);
  assert.equal((blocks[0] as { ordered: boolean }).ordered, false);
  assert.equal((blocks[1] as { ordered: boolean }).ordered, true);
}
{
  // 列表项续行：无 marker 的缩进行并入上一个列表项，不切成段落。
  const [list] = parseNoteMarkdown("- 要点说明很长\n  这是第二行补充\n- 下一个要点");
  const items = (list as { items: Array<{ inline: Array<{ kind: string; text?: string }> }> }).items;
  assert.equal(items.length, 2, "续行不产生新列表项");
  assert.deepEqual(items[0]!.inline.map((node) => `${node.kind}:${node.text ?? ""}`), ["text:要点说明很长", "text:\n这是第二行补充"], "续行追加到上一项");
}
{
  // 中文顿号有序列表（1、）也是合法列表项。
  assert.deepEqual(
    parseNoteMarkdown("1、检查接地\n2、核对编号")[0],
    { kind: "list", ordered: true, items: [{ inline: [{ kind: "text", text: "检查接地" }], children: [] }, { inline: [{ kind: "text", text: "核对编号" }], children: [] }] },
  );
}

// --- 块级公式独立成块 ------------------------------------------------------
{
  const blocks = parseNoteMarkdown("前文\n\n$$E = mc^2$$\n\n后文 \\[a+b\\] 结尾");
  assert.deepEqual(blocks[1], { kind: "formula", source: "E = mc^2" }, "整行 $$ 公式独立成块");
  const tail = blocks[2]!;
  assert.equal(tail.kind, "paragraph");
  assert.ok(tail.children.some((node) => node.kind === "formula" && node.display), "行内 \\[ \\] 仍是 display 公式 inline 节点");
}

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

// 加粗内嵌公式：强调结构包住公式 token。
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
const detail = await readFile(new URL("../../app/question-detail.tsx", import.meta.url), "utf8");
const history = await readFile(new URL("../../app/practice-history.tsx", import.meta.url), "utf8");
const studyApp = await readFile(new URL("../../app/study-app.tsx", import.meta.url), "utf8");
const editor = await readFile(new URL("../../app/question-editor.tsx", import.meta.url), "utf8");
const mathText = await readFile(new URL("../../app/math-text.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../../app/styles/components.css", import.meta.url), "utf8");
const renderer = await readFile(new URL("../../app/note-markdown.tsx", import.meta.url), "utf8");

assert.match(detail, /import \{ NoteMarkdown \} from "@\/app\/note-markdown"/, "题目详情接入 NoteMarkdown");
assert.match(detail, /\{note \? <NoteMarkdown text=\{note\} \/> : <p>/, "有解析时渲染 markdown，空态保留原提示");
assert.match(history, /import \{ NoteMarkdown \} from "@\/app\/note-markdown"/, "练习结果详情接入 NoteMarkdown");
assert.match(mathText, /export \{ loadKatex \}/, "math-text 导出懒加载供解析渲染复用");
assert.match(renderer, /loadKatex/, "解析渲染复用 katex 懒加载");
assert.match(renderer, /parseNoteMarkdown/, "渲染组件驱动纯解析器");
assert.match(renderer, /note-md-display-formula/, "块级公式独立渲染");
assert.match(renderer, /renderItems/, "嵌套列表递归渲染");
assert.match(studyApp, /note-panel-view/, "答题面板有渲染态视图");
assert.match(studyApp, /setNoteEditing\(true\)/, "点击渲染态进入编辑");
assert.match(studyApp, /onBlur=\{\(\) => \{ if \(effectiveDraft\.trim\(\)\) setNoteEditing\(false\); \}\}/, "失焦且非空时回到渲染态");
assert.match(studyApp, /lastNoteQuestionId\.current !== question\.id[\s\S]{0,120}setNoteEditing\(false\)/, "换题重置编辑态（渲染期调整，非 effect 内 setState）");
assert.match(studyApp, /aria-label="编辑解析，支持 Markdown 与 LaTeX"/, "渲染态可聚焦可无障碍进入编辑");
assert.match(editor, /支持 Markdown 与 LaTeX 公式/, "编辑器提示文案更新");
assert.match(styles, /\.note-markdown h4\{font-size:13\.5px\}/, "标题层级拉开字号");
assert.match(styles, /\.note-markdown blockquote\{[^}]*white-space:pre-line/, "引用换行行为与段落一致");
assert.match(styles, /\.note-panel-view\{/, "渲染态视图样式存在");
assert.match(styles, /html\[data-theme="dark"\] :is\([^)]*\.note-markdown p/, "夜间模式并入既有选择器（不新增页面级夜间规则）");

// --- 防回退：详情页选项样式不得穿透 markdown（bug：列表被渲染成选项盒） ------
// .search-detail-body 的选项列表样式必须收敛到直接子级（> ol > li），
// 否则 .note-markdown 的 ol/li/span 会被渲染成答题选项按钮。
const bareDescendant = /\.search-detail-body\s+(ol|li)[{,>:]/;
assert.ok(!bareDescendant.test(styles), "components.css 不得存在 .search-detail-body ol/li 裸后代选择器（会穿透 markdown 列表）");
assert.match(styles, /\.search-detail-body>ol>li>span\s*\{/, "选项徽章样式限定为直接子级");
assert.ok(!/html\[data-theme="dark"\][^{}]*\.search-detail-body\s+li[{,>]/.test(styles), "夜间规则同样不得用裸后代选择器命中 markdown li");
assert.match(styles, /\.note-markdown ol\{[^}]*display:block/, "markdown 有序列表兜底 display:block");
assert.match(styles, /\.note-markdown li\{[^}]*display:list-item/, "markdown 列表项兜底 display:list-item（::marker 序号可见）");

// --- 防回退：夜间全站 input !important 不得污染透明输入框 --------------------
// :288 的夜间 input 规则强制 #111813；搜索类输入框必须显式补 transparent!important。
assert.match(
  styles,
  /html\[data-theme="dark"\] :is\([^)]*\.searchbox input[^)]*\.search-home-query input[^)]*\)\{background:transparent!important\}/,
  "夜间模式搜索类 input 保持透明底（容器/input 无色差）",
);

// --- 防回退：详情页底部按钮夜间颜色（bug：夜间 >footer>button 匹配不到按钮） ----
// 浅色规则是后代选择器 >footer button（命中 .search-detail-actions 内的按钮），
// 夜间规则必须同作用域，否则按钮保持浅色 #fff。
assert.match(styles, /\.search-question-detail>footer button\s*\{[^}]*background:#fff/, "浅色规则覆盖 footer 全部按钮");
assert.match(styles, /html\[data-theme="dark"\] :is\([^)]*\.search-question-detail>footer button[^)]*\)\{[^}]*background:#111813/, "夜间规则与浅色规则同作用域（后代选择器）");
assert.ok(!styles.includes(".search-question-detail>footer>button"), "夜间/样式规则不得用 >footer>button 子选择器漏掉 actions 内按钮");

// --- 防回退：空解析首字退出编辑（bug：渲染条件翻转卸载 textarea） ------------
assert.match(studyApp, /onFocus=\{\(\) => setNoteEditing\(true\)\}/, "解析 textarea 聚焦即进入编辑态（空解析首字不退出）");

// --- 防回退：搜索页吸附设计（顶栏滚走 / 搜索框钉顶 / 批量栏紧贴） ------------
assert.match(studyApp, /className=\{`workspace \$\{view === "search" \? "view-search" : ""\}`\}/, "搜索视图给 workspace 打 view-search 标记");
assert.match(styles, /\.workspace\.view-search \.topbar\s*\{\s*position:relative;\s*z-index:30/, "搜索页内全局顶栏不固定（随内容滚走，但需要更高层叠让快速搜索预览不被遮挡）");
assert.match(styles, /\.search-home-query \{ position:sticky; top:0; z-index:19/, "搜索页搜索框钉在顶部");
assert.match(styles, /--search-query-h:58px/, "搜索框高度以变量定义");
assert.match(styles, /\.search-batch-bar \{ position:sticky; top:calc\(var\(--search-query-h\) \+ env\(safe-area-inset-top\)\)/, "批量栏吸附高度与搜索框高度同源");
assert.ok(!styles.includes("top:87px"), "批量栏旧的 top:87px（吸附全局顶栏）已删除");
assert.ok(!styles.includes("#f8fbf8f2") && !/:is\(\.search-view-all,\.search-batch-bar,/.test(styles), "批量栏底色已 token 化（无硬编码浅/深底色）");
assert.match(styles, /\.search-page\.search-pinned \.search-home-query\s*\{[^}]*border-top-left-radius:0[^}]*border-top:0/, "搜索框吸顶后上圆角压平贴顶（去上边框）");
assert.ok(!/\.search-page\.search-pinned \.search-home-query[^}]*border-bottom-left-radius:0/.test(styles), "搜索框吸附后下边缘保持圆角（不直角化）");
assert.match(styles, /\.search-page\.search-stuck \.search-batch-bar\s*\{[^}]*border-top-left-radius:0/, "批量栏吸附后去掉上圆角（与搜索框无缝相接，无圆角缺口）");
assert.ok(!/\.search-page\.search-stuck \.search-home-query/.test(styles), "搜索框下边缘不受批量栏吸附影响（保持圆角）");
assert.match(styles, /\.search-home-query \{ position:sticky; top:0; z-index:19; min-height:var\(--search-query-h\);[^}]*border-radius:15px/, "搜索框自然位置保持完整圆角卡片");

console.log("note markdown tests passed: 块级/嵌套列表/续行/块级公式/行内/安全性 + 三处展示面接线 + 防穿透/夜间/编辑态/搜索吸附防回退");
