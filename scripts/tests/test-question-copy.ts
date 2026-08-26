import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { answerText, buildQuestionCopyText, displayedAnswer } from "../../src/lib/question/question-copy";

// ===== 纯函数：buildQuestionCopyText =====

const single = {
  type: "单选" as const,
  stem: "导线的主要作用是什么？",
  options: ["传输电能", "装饰线路", "储存电能"],
  optionIds: ["single-0", "single-1", "single-2"],
  solution: { kind: "choice" as const, correctOptionIds: ["single-0"] },
};

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
const multi = {
  type: "多选" as const,
  stem: "哪些做法有助于安全巡视？",
  options: ["按规程佩戴防护用品", "核对线路和杆塔编号", "跨越警戒区域", "跳过危险点记录"],
  optionIds: ["multi-0", "multi-1", "multi-2", "multi-3"],
  solution: { kind: "choice" as const, correctOptionIds: ["multi-0", "multi-1"] },
};
const wrongMulti = buildQuestionCopyText(multi, { displayOrder: [2, 0, 1, 3], wrongSelection: ["A", "C"] });
assert.match(wrongMulti, /我的选择：AB/, "我的选择应只输出映射后的显示字母");
assert.doesNotMatch(wrongMulti, /我的选择：[A-Z]\./, "我的选择不得附带选项文本");
assert.doesNotMatch(wrongMulti, /正确答案|答案内容/, "未要求 includeAnswer 时不得出现答案");

// 5) 「不会」：空选择 → 我的选择：不会。
const gaveUp = buildQuestionCopyText(single, { wrongSelection: [] });
assert.match(gaveUp, /我的选择：不会/, "空选择应输出不会");

// 6) 计算题：无「选项：」行；includeAnswer 为数值；我的选择为输入值。
const calculation = {
  type: "计算" as const,
  stem: "允许 1% 误差时结果是多少？",
  options: [] as string[],
  solution: { kind: "calculation" as const, blanks: [{ id: "blank-1", expected: 10 }] },
};
const calcPlain = buildQuestionCopyText(calculation);
assert.doesNotMatch(calcPlain, /选项：/, "计算题应省略空选项段");
const calcFull = buildQuestionCopyText(calculation, { includeAnswer: true, wrongSelection: ["9.8"] });
assert.match(calcFull, /正确答案：10/, "计算题正确答案为数值");
assert.match(calcFull, /我的选择：9\.8/, "计算题我的选择为输入值");
assert.doesNotMatch(calcFull, /答案内容/, "计算题同样不输出答案内容行");
const multiBlankCalculation = {
  type: "计算" as const,
  stem: "电流【空1】A，功率【空2】W",
  options: [] as string[],
  solution: { kind: "calculation" as const, blanks: [{ id: "blank-1", expected: 11 }, { id: "blank-2", expected: 968 }] },
};
const multiBlankCopy = buildQuestionCopyText(multiBlankCalculation, { includeAnswer: true, wrongSelection: ["10.8", "950"] });
assert.match(multiBlankCopy, /正确答案：第1空：11；第2空：968/, "多空计算题应按位置显示全部标准答案");
assert.match(multiBlankCopy, /我的选择：第1空：10\.8；第2空：950/, "多空计算题应按位置显示全部输入");

// 7) 判断题走选择题路径（两个选项）。
const judge = {
  type: "判断" as const,
  stem: "巡视前应确认天气和现场风险。",
  options: ["正确", "错误"],
  optionIds: ["judge-0", "judge-1"],
  solution: { kind: "choice" as const, correctOptionIds: ["judge-0"] },
};
assert.match(buildQuestionCopyText(judge), /^A\. 正确$/m, "判断题选项正常输出");

// 8) displayOrder 长度不符 → 使用原始顺序。
const invalidOrder = buildQuestionCopyText(single, { displayOrder: [1, 0] });
assert.match(invalidOrder, /^A\. 传输电能$/m, "displayOrder 长度不符应使用原始顺序");

// 9) includeAnswer:false 与 wrongSelection 共存：含我的选择、不含答案内容。
const mixed = buildQuestionCopyText(multi, { includeAnswer: false, wrongSelection: ["D"] });
assert.match(mixed, /我的选择：D/, "无 displayOrder 时按原始字母输出");
assert.doesNotMatch(mixed, /我的选择：D\./, "我的选择不得附带选项文本");
assert.doesNotMatch(mixed, /正确答案|答案内容/, "includeAnswer:false 不得输出答案");

