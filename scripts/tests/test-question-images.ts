import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import "fake-indexeddb/auto";
import {
  buildQuestionBankXlsx,
  buildQuestionBankZip,
  collectExportImages,
  questionPortableExportFormat,
  questionExportSheetPlan,
  type ExportImageData,
  type ExportQuestionInput,
} from "../../src/lib/question/question-bank-export";
import { buildStoredZip, buildXlsx } from "../../src/lib/io/xlsx-export";
import { parseQuestionBankTable } from "../../src/lib/io/xlsx-import";
import { parseQuestionBankZip, QuestionBundleError } from "../../src/lib/question/question-bank-bundle";
import { importQuestionBankFile } from "../../src/lib/question/question-bank-file-import";
import { sniffImageDimensions } from "../../src/lib/io/image-dimensions";
import { sha256Bytes } from "../../src/lib/io/image-assets";
import { IMPORT_LIMITS } from "../../src/lib/io/import-limits";
import { dbV7, importQuestionBankV7, resetV7Database } from "../../src/lib/db/db-v7";
import type { ContentBlock, QuestionV7 } from "../../src/lib/db/v7-types";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(12 + data.length);
  const view = new DataView(body.buffer);
  view.setUint32(0, data.length);
  body.set(new TextEncoder().encode(type), 4);
  body.set(data, 8);
  view.setUint32(8 + data.length, crc32(body.subarray(4, 8 + data.length)));
  return body;
}

