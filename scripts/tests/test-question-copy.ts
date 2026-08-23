import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { answerText, buildQuestionCopyText, displayedAnswer } from "../../src/lib/question/question-copy";

// ===== 纯函数：buildQuestionCopyText =====

const single = { type: "单选", stem: "导线的主要作用是什么？", options: ["传输电能", "装饰线路", "储存电能"], answer: "A" };

// 1) 无参：恰为 题型/题目/选项 三段，绝不泄漏答案（复制题目核心契约）。
const plain = buildQuestionCopyText(single);
assert.equal(plain, [
  "题型：单选",
  "题目：导线的主要作用是什么？",
  "选项：",
  "A. 传输电能",
  "B. 装饰线路",
  "C. 储存电能",
].join("\n"), "无参复制应为题型/题目/选项三段");
assert.doesNotMatch(plain, /正确答案|答案内容|我的选择/, "不含答案版不得泄漏答案内容");

// 2) displayOrder 打乱：选项行按显示位置重编号（A. = displayOrder[0] 指向的原始选项）。
const shuffled = buildQuestionCopyText(single, { displayOrder: [2, 0, 1] });
assert.match(shuffled, /^A\. 储存电能$/m, "displayOrder 后首行 A 应为原始第三项");
assert.match(shuffled, /^B\. 传输电能$/m, "displayOrder 后第二行 B 应为原始第一项");

// 3) includeAnswer + displayOrder：正确答案只输出映射后的显示字母（不带选项文本，用户口径）。
const withAnswer = buildQuestionCopyText(single, { displayOrder: [2, 0, 1], includeAnswer: true });
assert.match(withAnswer, /正确答案：B\b/, "正确答案应为映射后显示字母");
assert.doesNotMatch(withAnswer, /正确答案：B\./, "正确答案不得附带选项文本");
assert.doesNotMatch(withAnswer, /答案内容/, "不得再输出独立的答案内容行");

// 4) 多选做错：我的选择只带显示字母（用户口径：不要选项内容），按显示位置排序拼接。
const multi = { type: "多选", stem: "哪些做法有助于安全巡视？", options: ["按规程佩戴防护用品", "核对线路和杆塔编号", "跨越警戒区域", "跳过危险点记录"], answer: "AB" };
const wrongMulti = buildQuestionCopyText(multi, { displayOrder: [2, 0, 1, 3], wrongSelection: ["A", "C"] });
assert.match(wrongMulti, /我的选择：AB/, "我的选择应只输出映射后的显示字母");
assert.doesNotMatch(wrongMulti, /我的选择：[A-Z]\./, "我的选择不得附带选项文本");
assert.doesNotMatch(wrongMulti, /正确答案|答案内容/, "未要求 includeAnswer 时不得出现答案");

// 5) 「不会」：空选择 → 我的选择：不会。
const gaveUp = buildQuestionCopyText(single, { wrongSelection: [] });
assert.match(gaveUp, /我的选择：不会/, "空选择应输出不会");

// 6) 计算题：无「选项：」行；includeAnswer 为数值；我的选择为输入值。
const calculation = { type: "计算", stem: "允许 1% 误差时结果是多少？", options: [] as string[], answer: "10" };
const calcPlain = buildQuestionCopyText(calculation);
assert.doesNotMatch(calcPlain, /选项：/, "计算题应省略空选项段");
const calcFull = buildQuestionCopyText(calculation, { includeAnswer: true, wrongSelection: ["9.8"] });
assert.match(calcFull, /正确答案：10/, "计算题正确答案为数值");
assert.match(calcFull, /我的选择：9\.8/, "计算题我的选择为输入值");
assert.doesNotMatch(calcFull, /答案内容/, "计算题同样不输出答案内容行");
const multiBlankCalculation = { type: "计算", stem: "电流【空1】A，功率【空2】W", options: [] as string[], answer: "11\n968" };
const multiBlankCopy = buildQuestionCopyText(multiBlankCalculation, { includeAnswer: true, wrongSelection: ["10.8", "950"] });
assert.match(multiBlankCopy, /正确答案：第1空：11；第2空：968/, "多空计算题应按位置显示全部标准答案");
assert.match(multiBlankCopy, /我的选择：第1空：10\.8；第2空：950/, "多空计算题应按位置显示全部输入");

// 7) 判断题走选择题路径（两个选项）。
const judge = { type: "判断", stem: "巡视前应确认天气和现场风险。", options: ["正确", "错误"], answer: "A" };
assert.match(buildQuestionCopyText(judge), /^A\. 正确$/m, "判断题选项正常输出");

// 8) displayOrder 长度不符 → 回退原始顺序。
const fallback = buildQuestionCopyText(single, { displayOrder: [1, 0] });
assert.match(fallback, /^A\. 传输电能$/m, "displayOrder 长度不符应回退原始顺序");