// 10) 委托导出的字母映射函数与 lib 实现一致（防 helpers 双写回潮）。
assert.equal(displayedAnswer(single, [2, 0, 1]), "B", "displayedAnswer 应按显示字母映射");
assert.equal(answerText(single, [2, 0, 1]), "B. 传输电能", "answerText 应为显示字母+文本");

// ===== 静态断言：共享复制动作 + 练习页双按钮 =====

const copyAction = await readFile("src/app/ui/question-copy-action.tsx", "utf8");
assert.match(copyAction, /includeAnswer \? "复制含答案" : "复制题目"/, "共享动作应区分复制题目与复制含答案的提示文案");
assert.match(copyAction, /includeAnswer \? "复制题目和答案" : "复制题目"/, "共享动作 aria 应明确含答案语义");
assert.match(copyAction, /status === "copied" \? "已复制"/, "复制成功应有明确提示反馈");
assert.match(copyAction, /status === "error" \? "复制失败"/, "复制失败应有明确提示反馈");
assert.match(copyAction, /aria-label=\{ariaLabel\}/, "共享按钮必须保留无障碍名称");

const practiceView = await readFile("src/app/shell/views/practice.tsx", "utf8");
const practicePresentation = await readFile("src/app/shell/views/practice-presentation.tsx", "utf8");
const practiceSurface = `${practiceView}\n${practicePresentation}`;
assert.match(practicePresentation, /<QuestionCopyAction status=\{copyQuestionStatus\}/, "练习页应始终通过 presentation 提供复制题目动作");
assert.match(practicePresentation, /\{submitted && <QuestionCopyAction includeAnswer status=\{copyAnswerStatus\}/, "作答后应同时通过 presentation 出现第二个复制含答案动作");
assert.match(practiceView, /target === "questionWithAnswer"/, "含答案版应由 target 区分 includeAnswer");
assert.match(practiceView, /submitted && !correct \? selected : undefined/, "做错时两个按钮都应附我的选择");
assert.match(practicePresentation, /className="question-tools"/, "复制、收藏、编辑应进入独立操作区而非混入标签行");
assert.match(practicePresentation, /className=\{`question-tool favorite/, "收藏应使用统一轻量工具动作");
assert.match(practicePresentation, /className="question-tool edit"/, "编辑应使用统一轻量工具动作");
assert.match(practicePresentation, /\{question\.tags\.map\(\(tag\) => <em key=\{tag\}>\{tag\}<\/em>\)\}/, "所有用户标签都应按同一标签样式渲染");
assert.doesNotMatch(practiceSurface, /contextTags|categoryTags|question-contexts|tag\.replace/, "考点/公式等用户标签不得被特殊拆分或改写");
assert.doesNotMatch(practiceSurface, /question-meta-copy/, "旧复制图标容器应清除");
assert.doesNotMatch(practiceSurface, /className=\{`icon-button copy-question/, "练习页不应恢复孤立方形复制图标");
assert.doesNotMatch(practiceSurface, /复制题目、选项和答案|复制题目和选项/, "旧的单按钮文案应清除");

// ===== 静态断言：所有复用 QuestionDetail 的查看界面 =====

const questionDetail = await readFile("src/app/bank/question-detail.tsx", "utf8");
assert.match(questionDetail, /className="question-detail-toolbar" aria-label="题目操作"/, "共享详情应提供统一的顶部题目操作层");
assert.match(questionDetail, /<QuestionCopyAction status=\{copyStatusOf\("question"\)\}/, "共享详情应提供复制题目动作");
assert.match(questionDetail, /<QuestionCopyAction includeAnswer status=\{copyStatusOf\("questionWithAnswer"\)\}/, "共享详情应同时提供复制含答案动作");
assert.match(questionDetail, /includeAnswer: target === "questionWithAnswer"/, "详情页两种复制应复用答题页的 includeAnswer 语义");
assert.match(questionDetail, /answer\?\.submitted && answer\.correct === false \? answer\.selected : undefined/, "详情页做错时两个复制动作都应附我的选择");
assert.match(questionDetail, /\{footer && <div className="question-detail-actions">\{footer\}<\/div>\}/, "调用方题目操作应统一上移到复制按钮后的顶部工具栏");
assert.match(questionDetail, /\{nav && <footer className="question-detail-pager">/, "详情底部只在存在翻题导航时显示");
assert.match(questionDetail, /nav\.center \?\? <span className="search-detail-count">\{nav\.index \+ 1\} \/ \{nav\.total\}<\/span>/, "详情翻题区应始终在中间显示当前位置");
assert.doesNotMatch(questionDetail, /className="search-detail-actions"/, "详情底部不得再保留编辑、删除、收藏等题目操作层");
assert.match(questionDetail, /answer\?\.submitted && answer\.correct === false && answer\.selected\.includes\(letter\) && !isAnswer/, "详情页做错时选项须标 wrong（与做题界面一致）");
assert.match(questionDetail, /\{isWrong && <X size=\{16\} \/>\}/, "做错选项须带 X 图标（与做题界面一致）");

// ===== 静态断言：最终 CSS 架构 / token 化 =====

const appStylesRoot = new URL("../../src/app/", import.meta.url);
const styleNames = (await readdir(appStylesRoot, { recursive: true })).filter((file) => file.endsWith(".css")).sort();
const styles = (await Promise.all(styleNames.map((file) => readFile(new URL(file, appStylesRoot), "utf8")))).join("\n");
const mainSource = await readFile("src/main.tsx", "utf8");
assert.match(styles, /\.question-tools\{display:flex;flex-wrap:wrap/, "题目操作区应自然换行，避免窄屏右漂");
assert.match(styles, /\.question-copy-action,\.question-tool\{[^}]*border:0[^}]*background:transparent[^}]*font-size:0/, "答题页题目操作应为无文字、无边框、无底色的扁平图标");
assert.match(styles, /\.question-copy-action\.copied\{[^}]*var\(--color-success\)/, "copied 态应走 success token");
assert.match(styles, /\.question-copy-action\.error\{[^}]*var\(--color-danger\)/, "error 态应走 danger token");
assert.match(styles, /\.question-detail-actions>button\{[^}]*border:0[^}]*background:transparent[^}]*font-size:0/, "详情页收藏、编辑、删除等题目操作应与复制按钮统一为扁平纯图标");
assert.match(styles, /\.question-detail-pager \.search-detail-nav\{display:grid;grid-template-columns:minmax\(0,1fr\) auto minmax\(0,1fr\)/, "详情翻题区应为上一题 / 位置 / 下一题的单行布局");
assert.match(styles, /\.question-detail-next\{[^}]*var\(--color-primary\)[^}]*var\(--color-primary-soft\)/, "详情下一题按钮应沿用答题页轻主色动作");
assert.match(styles, /@media\(max-width:760px\)[\s\S]*?\.question-copy-action,\.question-tool\{min-height:38px/, "手机端题目工具应保留 38px 透明触控高度");
assert.match(styles, /@media\(max-width:760px\)[\s\S]*?\.question-detail-actions>button\{width:38px;min-width:38px;min-height:38px/, "手机端详情操作应保留 38px 透明触控区");
assert.doesNotMatch(styles, /:global\(/, "CSS Module 全局逃逸必须保持为 0");
assert.doesNotMatch(mainSource, /copy-question-button\.module\.css|copyQuestionButtonStyles|document\.documentElement\.classList\.add/, "启动入口不得恢复 document 级 CSS Module scope 桥");
assert.doesNotMatch(styles, /html\[data-theme="dark"\][^\n]*question-copy-action/, "复制动作不得依赖暗色前缀（token 自适应）");
assert.match(styles, /\.search-detail-body>ol>li\.wrong\{border-color:var\(--color-danger\);background:var\(--color-danger-soft\)\}/, "详情页做错选项标记应全 token 化");
assert.doesNotMatch(styles, /search-detail-body>ol>li\.answer\s*\{[^}]*[^-]color:/, "正确选项文字不得染绿（做题界面文字为墨色）");
assert.doesNotMatch(styles, /search-detail-body>ol>li\.wrong\s*\{[^}]*[^-]color:/, "做错选项文字不得染红（做题界面文字为墨色）");
assert.match(styles, /li\.answer>svg\{color:var\(--color-success\)\}/, "正确选项状态图标保持成功色");
assert.match(styles, /li\.wrong>svg\{color:var\(--color-danger\)\}/, "做错选项状态图标保持危险色");

console.log("question copy tests passed: 双复制、统一顶部题目操作、底部翻题、用户标签与 token 化样式");