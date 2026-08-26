import * as XLSX from "xlsx";

const choice = (stem, options, correctOptionIds, type = "单选") => ({
  stem,
  type,
  options,
  optionIds: options.map((_, index) => `option-${index + 1}`),
  solution: { kind: "choice", correctOptionIds },
});

const fixture = [
  choice("导线的主要作用是什么？", ["传输电能", "装饰线路", "储存电能", "测量温度"], ["option-1"]),
  choice("哪些做法有助于安全巡视？", ["按规程佩戴防护用品", "核对线路和杆塔编号", "跨越警戒区域", "跳过危险点记录"], ["option-1", "option-2"], "多选"),
  choice("巡视前应确认天气和现场风险。", ["正确", "错误"], ["option-1"], "判断"),
  choice("发现异常后，最合适的第一步是什么？", ["立即离开并隐瞒", "按流程记录并报告", "自行拆除设备", "等待下次巡视"], ["option-2"]),
  {
    stem: "图片所示数值允许 1% 误差时，计算结果是【空1】，其两倍是【空2】。",
    type: "计算",
    options: [],
    solution: { kind: "calculation", blanks: [{ id: "blank-1", expected: 10 }, { id: "blank-2", expected: 20 }] },
  },
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
    Array.from({ length: 30 }, (_, index) => choice(
      `加长题库第 ${index + 1} 题：设备巡检记录的归档要求是？`,
      ["按月装订成册", "随意存放", "口头交接", "无需归档"],
      ["option-1"],
    )),
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