// 9) includeAnswer:false 与 wrongSelection 共存：含我的选择、不含答案内容。
const mixed = buildQuestionCopyText(multi, { includeAnswer: false, wrongSelection: ["D"] });
assert.match(mixed, /我的选择：D/, "无 displayOrder 时按原始字母输出");
assert.doesNotMatch(mixed, /我的选择：D\./, "我的选择不得附带选项文本");
assert.doesNotMatch(mixed, /正确答案|答案内容/, "includeAnswer:false 不得输出答案");

// 10) 委托导出的字母映射函数与 lib 实现一致（防 helpers 双写回潮）。
assert.equal(displayedAnswer(single, [2, 0, 1]), "B", "displayedAnswer 应按显示字母映射");
assert.equal(answerText(single, [2, 0, 1]), "B. 传输电能", "answerText 应为显示字母+文本");

// ===== 静态断言：练习页双 icon 按钮 =====

const practiceView = await readFile("src/app/shell/views/practice.tsx", "utf8");
assert.match(practiceView, /aria-label=\{copyLabel\("question", copyStatusOf\("question"\)\)\}/, "练习页复制题目按钮 aria 应动态标注");
assert.match(practiceView, /copyLabel\("questionWithAnswer"/, "练习页应提供复制题目和答案按钮");
assert.match(practiceView, /target === "questionWithAnswer"/, "含答案版应由 target 区分 includeAnswer");
assert.match(practiceView, /submitted && !correct \? selected : undefined/, "做错时两个按钮都应附我的选择");
assert.doesNotMatch(practiceView, /复制题目、选项和答案|复制题目和选项/, "旧的单按钮文案应清除");
assert.match(practiceView, /question-meta-copy/, "双按钮应外包容器避免 margin-left:auto 分离");

// ===== 静态断言：题目详情页复制按钮 =====

const questionDetail = await readFile("src/app/bank/question-detail.tsx", "utf8");
assert.match(questionDetail, /aria-label="复制题目和答案"/, "详情页复制按钮应与练习页含答案版同名");
assert.match(questionDetail, /answer\?\.submitted && answer\.correct === false \? answer\.selected : undefined/, "详情页做错时应附我的选择");
assert.match(questionDetail, /buildQuestionCopyText\(question, \{ includeAnswer: true, wrongSelection \}\)/, "详情页复制必须带正确答案（与练习页作答后一致）");
assert.match(questionDetail, /answer\?\.submitted && answer\.correct === false && answer\.selected\.includes\(letter\) && !isAnswer/, "详情页做错时选项须标 wrong（与做题界面一致）");
assert.match(questionDetail, /\{isWrong && <X size=\{16\} \/>\}/, "做错选项须带 X 图标（与做题界面一致）");

// ===== 静态断言：最终 CSS 架构 / token 化 =====

const styleNames = (await readdir("src/app/styles")).filter((file) => file.endsWith(".css")).sort();
const styles = (await Promise.all(styleNames.map((file) => readFile(`src/app/styles/${file}`, "utf8")))).join("\n");
const mainSource = await readFile("src/main.tsx", "utf8");
assert.match(styles, /\.question-meta \.question-meta-copy\{margin-left:auto/, "复制按钮容器应持有 margin-left:auto");
assert.match(styles, /\.copy-question\.copied\s*\{[\s\S]*?color:\s*var\(--color-surface-raised\);[\s\S]*?background:\s*var\(--color-success\);/, "copied 态应走 success token");
assert.match(styles, /\.copy-question\.error\s*\{[\s\S]*?color:\s*var\(--color-danger\);[\s\S]*?background:\s*var\(--color-danger-soft\);/, "error 态应走 danger token");
assert.match(styles, /\.copy-question\s*\{[\s\S]*?width:\s*30px;[\s\S]*?height:\s*30px;/, "复制按钮视觉尺寸应紧凑为 30px");
assert.doesNotMatch(styles, /:global\(/, "CSS Module 全局逃逸必须保持为 0");
assert.doesNotMatch(mainSource, /copy-question-button\.module\.css|copyQuestionButtonStyles|document\.documentElement\.classList\.add/, "启动入口不得恢复 document 级 CSS Module scope 桥");
assert.doesNotMatch(styles, /html\[data-theme="dark"\][^\n]*copy-question/, "复制按钮不得依赖暗色前缀（token 自适应）");
assert.match(styles, /\.search-detail-body>ol>li\.wrong\{border-color:var\(--color-danger\);background:var\(--color-danger-soft\)\}/, "详情页做错选项标记应全 token 化");
assert.doesNotMatch(styles, /search-detail-body>ol>li\.answer\s*\{[^}]*[^-]color:/, "正确选项文字不得染绿（做题界面文字为墨色）");
assert.doesNotMatch(styles, /search-detail-body>ol>li\.wrong\s*\{[^}]*[^-]color:/, "做错选项文字不得染红（做题界面文字为墨色）");
assert.match(styles, /li\.answer>svg\{color:var\(--color-success\)\}/, "正确选项状态图标保持成功色");
assert.match(styles, /li\.wrong>svg\{color:var\(--color-danger\)\}/, "做错选项状态图标保持危险色");

console.log("question copy tests passed: 文本构造、练习页双按钮、详情页复制、最终 token 化 CSS 架构");
