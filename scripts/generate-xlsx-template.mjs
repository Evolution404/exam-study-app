import * as XLSX from "xlsx";
import { fileURLToPath } from "node:url";

const workbook = XLSX.utils.book_new();
const questionRows = [
  ["题干", "题型", "答案", "图片地址", "标签", "A", "B", "C", "D", "E", "F", "G", "H"],
  ["示例·单选（填好后删）导线的主要作用是什么？", "单选", "A", "", "基础，示例", "传输电能", "装饰线路", "储存电能", "测量温度"],
  ["示例·多选（填好后删）安全巡视应做到哪些？", "多选", "AB", "", "安全，示例", "佩戴防护用品", "核对线路编号", "跨越警戒区域", "跳过危险点记录"],
  ["示例·判断（填好后删）巡视前应确认天气和现场风险。", "判断", "A", "", "安全，示例", "正确", "错误"],
  ["示例·计算（填好后删）某量计算结果是多少？", "计算", "12.5", "https://example.com/question.png", "计算，示例"],
];
const questions = XLSX.utils.aoa_to_sheet(questionRows);
questions["!cols"] = [
  { wch: 46 }, { wch: 10 }, { wch: 12 }, { wch: 42 }, { wch: 22 },
  ...Array.from({ length: 8 }, () => ({ wch: 22 })),
];
questions["!freeze"] = { xSplit: 0, ySplit: 1 };
XLSX.utils.book_append_sheet(workbook, questions, "题库");

const instructions = XLSX.utils.aoa_to_sheet([
  ["拾卷 · 题库 Excel 模板使用说明"],
  ["适用项目", "拾卷（exam-study-app）本地优先刷题 PWA"],
  ["导入步骤", "1. 复制本模板；2. 删除题库页全部示例行；3. 按列填写；4. 将文件命名为送电线路工-初级工/中级工/高级工/技师.xlsx；5. 在题库页点击导入 Excel。"],
  ["题干", "必填。支持普通文字，以及 $...$ 行内公式和 $$...$$ 独立公式。"],
  ["题型", "必填，只能填写：单选、多选、判断、计算。"],
  ["答案", "单选填一个字母；多选填多个字母（如 AC）；判断填 A/正确 或 B/错误；计算题填标准数值（如 12.5、-3、1e6）。"],
  ["图片地址", "可选。填写完整的 http/https 图片 URL；导入后显示在题干下方。请确保各设备都能访问该地址。"],
  ["标签", "可选。多个标签使用中文逗号、英文逗号或顿号分隔。"],
  ["选项", "单选、多选、判断题从 A 列开始连续填写，不得断列；判断题必须依次为“正确、错误”。计算题不要填写选项。"],
  ["计算题误差", "计算题按配置页中的“计算题允许误差”判定，使用相对误差百分比；标准答案为 0 时按同一百分比折算为绝对误差。"],
  ["图片与离线", "图片 URL 由浏览器加载；题目文字和学习记录仍保存在本机并通过 Sync v5 同步。"],
  ["限制", "单次最多导入 20,000 题；每题最多 24 个选项；Excel 文件最大 12 MB。"],
  ["安全提醒", "不要在工作簿中填写 GitHub 令牌或其他账号凭据。"],
]);
instructions["!cols"] = [{ wch: 18 }, { wch: 110 }];
XLSX.utils.book_append_sheet(workbook, instructions, "使用说明");

XLSX.writeFile(workbook, fileURLToPath(new URL("../public/题库模板.xlsx", import.meta.url)), { compression: true });
