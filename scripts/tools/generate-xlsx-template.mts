import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildXlsx, type XlsxEmbeddedImage, type XlsxSheet } from "../../src/lib/io/xlsx-export";

const templateImageId = "ID_TEMPLATE_SHIJUAN_APP_ICON";
const appIcon = new Uint8Array(await readFile(fileURLToPath(new URL("../../public/icons/app-icon-192.png", import.meta.url))));

const questionRows = [
  ["题干", "题型", "答案", "标签", "解析", "A", "B", "C", "D", "E", "F", "G", "H", "图片1"],
  ["示例·单选（填好后删）导线的主要作用是什么？", "单选", "A", "基础，示例", "示例解析：导线的作用是传输电能，其余选项为干扰项。", "传输电能", "装饰线路", "储存电能", "测量温度"],
  ["示例·多选（填好后删）安全巡视应做到哪些？", "多选", "AB", "安全，示例", "示例解析：安全巡视应核对线路编号并佩戴防护用品。", "佩戴防护用品", "核对线路编号", "跨越警戒区域", "跳过危险点记录"],
  ["示例·判断（填好后删）巡视前应确认天气和现场风险。", "判断", "A", "安全，示例", "示例解析：巡视前应确认天气与现场风险，确保安全。", "正确", "错误"],
  ["示例·计算（填好后删）某量计算结果是多少？", "计算", "12.5", "计算，示例", "示例解析：计算题按标准数值判定，误差见配置页。"],
  ["示例·图片单选（填好后删）图中图标对应哪个应用？【图1】", "单选", "A", "图片，示例", "示例解析：图片1 嵌入在本行最后一列，题干中的【图1】决定图片显示位置。", "拾卷", "浏览器", "相册", "日历", "", "", "", "", `=DISPIMG("${templateImageId}",1)`],
];

const instructionRows = [
  ["拾卷 · 题库 Excel 模板使用说明"],
  ["适用项目", "拾卷（exam-study-app）本地优先刷题 PWA"],
  ["导入步骤", "1. 复制本模板；2. 删除题库页全部示例行；3. 按列填写；4. 将文件命名为送电线路工-初级工/中级工/高级工/技师.xlsx；5. 在题库页点击导入 Excel。"],
  ["题干", "必填。支持普通文字、$...$ 行内公式、$$...$$ 独立公式，以及【图1】【图2】等图片占位符。"],
  ["题型", "必填，只能填写：单选、多选、判断、计算。"],
  ["答案", "单选填一个字母；多选填多个字母（如 AC）；判断填 A/正确 或 B/错误；计算题填标准数值（如 12.5、-3、1e6）。"],
  ["标签", "可选。多个标签使用中文逗号、英文逗号或顿号分隔。"],
  ["解析", "可选。该题的个人解析，导入时会写回为本机笔记（不会覆盖已有解析）。"],
  ["选项", "单选、多选、判断题的选项从「解析」右侧的 A 列开始连续填写，不得断列；判断题必须依次为“正确、错误”。计算题不要填写选项。"],
  ["计算题误差", "计算题按配置页中的“计算题允许误差”判定，使用相对误差百分比；标准答案为 0 时按同一百分比折算为绝对误差。"],
  ["图片题", "支持题干图片和选项图片。先在题干或选项文字中写【图1】【图2】等占位符，再把对应图片按编号放入本行末尾的“图片1”“图片2”列。每一题都从图1重新编号。"],
  ["插入图片", "推荐使用 WPS 的“插入图片→嵌入单元格”，并保持图片列位于全部选项列之后且从“图片1”连续编号。不要填写本机路径或网络图片地址。"],
  ["兼容提示", "模板图片采用 WPS DISPIMG 单元格图片格式；WPS 可正常查看和编辑。部分 Microsoft Excel 版本可能显示 #NAME?，但请勿删除图片列或公式，以免导入时丢图。"],
  ["限制", "单次最多导入 20,000 题；每题最多 24 个选项、12 张图片；Excel 文件最大 12 MB。"],
  ["安全提醒", "图片会作为本地私有资产导入并随私有仓库同步；不要在工作簿中填写 GitHub 令牌或其他账号凭据。"],
];

const sheets: XlsxSheet[] = [
  {
    name: "题库",
    rows: questionRows,
    rowHeights: [0, 0, 0, 0, 0, 152],
    columnWidths: [46, 10, 12, 22, 28, ...Array.from({ length: 8 }, () => 22), 28],
  },
  {
    name: "使用说明",
    rows: instructionRows,
    columnWidths: [18, 110],
  },
];

const images: XlsxEmbeddedImage[] = [{
  id: templateImageId,
  bytes: appIcon,
  extension: "png",
  width: 192,
  height: 192,
}];

const outputPath = fileURLToPath(new URL("../../public/题库模板.xlsx", import.meta.url));
await writeFile(outputPath, buildXlsx(sheets, images));
console.log(`题库模板已生成：${outputPath}（含 1 道图片题示例）`);
