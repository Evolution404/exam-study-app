import * as XLSX from "xlsx";

const fixture = [
  { q: "导线的主要作用是什么？", a: ["传输电能", "装饰线路", "储存电能", "测量温度"], ans: "A" },
  { q: "哪些做法有助于安全巡视？", a: ["按规程佩戴防护用品", "核对线路和杆塔编号", "跨越警戒区域", "跳过危险点记录"], ans: ["A", "B"] },
  { q: "巡视前应确认天气和现场风险。", a: ["正确", "错误"], ans: "A" },
  { q: "发现异常后，最合适的第一步是什么？", a: ["立即离开并隐瞒", "按流程记录并报告", "自行拆除设备", "等待下次巡视"], ans: "B" },
  { q: "图片所示数值允许 1% 误差时，计算结果是【空1】，其两倍是【空2】。", type: "计算", a: [], ans: ["10", "20"] },
];
export const fixtureFile = {
  name: "送电线路工-初级工.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(fixture), "utf8"),
};
// 吸附几何断言专用：默认 fixture 只有 5 题，桌面视口下滚动量不足以让搜索框
// 真正吸顶（最大滚动 187px < 自然位置 265px）。这批题目让条件搜索结果足够长。
export const bigFixtureFile = {
  name: "吸附测试加长题库.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(
    Array.from({ length: 30 }, (_, index) => ({ q: `加长题库第 ${index + 1} 题：设备巡检记录的归档要求是？`, a: ["按月装订成册", "随意存放", "口头交接", "无需归档"], ans: "A" })),
  ), "utf8"),
};
export const excelFixtureFile = {
  name: "送电线路工-中级工.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  buffer: XLSX.write((() => {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([
      ["题干", "题型", "标签", "解析", "答案1", "答案2", "A", "B", "C"],
      ["Excel 导入后的第一道题是什么？", "单选", "Excel", "", "A", "", "通过校验", "跳过校验", "无法判断"],
      ["Excel 导入支持多选吗？", "多选", "Excel", "", "AB", "", "支持", "可以", "不支持"],
      ["Excel 计算题的标准答案是【空1】，其两倍是【空2】。", "计算", "Excel，计算", "", "10", "20"],
    ]);
    XLSX.utils.book_append_sheet(workbook, worksheet, "题库");
    return workbook;
  })(), { type: "buffer", bookType: "xlsx" }),
};