/** Build a real (valid) truecolour PNG so dimension sniffing is exercised. */
function makePng(width: number, height: number, red: number): Uint8Array {
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour
  const scanlines = new Uint8Array(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    const offset = row * (1 + width * 3);
    scanlines[offset] = 0; // no filter
    for (let column = 0; column < width; column += 1) {
      scanlines[offset + 1 + column * 3] = red;
      scanlines[offset + 2 + column * 3] = 0x80;
      scanlines[offset + 3 + column * 3] = 0xff;
    }
  }
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [signature, pngChunk("IHDR", header), pngChunk("IDAT", new Uint8Array(deflateSync(scanlines))), pngChunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const pngA = makePng(640, 480, 0x10);
const pngB = makePng(320, 240, 0x20);
const pngC = makePng(100, 100, 0x30);
const pngD = makePng(80, 80, 0x40);

function exportImage(bytes: Uint8Array, mimeType: "image/png" | "image/jpeg" = "image/png"): ExportImageData {
  const dimensions = sniffImageDimensions(bytes)!;
  assert.ok(dimensions, "fixture image must be sniffable");
  return { bytes, mimeType, width: dimensions.width, height: dimensions.height };
}

const imageA = exportImage(pngA);
const imageB = exportImage(pngB);
const imageC = exportImage(pngC);
const images = new Map<string, ExportImageData>([
  [await sha256Bytes(pngA), imageA],
  [await sha256Bytes(pngB), imageB],
  [await sha256Bytes(pngC), imageC],
]);
const idA = await sha256Bytes(pngA);
const idB = await sha256Bytes(pngB);
const idC = await sha256Bytes(pngC);
const idD = await sha256Bytes(pngD);

const text = (value: string): ContentBlock => ({ id: `t-${value.length}-${value.charCodeAt(0) % 97}`, type: "text", text: value });
const image = (assetId: string): ContentBlock => ({ id: `i-${assetId.slice(0, 6)}`, type: "image", assetId });

const imageQuestions: ExportQuestionInput[] = [
  {
    id: "iq1", type: "单选", stem: "图中①处部件是", options: ["绝缘子", "横担", "避雷针", "拉线"], optionIds: ["iq1-a", "iq1-b", "iq1-c", "iq1-d"], solution: { kind: "choice", correctOptionIds: ["iq1-b"] }, tags: ["图片"],
    content: [text("图中①处部件是"), image(idA), text("？")],
    optionBlocks: ["绝缘子", "横担", "避雷针", "拉线"].map((value) => [text(value)]),
  },
  {
    id: "iq2", type: "判断", stem: "该杆塔安装正确", options: ["正确", "错误"], optionIds: ["iq2-a", "iq2-b"], solution: { kind: "choice", correctOptionIds: ["iq2-a"] }, tags: [],
    content: [image(idA), text(" 该杆塔安装正确")],
    optionBlocks: [[text("正确")], [text("错误")]],
  },
  {
    id: "iq3", type: "多选", stem: "结合下图回答", options: ["选项甲", "见图", "选项丙", "选项丁"], optionIds: ["iq3-a", "iq3-b", "iq3-c", "iq3-d"], solution: { kind: "choice", correctOptionIds: ["iq3-a", "iq3-b", "iq3-c"] }, tags: ["多图"],
    content: [text("结合下图回答")],
    optionBlocks: [[text("选项甲")], [text("见图"), image(idC)], [text("选项丙")], [text("选项丁")]],
  },
];
// q3 uses two images (stem B + option C) — extend its content with B.
imageQuestions[2].content = [text("结合下图回答"), image(idB)];

const notes = new Map<string, string>([["iq1", "看绝缘子串的位置"]]);

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function zipEntryNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = view.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  assert.ok(eocd >= 0, "zip must have EOCD");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const names: string[] = [];
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.getUint16(offset + 28, true);
    names.push(decoder.decode(new Uint8Array(bytes.buffer, bytes.byteOffset + offset + 46, nameLength)));
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return names;
}

async function bankQuestions(bankId: string): Promise<QuestionV7[]> {
  const memberships = await dbV7.bankQuestionMemberships.where("bankId").equals(bankId).toArray();
  const questions = await dbV7.questions.bulkGet(memberships.map((membership) => membership.questionId));
  return questions.filter((question): question is QuestionV7 => Boolean(question));
}

await resetV7Database();

// ---------------------------------------------------------------------------
// 1. Excel 导出：占位符、动态图片列、cellimages 部件
// ---------------------------------------------------------------------------
{
  const plan = questionExportSheetPlan(imageQuestions, notes, images);
  assert.equal(plan.imageColumnCount, 2, "单题最多图片数决定图片列数（q3 有 2 张）");
  assert.deepEqual(plan.rows[0], ["题干", "题型", "标签", "解析", "答案1", "A", "B", "C", "D", "图片1", "图片2"], "图片列追加在选项之后");
  assert.equal(plan.rows[1][0], "图中①处部件是【图1】？", "题干图片写为占位符");
  assert.equal(plan.rows[1][9], `=DISPIMG("ID_${idA}",1)`, "图片1 列写入 DISPIMG 公式");
  assert.equal(plan.rows[1][10], "", "第二张图列为空");
  assert.equal(plan.rows[3][0], "结合下图回答【图1】", "题干尾部的图也是占位符");
  assert.equal(plan.rows[3][6], "见图【图2】", "选项中的图片同样编号");
  assert.equal(plan.rows[3][9], `=DISPIMG("ID_${idB}",1)`, "q3 图片1 = 题干图");
  assert.equal(plan.rows[3][10], `=DISPIMG("ID_${idC}",1)`, "q3 图片2 = 选项图");
  assert.equal(plan.rowHeights[0], 0, "表头行不设置行高");
  assert.ok(plan.rowHeights[1] > 0, "含图行要加高行高");
  assert.ok(plan.rowHeights[2] > 0, "q2 含共享图 A，行高应大于 0");
  assert.equal(plan.usedAssetIds.length, 3, "三张不同图片");

  const bytes = buildQuestionBankXlsx(imageQuestions, notes, images);
  const names = zipEntryNames(bytes);
  assert.ok(names.includes("xl/cellimages.xml"), "应生成 WPS cellimages 部件");
  assert.ok(names.includes("xl/_rels/cellimages.xml.rels"), "cellimages 需要 rels");
  for (let index = 1; index <= 3; index += 1) assert.ok(names.includes(`xl/media/image${index}.png`), `第 ${index} 张图片应写入 media`);
  const contentTypes = names.includes("[Content_Types].xml");
  assert.ok(contentTypes, "zip 结构完整");

  // The bank UI passes QuestionViewModel objects whose rich blocks are nested
  // under `canonical`, not the flat export-fixture shape above.
  const viewModelQuestions = imageQuestions.map(({ content, optionBlocks, ...question }) => ({
    ...question,
    canonical: { content: content ?? [], options: optionBlocks ?? [] },
  }));
  const viewModelPlan = questionExportSheetPlan(viewModelQuestions, notes, images);
  assert.equal(viewModelPlan.usedAssetIds.length, 3, "UI 题目模型中的 canonical 图片必须被导出器识别");
  assert.equal(viewModelPlan.rows[1][9], `=DISPIMG("ID_${idA}",1)`, "UI 导出同样必须写入 DISPIMG 公式");
  const viewModelNames = zipEntryNames(buildQuestionBankXlsx(viewModelQuestions, notes, images));
  assert.ok(viewModelNames.includes("xl/cellimages.xml"), "UI 导出必须包含 WPS cellimages 部件");
  assert.ok(viewModelNames.includes("xl/_rels/cellimages.xml.rels"), "UI 导出必须包含 WPS 图片关系文件");
  assert.equal(viewModelNames.filter((name) => name.startsWith("xl/media/")).length, 3, "UI 导出必须写入所有引用媒体");

  // 无图题库回归：不生成 cellimages 部件。
  const plainBytes = buildQuestionBankXlsx([{ id: "p1", type: "单选", stem: "纯文字", options: ["甲", "乙"], optionIds: ["p1-a", "p1-b"], solution: { kind: "choice", correctOptionIds: ["p1-a"] }, tags: [] }], new Map());
  const plainNames = zipEntryNames(plainBytes);
  assert.ok(!plainNames.includes("xl/cellimages.xml"), "无图题库不生成 cellimages");
  assert.ok(!plainNames.some((name) => name.startsWith("xl/media/")), "无图题库不携带 media");
  console.log("1. Excel 导出结构（占位符 / 动态图片列 / cellimages）通过");
}

// ---------------------------------------------------------------------------
// 2. Excel 导入闭环：DISPIMG → 资产 → 内容块
// ---------------------------------------------------------------------------
{
  const bytes = buildQuestionBankXlsx(imageQuestions, notes, images);
  const file = new File([toArrayBuffer(bytes)], "图片题库.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const { bank, type } = await importQuestionBankFile(file);
  assert.equal(type, "xlsx");
  assert.equal(bank.questionCount, 3, "三道题全部导入");

  const questions = await bankQuestions(bank.id);
  const byOrder = (await dbV7.bankQuestionMemberships.where("bankId").equals(bank.id).toArray()).sort((a, b) => a.sortOrder - b.sortOrder);
  const ordered = await dbV7.questions.bulkGet(byOrder.map((membership) => membership.questionId));

  const q1 = ordered[0]!;
  assert.deepEqual(
    q1.content.map((block) => block.type === "text" ? `text:${block.text}` : `image:${block.assetId.slice(0, 8)}`),
    ["text:图中①处部件是", `image:${idA.slice(0, 8)}`, "text:？"],
    "题干占位符应还原为文字+图片+文字",
  );
  assert.deepEqual(q1.options.map((blocks) => blocks.map((block) => block.type === "text" ? block.text : `image:${block.assetId.slice(0, 8)}`)), [["绝缘子"], ["横担"], ["避雷针"], ["拉线"]], "纯文字选项保持文字");

  const q2 = ordered[1]!;
  assert.equal(q2.content[0]!.type, "image", "题干开头的图片还原为图片块");
  assert.equal((q2.content[0] as { assetId: string }).assetId, idA, "共享图片与 q1 是同一资产（内容寻址去重）");

  const q3 = ordered[2]!;
  assert.deepEqual(
    q3.options[1]!.map((block) => block.type === "text" ? `text:${block.text}` : `image:${block.assetId.slice(0, 8)}`),
    ["text:见图", `image:${idC.slice(0, 8)}`],
    "选项内的占位符还原为选项图片块",
  );

  const assets = await dbV7.imageAssets.toArray();
  assert.equal(assets.length, 3, "三张图片全部物化为资产");
  const assetA = assets.find((asset) => asset.id === idA)!;
  assert.equal(assetA.width, 640);
  assert.equal(assetA.height, 480);
  assert.equal(assetA.mimeType, "image/png");
  assert.equal(assetA.blob?.size, pngA.byteLength, "资产字节与源图片一致");
  const importRecord = (await dbV7.changeSets.toArray()).find((record) => record.mutations.some((mutation) => mutation.kind === "question.import" && mutation.bank.id === bank.id));
  assert.ok(importRecord, "Excel 导入应立即创建固定的导入事件");
  const importMutation = importRecord.mutations.find((mutation) => mutation.kind === "question.import");
  assert.equal(importMutation?.kind, "question.import");
  assert.equal(importMutation.images?.length, 3, "固定导入事件应在同步前就包含全部图片描述");
  assert.ok(importMutation.images?.every((asset) => !asset.blob && !asset.remote), "导入事件只保存无 blob 的本地图片描述");
  assert.ok(!importRecord.mutations.some((mutation) => mutation.kind === "image.asset.save"), "导入时不应按图片拆分同步事件");
  void questions;

  // 重复导入同一文件：内容寻址去重，题数不变、资产不重复。
  const again = await importQuestionBankFile(new File([toArrayBuffer(bytes)], "图片题库.xlsx", { type: file.type }));
  assert.equal(again.bank.questionCount, 3, "重复导入不应增加题目");
  assert.equal((await dbV7.imageAssets.toArray()).length, 3, "重复导入不应重复物化资产");
  assert.equal(await dbV7.questions.count(), 3, "全局题目按指纹去重");

  // WPS 拆分工作簿常残留源文件的全部媒体；只物化题目实际引用的图片。
  const residueWorkbook = buildXlsx([{ name: "题库", rows: [
    ["题干", "题型", "标签", "解析", "答案1", "A", "B", "图片1"],
    ["图中①处部件是【图1】？", "单选", "图片", "", "B", "绝缘子", "横担", '=DISPIMG("ID_USED",1)'],
  ] }], [
    { id: "ID_USED", bytes: pngA, extension: "png", width: 640, height: 480 },
    { id: "ID_UNUSED", bytes: pngD, extension: "png", width: 80, height: 80 },
  ]);
  await importQuestionBankFile(new File([toArrayBuffer(residueWorkbook)], "含残留媒体.xlsx", { type: file.type }));
  assert.equal(await dbV7.imageAssets.get(idD), undefined, "未被题目引用的 Excel 残留媒体不应物化或上传");
  console.log("2. Excel 导入闭环（DISPIMG 读回 / 资产物化 / 选项图片 / 去重）通过");
}

// ---------------------------------------------------------------------------
// 3. zip 压缩包导出 + 导入闭环
// ---------------------------------------------------------------------------
{
  const plainQuestion: ExportQuestionInput = { id: "plain", type: "单选", stem: "纯文字", options: ["甲", "乙"], optionIds: ["plain-a", "plain-b"], solution: { kind: "choice", correctOptionIds: ["plain-a"] }, tags: [] };
  assert.equal(questionPortableExportFormat([plainQuestion]), "json", "无图片题库必须选择 JSON");
  assert.equal(questionPortableExportFormat(imageQuestions), "zip", "含图片题库必须选择 ZIP");

  const bytes = buildQuestionBankZip("压缩包题库", imageQuestions, notes, images);
  assert.deepEqual(zipEntryNames(bytes).slice().sort(), ["bank.json", `images/${idA}.png`, `images/${idB}.png`, `images/${idC}.png`].sort(), "zip 内含 bank.json 与内容寻址图片");

  const parsed = await parseQuestionBankZip(toArrayBuffer(bytes));
  assert.equal(parsed.name, "压缩包题库");
  assert.equal(parsed.images.length, 3, "三张图片解包");
  assert.equal(parsed.images.find((image) => image.assetId === idA)!.width, 640, "尺寸从字节嗅探");

  const file = new File([toArrayBuffer(bytes)], "压缩包题库.zip", { type: "application/zip" });
  const { bank, type } = await importQuestionBankFile(file);
  assert.equal(type, "zip");
  assert.equal(bank.name, "压缩包题库", "题库名取自 bank.json 而非文件名");
  assert.equal(bank.questionCount, 3);
  const memberships = (await dbV7.bankQuestionMemberships.where("bankId").equals(bank.id).toArray()).sort((a, b) => a.sortOrder - b.sortOrder);
  const ordered = await dbV7.questions.bulkGet(memberships.map((membership) => membership.questionId));
  assert.deepEqual(
    ordered[0]!.content.map((block) => block.type === "text" ? `text:${block.text}` : `image:${block.assetId.slice(0, 8)}`),
    ["text:图中①处部件是", `image:${idA.slice(0, 8)}`, "text:？"],
    "zip 内容块结构精确还原",
  );
  const note = await dbV7.notes.get(ordered[0]!.id);
  assert.equal(note?.content, "看绝缘子串的位置", "解析随压缩包往返");

  const viewModelQuestions = imageQuestions.map(({ content, optionBlocks, ...question }) => ({
    ...question,
    canonical: { content: content ?? [], options: optionBlocks ?? [] },
  }));
  assert.equal(questionPortableExportFormat(viewModelQuestions), "zip", "UI canonical 图片必须触发 ZIP 导出");
  const viewModelZip = buildQuestionBankZip("UI 压缩包题库", viewModelQuestions, notes, images);
  assert.equal(zipEntryNames(viewModelZip).filter((name) => name.startsWith("images/")).length, 3, "UI ZIP 必须包含全部去重原图");
  const viewModelParsed = await parseQuestionBankZip(toArrayBuffer(viewModelZip));
  assert.equal(viewModelParsed.images.length, 3, "UI ZIP 的全部原图必须可校验回导");
  assert.equal(viewModelParsed.questions[2]?.options[1]?.[1]?.type, "image", "UI ZIP 必须保留选项内图片位置");
  console.log("3. zip 导出与导入闭环（内容块 / 资产 / 解析）通过");
}

// ---------------------------------------------------------------------------
// 4. zip 完整性：篡改与缺失引用必须报错
// ---------------------------------------------------------------------------
{
  const json = JSON.stringify({
    name: "坏包",
    images: { [`images/${idA}.png`]: { mimeType: "image/png" } },
    questions: [{ type: "单选", content: [{ type: "text", text: "题" }, { type: "image", src: `images/${idA}.png` }], options: [[{ type: "text", text: "甲" }], [{ type: "text", text: "乙" }]], optionIds: ["a", "b"], solution: { kind: "choice", correctOptionIds: ["a"] } }],
  });
  // 文件名与内容不匹配（sha 不符）：清单与引用都指向伪 id，但字节是 pngA。
  const forgedId = "0".repeat(64);
  const forged = JSON.stringify({
    name: "坏包",
    images: { [`images/${forgedId}.png`]: { mimeType: "image/png" } },
    questions: [{ type: "单选", content: [{ type: "text", text: "题" }, { type: "image", src: `images/${forgedId}.png` }], options: [[{ type: "text", text: "甲" }], [{ type: "text", text: "乙" }]], optionIds: ["a", "b"], solution: { kind: "choice", correctOptionIds: ["a"] } }],
  });
  await assert.rejects(
    () => parseQuestionBankZip(toArrayBuffer(buildStoredZip([{ name: "bank.json", data: new TextEncoder().encode(forged) }, { name: `images/${forgedId}.png`, data: pngA }]))),
    (error: unknown) => error instanceof QuestionBundleError && /不一致/.test(error.message),
    "文件名与 sha256 不符应报损坏",
  );
  // bank.json 引用了不存在的图片。
  const missingSrc = json.replaceAll(idA, "f".repeat(64));
  await assert.rejects(
    () => parseQuestionBankZip(toArrayBuffer(buildStoredZip([{ name: "bank.json", data: new TextEncoder().encode(missingSrc) }, { name: `images/${idA}.png`, data: pngA }]))),
    (error: unknown) => error instanceof QuestionBundleError,
    "缺失的图片引用应报错",
  );
  assert.throws(
    () => buildQuestionBankZip("导出缺图", imageQuestions, notes, new Map([[idA, imageA]])),
    /缺少 2 张原图/,
    "导出器本身也必须拒绝生成缺图压缩包",
  );
  assert.equal(IMPORT_LIMITS.zip.maxBytes, 256 * 1024 * 1024);
  assert.equal(IMPORT_LIMITS.zip.maxArchiveEntries, 16_384);
  assert.equal(IMPORT_LIMITS.zip.maxEntryBytes, 32 * 1024 * 1024);
  assert.equal(IMPORT_LIMITS.zip.maxTotalUncompressedBytes, 256 * 1024 * 1024);
  assert.equal(IMPORT_LIMITS.zip.maxImages, 10_000);
  const tooManyImages = Object.fromEntries(Array.from({ length: IMPORT_LIMITS.zip.maxImages + 1 }, (_, index) => [`images/${String(index).padStart(64, "0")}.png`, { mimeType: "image/png" }]));
  await assert.rejects(
    () => parseQuestionBankZip(toArrayBuffer(buildStoredZip([{ name: "bank.json", data: new TextEncoder().encode(JSON.stringify({ images: tooManyImages, questions: [{ content: [], options: [] }] })) }]))),
    (error: unknown) => error instanceof QuestionBundleError && /图片数量超过上限/.test(error.message),
    "ZIP 图片总数超过 10000 必须在读取媒体前拒绝",
  );
  await assert.rejects(
    () => parseQuestionBankZip(toArrayBuffer(buildStoredZip([
      { name: "bank.json", data: new TextEncoder().encode(JSON.stringify({ questions: [] })) },
      { name: "bank.json", data: new Uint8Array([1]) },
    ]))),
    (error: unknown) => error instanceof QuestionBundleError && /重复路径/.test(error.message),
    "ZIP 压缩包重复路径必须拒绝",
  );
  console.log("4. zip 完整性校验（篡改 / 缺失引用）通过");
}

// ---------------------------------------------------------------------------
// 5. 占位符边界：悬空占位符剥离、无图纯 JSON 回归
// ---------------------------------------------------------------------------
{
  await importQuestionBankV7("悬空占位符.json", [
    { stem: "题干【图1】中间【图2】结尾", options: ["甲", "乙"], optionIds: ["a", "b"], solution: { kind: "choice", correctOptionIds: ["a"] }, type: "单选" },
  ]);
  const all = await dbV7.questions.toArray();
  const dangling = all.find((question) => question.content.some((block) => block.type === "text" && block.text.includes("题干")));
  assert.ok(dangling, "悬空占位符题应导入");
  assert.equal(dangling!.content.filter((block) => block.type === "image").length, 0, "无图片数据时不产生图片块");
  assert.equal(dangling!.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join(""), "题干中间结尾", "悬空占位符应从文本剥离");

  // Excel 表格校验：图片列只接受嵌入图片。
  assert.throws(() => parseQuestionBankTable([
    ["题干", "题型", "标签", "解析", "答案1", "A", "B", "图片1"],
    ["文字占位", "单选", "", "", "A", "甲", "乙", "不是图片"],
  ]), (error: unknown) => (error as { issues?: Array<{ message: string }> }).issues?.some((issue) => /图片列只能包含嵌入图片/.test(issue.message)), "图片列的纯文字应校验失败");

  // 图片列表头必须从 图片1 连续编号。
  assert.throws(() => parseQuestionBankTable([
    ["题干", "题型", "标签", "解析", "答案1", "A", "B", "图片2"],
    ["跳号", "单选", "", "", "A", "甲", "乙", ""],
  ]), (error: unknown) => (error as { issues?: Array<{ message: string }> }).issues?.some((issue) => /图片1、图片2/.test(issue.message)), "图片列表头跳号应校验失败");
  await assert.rejects(
    () => importQuestionBankFile({ name: "超大.json", type: "application/json", size: IMPORT_LIMITS.json.maxBytes + 1, text: async () => "" } as unknown as File),
    /JSON 文件超过 128 MB 上限/,
    "JSON 文件大小必须在解析前受 128 MiB 限制",
  );
  const tooManyJsonQuestions = JSON.stringify({ questions: Array.from({ length: IMPORT_LIMITS.json.maxQuestions + 1 }, () => ({ stem: "题", type: "单选", options: ["甲", "乙"], optionIds: ["a", "b"], solution: { kind: "choice", correctOptionIds: ["a"] } })) });
  await assert.rejects(
    () => importQuestionBankFile(new File([tooManyJsonQuestions], "超多题.json", { type: "application/json" })),
    /JSON 题库最多包含 50000 道题/,
    "JSON 题目数量必须在写入数据库前受 50000 限制",
  );
  console.log("5. 占位符与表头校验边界通过");
}

// ---------------------------------------------------------------------------
// 6. 尺寸嗅探：png / jpeg / webp
// ---------------------------------------------------------------------------
{
  assert.deepEqual(sniffImageDimensions(pngA), { width: 640, height: 480 }, "png 尺寸");
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x05, 0x00, 0x07, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
  assert.deepEqual(sniffImageDimensions(jpeg), { width: 7, height: 5 }, "jpeg SOF0 尺寸");
  const webpLossless = new Uint8Array(30);
  webpLossless.set(new TextEncoder().encode("RIFF"), 0);
  webpLossless.set(new TextEncoder().encode("WEBP"), 8);
  webpLossless.set(new TextEncoder().encode("VP8L"), 12);
  new DataView(webpLossless.buffer).setUint32(16, 5, true);
  webpLossless[20] = 0x2f;
  const bits = ((64 - 1) & 0x3fff) | (((32 - 1) & 0x3fff) << 14);
  new DataView(webpLossless.buffer).setUint32(21, bits, true);
  assert.deepEqual(sniffImageDimensions(webpLossless), { width: 64, height: 32 }, "webp VP8L 尺寸");
  assert.equal(sniffImageDimensions(new Uint8Array([1, 2, 3])), undefined, "垃圾字节返回 undefined");
  console.log("6. 图片尺寸嗅探（png/jpeg/webp）通过");
}

// ---------------------------------------------------------------------------
// 7. collectExportImages：Excel 转换 WebP，ZIP 保留原图，缺失图片可诊断
// ---------------------------------------------------------------------------
{
  const webpBytes = (() => {
    const bytes = new Uint8Array(30);
    bytes.set(new TextEncoder().encode("RIFF"), 0);
    bytes.set(new TextEncoder().encode("WEBP"), 8);
    bytes.set(new TextEncoder().encode("VP8L"), 12);
    new DataView(bytes.buffer).setUint32(16, 5, true);
    bytes[20] = 0x2f;
    const bits = ((64 - 1) & 0x3fff) | (((32 - 1) & 0x3fff) << 14);
    new DataView(bytes.buffer).setUint32(21, bits, true);
    return bytes;
  })();
  let inFlight = 0;
  let maxInFlight = 0;
  const loader = async (assetId: string) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      if (assetId === idA) return { blob: new Blob([pngA], { type: "image/png" }), mimeType: "image/png" as const, width: 640, height: 480 };
      if (assetId === idB) return { blob: new Blob([webpBytes], { type: "image/webp" }), mimeType: "image/webp" as const, width: 64, height: 32 };
      return undefined;
    } finally {
      inFlight -= 1;
    }
  };
  const collected = await collectExportImages(imageQuestions, {
    loadAsset: loader,
    convertWebp: async (blob) => new Blob([await blob.arrayBuffer()], { type: "image/png" }),
  });
  assert.ok(collected.images.has(idA), "png 直接透传");
  assert.equal(collected.images.get(idA)!.mimeType, "image/png");
  assert.ok(collected.images.has(idB), "webp 经转换后可用");
  assert.equal(collected.images.get(idB)!.mimeType, "image/png", "webp 必须转为 png 才能嵌入 Excel");
  assert.deepEqual(collected.missing, [idC], "缓存被清理的图片进入缺失列表");
  assert.ok(maxInFlight >= 2 && maxInFlight <= 6, "导出图片应通过不超过 6 路的有界并发收集");

  const webpId = await sha256Bytes(webpBytes);
  const webpQuestion: ExportQuestionInput = {
    id: "webp-question",
    type: "单选",
    stem: "识别原图",
    options: ["甲", "乙"],
    optionIds: ["webp-a", "webp-b"],
    solution: { kind: "choice", correctOptionIds: ["webp-a"] },
    tags: ["WebP"],
    content: [text("识别原图"), image(webpId)],
    optionBlocks: [[text("甲")], [text("乙")]],
  };
  const portable = await collectExportImages([webpQuestion], {
    target: "bundle",
    loadAsset: async (assetId) => assetId === webpId
      ? { blob: new Blob([webpBytes], { type: "image/webp" }), mimeType: "image/webp", width: 64, height: 32 }
      : undefined,
    convertWebp: async () => { throw new Error("便携导出不应转换 WebP"); },
  });
  assert.deepEqual(portable.missing, [], "ZIP 原图可完整收集");
  assert.equal(portable.images.get(webpId)?.mimeType, "image/webp", "ZIP 必须保留 WebP 格式");
  assert.deepEqual(portable.images.get(webpId)?.bytes, webpBytes, "ZIP 必须保留原始字节与内容哈希");
  const portableZip = buildQuestionBankZip("WebP 原图题库", [webpQuestion], new Map(), portable.images);
  assert.ok(zipEntryNames(portableZip).includes(`images/${webpId}.webp`), "ZIP 使用原格式扩展名保存内容寻址图片");
  const portableParsed = await parseQuestionBankZip(toArrayBuffer(portableZip));
  assert.equal(portableParsed.images[0]?.assetId, webpId, "原图 ZIP 应通过哈希校验并可重新导入");
  // 缺失图片的占位符降级：图片列数收缩、缺失图的占位符消失。
  const degradedPlan = questionExportSheetPlan(imageQuestions, notes, collected.images);
  assert.equal(degradedPlan.imageColumnCount, 1, "缺失 C 后单题最多 1 张图，图片列收缩为 1");
  assert.equal(degradedPlan.rows[3][9], `=DISPIMG("ID_${idB}",1)`, "仍在缓存的 B 图保留");
  assert.ok(!degradedPlan.rows[3][6]?.includes("【图"), "缺失图片的占位符应消失");
  const exportDialogSource = readFileSync(new URL("../../src/app/bank/bank-library/bank-export-dialog.tsx", import.meta.url), "utf8");
  assert.match(exportDialogSource, /dbV7\.imageAssets\.bulkGet\(ids\)/, "UI 导出应先批量读取当前题库图片 descriptor");
  assert.match(exportDialogSource, /syncApplication\.downloadImageAssets\(missingIds\)/, "UI 导出遇到缓存缺失时必须通过同步边界一次批量补回图片");
  assert.match(exportDialogSource, /collectImageAssetIds\(questions\)/, "UI 导出只应解析当前题库实际引用的图片");
  assert.doesNotMatch(exportDialogSource, /loadImageAssetV7/, "UI 导出不得回退为逐图远端解析");
  assert.match(exportDialogSource, /if \(missing\.length\) throw new Error/, "仍有缺图时必须取消导出，不能生成不完整 Excel");
  assert.match(exportDialogSource, /target: "bundle"/, "便携 ZIP 必须走保留原图的收集路径");
  assert.match(exportDialogSource, /questionPortableExportFormat\(questions\)/, "UI 必须复用可单测的 JSON/ZIP 决策规则");
  assert.match(exportDialogSource, /导出 JSON \/ ZIP/, "导出入口必须明确提示实际文件类型");
  console.log("7. 图片收集（Excel 转换 / ZIP 原图 / 缺失诊断）通过");
}

console.log("题库图片导出导入专项测试通过");
process.exit(0);
