import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { createBankV6, createQuestionV6, dbV6, importQuestionBankV6, resetV6Database } from "../../src/lib/db/db-v6";
import { getSyncHotWindowState, syncWithGitHub } from "../../src/lib/sync/github-sync-v7";
import { startMockGitHubServer } from "../tools/mock-github-server.mjs";

// Exercises the hot-window segment coalescer along two axes the naive
// "30 identical tiny syncs" check misses:
//   1. REPEATED coalescing — after a merge the segment count climbs again and
//      must trip the threshold a 2nd/3rd time, not just once.
//   2. MIXED segment sizes — one big segment (a sync pushing many events) amid
//      many small ones must be re-grouped correctly with no data loss.
// Once 24 segments gather (and none is large enough to trip the 4 MiB byte
// compaction), the push path re-packs them into fewer segments WITHOUT a new
// checkpoint.

let currentDeviceId = "device-a";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => (key === "shijuan-study-v6-device-id" ? currentDeviceId : null),
    setItem: (key: string, value: string) => {
      if (key === "shijuan-study-v6-device-id") currentDeviceId = value;
    },
  },
});

const server = await startMockGitHubServer();
const settings = { owner: "qa", repo: "coalesce-vault", branch: "main", apiBaseUrl: server.url };
const sync = () => syncWithGitHub(settings, "qa-token");

async function freshClient(deviceId: string): Promise<void> {
  currentDeviceId = deviceId;
  await resetV6Database();
}

const LONG_STEM_BODY = "这是一道用于考察热窗口大小段混合合并能力的长题干题目，题干包含较多上下文与细节描述，目的是在一次同步中产生一个明显大于普通单题分段的大段，从而验证合并器在重新分组时不会丢失或损坏其中任何事件。";

function shortChoice(stem: string): Parameters<typeof createQuestionV6>[1] {
  return {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: stem }],
    options: ["甲", "乙", "丙", "丁"].map((text, index) => [{ id: `opt-${index}`, type: "text", text }]),
    answer: "A",
    tags: ["合并测试"],
  };
}

// A long-stem single choice: each serialized event is ~2 KB, so staging 100 of
// them and pushing in one sync yields ONE large segment instead of 100 tiny ones.
function longChoice(stem: string): Parameters<typeof createQuestionV6>[1] {
  return {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: stem }],
    options: ["甲", "乙", "丙", "丁"].map((text, index) => [{ id: `opt-${index}`, type: "text", text }]),
    answer: "A",
    tags: ["混合合并"],
  };
}

// A heavy but still INLINE single choice (~78 KB text, under the 128 KB offload
// budget). Staging ~55 and pushing in one sync drives the hot window past the
// 4 MiB byte compaction threshold without offloading any of them.
function bigInlineChoice(index: number): Parameters<typeof createQuestionV6>[1] {
  return {
    type: "单选",
    content: [{ id: "stem-0", type: "text", text: `压缩触发第 ${index} 题：` + "考".repeat(26000) }],
    options: ["甲", "乙", "丙", "丁"].map((text, i) => [{ id: `opt-${i}`, type: "text", text }]),
    answer: "A",
    tags: ["压缩触发"],
  };
}

const SEGMENT_THRESHOLD = 24;

interface Trace { n: number; segments: number; bytes: number; coalesced: boolean; }

async function syncAndTrace(n: number): Promise<Trace> {
  const result = await sync();
  const state = await getSyncHotWindowState(settings);
  return { n, segments: state?.segmentCount ?? -1, bytes: state?.hotBytes ?? -1, coalesced: Boolean(result.coalesced) };
}

function summarize(traces: Trace[]): { coalescePoints: Trace[]; peak: number; final: Trace } {
  return {
    coalescePoints: traces.filter((trace) => trace.coalesced),
    peak: Math.max(...traces.map((trace) => trace.segments)),
    final: traces.at(-1)!,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: repeated coalescing — 70 single-question syncs must trip the
// threshold multiple times, never settling above it, with full data recovery.
// ---------------------------------------------------------------------------
{
  server.reset();
  await freshClient("device-a");
  await sync(); // initialise an empty vault (creates a checkpoint, 0 segments)
  const bank = await createBankV6("反复合并题库");
  await sync();

  const count = 70;
  const traces: Trace[] = [];
  for (let index = 0; index < count; index += 1) {
    await createQuestionV6(bank.id, shortChoice(`反复合并第 ${index + 1} 题：考点 ${index} 的正确选项是？`));
    traces.push(await syncAndTrace(index + 1));
  }
  const { coalescePoints, peak, final } = summarize(traces);

  assert.ok(coalescePoints.length >= 2, `70 次小同步应触发反复合并至少 2 次（实际 ${coalescePoints.length} 次）`);
  assert.ok(peak < SEGMENT_THRESHOLD, `合并后观测到的最大段数应 < ${SEGMENT_THRESHOLD}（实际峰值 ${peak}）`);
  const finalState = await getSyncHotWindowState(settings);
  assert.ok(finalState, "同步后应能读取热窗口状态");
  assert.equal(finalState.hasCheckpoint, true, "应始终保留检查点（合并不生成新检查点）");
  assert.ok(finalState.hotBytes < finalState.hotBytesMax, `热窗口字节应远低于 ${finalState.hotBytesMax}（实际 ${finalState.hotBytes}）`);
  // 合并只重排分段、不生成检查点：检查点代数必须仍是初始化时的第 0 代，
  // 而头代随每次同步持续增长。二者只有在检查点代数被误从分段推导时才会相等。
  assert.equal(finalState.checkpointGeneration, 0, "合并分段不得改变检查点代数（应仍为第 0 代）");
  assert.ok(finalState.generation >= count, `头代应随同步增长到至少 ${count}（实际 ${finalState.generation}）`);

  await freshClient("device-b");
  await sync();
  const pulled = await dbV6.questions.count();
  assert.equal(pulled, count, `新设备拉取的题数应与源设备一致（期望 ${count}，实际 ${pulled}）`);

  console.log("scenario 1 passed: 反复合并稳定，每次到阈值即合并、段数始终低于阈值、跨设备数据完整");
  console.log(`  合并触发 ${coalescePoints.length} 次 @ sync#${coalescePoints.map((p) => p.n).join(", #")}，峰值段数 ${peak}，最终段数 ${final.segments}，热窗口 ${finalState.hotBytes}/${finalState.hotBytesMax} 字节`);
  console.log(`  轨迹采样(每10次段数): ${traces.filter((_, i) => i % 10 === 9).map((t) => t.segments).join(", ")}`);
}

// ---------------------------------------------------------------------------
// Scenario 2: mixed big + small segments — a big sync (one large segment) sits
// among many tiny ones; coalescing must re-pack the whole window correctly.
// ---------------------------------------------------------------------------
{
  server.reset();
  await freshClient("device-a");
  await sync();
  const bank = await createBankV6("混合合并题库");
  await sync();

  const smallBefore = 15;
  for (let index = 0; index < smallBefore; index += 1) {
    await createQuestionV6(bank.id, shortChoice(`混合·前置小同步第 ${index + 1} 题`));
    await sync();
  }
  const beforeBig = await getSyncHotWindowState(settings);
  assert.equal(beforeBig?.segmentCount, smallBefore + 1, `${smallBefore} 次小同步+题库后应有 ${smallBefore + 1} 个分段`);

  // One BIG sync: stage 100 long-stem questions, push them in a single sync so
  // they paginate into one large segment (~200 KB), not 100 tiny ones.
  const bigBatch = 100;
  for (let index = 0; index < bigBatch; index += 1) {
    await createQuestionV6(bank.id, longChoice(`${LONG_STEM_BODY}（批次 ${index + 1}）`));
  }
  const bigResult = await sync();
  const afterBig = await getSyncHotWindowState(settings);
  const bigDelta = (afterBig?.hotBytes ?? 0) - (beforeBig?.hotBytes ?? 0);
  assert.equal(bigResult.pushed, bigBatch, "大同步应一次性推送整批 100 个 change-set");
  assert.equal(afterBig?.segmentCount, smallBefore + 2, "大同步应只追加 1 个大分段（100 事件打包进同一段）");
  assert.ok(bigDelta > 100_000, `大分段应明显大于普通小段（单次增量 ${bigDelta} 字节应 > 100KB）`);

  // Keep doing tiny syncs until the window reaches the threshold and coalesces.
  let smallAfter = 0;
  let coalescedTrace: Trace | undefined;
  let preCoalesceBytes = 0;
  for (let guard = 0; guard < SEGMENT_THRESHOLD + 4; guard += 1) {
    const preState = await getSyncHotWindowState(settings);
    await createQuestionV6(bank.id, shortChoice(`混合·后置小同步第 ${guard + 1} 题`));
    const trace = await syncAndTrace(guard + 1);
    smallAfter += 1;
    if (trace.coalesced) { coalescedTrace = trace; preCoalesceBytes = preState?.hotBytes ?? 0; break; }
  }
  assert.ok(coalescedTrace, "大小段混合后应再次到达阈值并触发合并");
  assert.ok(coalescedTrace!.segments < (smallBefore + 2), `合并后段数应回落到大同步前以下（实际 ${coalescedTrace!.segments}）`);

  // Coalescing re-groups the SAME events: the payload survives, so the hot
  // window keeps ~all of its bytes (only per-segment envelope headers shrink).
  assert.ok(coalescedTrace!.bytes >= preCoalesceBytes * 0.9, `合并后热窗口字节应保留 ≥90%（合并前 ${preCoalesceBytes}B，合并后 ${coalescedTrace!.bytes}B）`);

  const expectedTotal = smallBefore + bigBatch + smallAfter;
  await freshClient("device-b");
  await sync();
  const pulledMixed = await dbV6.questions.count();
  assert.equal(pulledMixed, expectedTotal, `混合场景新设备拉取题数应一致（期望 ${expectedTotal}，实际 ${pulledMixed}）`);

  console.log("scenario 2 passed: 大段+小段混合，合并正确重排、负载不丢、跨设备数据完整");
  console.log(`  大同步前 ${beforeBig?.segmentCount} 段/${beforeBig?.hotBytes}B → 大同步后 ${afterBig?.segmentCount} 段/${afterBig?.hotBytes}B（单次 +${bigDelta}B）→ 合并前 ${preCoalesceBytes}B → 合并后 ${coalescedTrace!.segments} 段/${coalescedTrace!.bytes}B`);
}

// ---------------------------------------------------------------------------
// Scenario 3: multi-device concurrency — device A has already coalesced; device
// B has been editing locally and now syncs on top of A's coalesced head, then A
// re-syncs. The coalesced head must remain a valid CAS target and merge base.
// ---------------------------------------------------------------------------
{
  server.reset();
  await freshClient("device-a");
  await sync();
  const bankA = await createBankV6("多设备合并题库");
  await sync();

  // A drives the window to the threshold and coalesces.
  const aSmall = 23;
  let aCoalesced = 0;
  for (let index = 0; index < aSmall; index += 1) {
    await createQuestionV6(bankA.id, shortChoice(`多设备·A 第 ${index + 1} 题`));
    if ((await sync()).coalesced) aCoalesced += 1;
  }
  assert.ok(aCoalesced >= 1, `设备 A 应在积累到阈值后完成合并（实际 ${aCoalesced} 次）`);
  const aQuestionCount = await dbV6.questions.count();

  // B is a brand-new device that stages edits locally BEFORE syncing — exactly
  // the "another device edited some events while one already coalesced" case.
  await freshClient("device-b");
  const bankB = await createBankV6("设备B本地题库");
  const bLocal = 3;
  for (let index = 0; index < bLocal; index += 1) {
    await createQuestionV6(bankB.id, shortChoice(`多设备·B 本地第 ${index + 1} 题`));
  }
  const bResult = await sync(); // pulls A's coalesced head, then pushes B's edits
  assert.ok(bResult.pushed >= bLocal, `设备 B 应把本地 ${bLocal} 组编辑推送上去（实际 ${bResult.pushed}）`);
  const bQuestionCount = await dbV6.questions.count();
  assert.equal(bQuestionCount, aQuestionCount + bLocal, `设备 B 应同时拥有 A 的数据与自己的本地编辑（期望 ${aQuestionCount + bLocal}，实际 ${bQuestionCount}）`);

  // A re-syncs from scratch and must converge to the merged state.
  await freshClient("device-a");
  await sync();
  const aResynced = await dbV6.questions.count();
  assert.equal(aResynced, aQuestionCount + bLocal, `设备 A 重新同步后应收敛到合并状态（期望 ${aQuestionCount + bLocal}，实际 ${aResynced}）`);

  console.log("scenario 3 passed: 一设备已合并、另一设备带本地编辑同步，CAS 与双向合并正确，两设备收敛");
  console.log(`  A 合并 ${aCoalesced} 次后有 ${aQuestionCount} 题；B 推送 ${bResult.pushed} 组后 ${bQuestionCount} 题；A 重同步后 ${aResynced} 题`);
}

// ---------------------------------------------------------------------------
// Scenario 4: coalescing THEN compaction — after a count-based coalesce, push
// enough INLINE data to trip the 4 MiB byte compaction. The regenerated
// checkpoint must still snapshot every earlier event (incl. coalesced ones).
// ---------------------------------------------------------------------------
{
  server.reset();
  await freshClient("device-a");
  await sync();
  const bank = await createBankV6("合并后压缩题库");
  await sync();

  // Phase 1: small syncs to the count threshold -> coalesce (no checkpoint).
  const smallBeforeCompact = 23;
  let coalescedBeforeCompact = 0;
  for (let index = 0; index < smallBeforeCompact; index += 1) {
    await createQuestionV6(bank.id, shortChoice(`压缩·前置小同步第 ${index + 1} 题`));
    if ((await sync()).coalesced) coalescedBeforeCompact += 1;
  }
  assert.ok(coalescedBeforeCompact >= 1, "压缩前应先触发过至少一次合并");

  // Phase 2: one big sync of heavy INLINE events drives hot bytes > 4 MiB.
  const bigBatch = 55;
  for (let index = 0; index < bigBatch; index += 1) {
    await createQuestionV6(bank.id, bigInlineChoice(index));
  }
  const compactResult = await sync();
  assert.equal(compactResult.compacted, true, "热窗口超过 4 MiB 应触发检查点压缩");
  assert.equal(compactResult.coalesced, false, "压缩当次不应同时合并（压缩已清空分段）");
  const afterCompact = await getSyncHotWindowState(settings);
  assert.equal(afterCompact?.segmentCount, 0, "压缩应清空全部热窗口分段");
  assert.equal(afterCompact?.hasCheckpoint, true, "压缩后应存在检查点");
  assert.equal(afterCompact?.checkpointGeneration, afterCompact?.generation, "压缩后检查点代数应等于当前头代（窗口已空）");

  // A fresh device restores entirely from the new checkpoint + any segments.
  await freshClient("device-b");
  await sync();
  const pulled = await dbV6.questions.count();
  assert.equal(pulled, smallBeforeCompact + bigBatch, `压缩后新设备应完整恢复全部题目（期望 ${smallBeforeCompact + bigBatch}，实际 ${pulled}）`);

  console.log("scenario 4 passed: 先合并再触发 4 MiB 检查点压缩，新检查点完整覆盖合并前后的全部事件");
  console.log(`  前置合并 ${coalescedBeforeCompact} 次；大同步推送 ${compactResult.pushed} 组触发压缩；压缩后 ${afterCompact?.segmentCount} 段；新设备恢复 ${pulled} 题`);
}

// ---------------------------------------------------------------------------
// Scenario 5: coalescing with OFFLOADED objects — a segment carrying a payload
// stub (a >128 KB change-set offloaded to an immutable object) must pass through
// coalescing unchanged, so a fresh device can still hydrate it afterwards.
// ---------------------------------------------------------------------------
{
  server.reset();
  await freshClient("device-a");
  await sync();

  // One large import (>128 KB) becomes a single offloaded change-set: its
  // segment carries only a stub pointing at sync/v7/objects/<sha>.json.
  const rows = Array.from({ length: 600 }, (_, index) => ({ q: `卸载合并第 ${index + 1} 题：考点 ${index} 的详细描述与选项辨析。`, a: ["甲", "乙", "丙", "丁"], ans: "A" }));
  const bank = await importQuestionBankV6("offload-coalesce.json", rows);
  await sync();
  assert.ok(server.contentPaths().some((path) => path.startsWith("sync/v7/objects/")), "大导入应卸载为不可变对象");
  const afterImport = await getSyncHotWindowState(settings);
  assert.equal(afterImport?.segmentCount, 1, "大导入应只占 1 个带 stub 的分段");

  // Small syncs carry the window to the threshold; the stub segment rides along.
  const smallAfterImport = 23;
  let coalescedWithStub = false;
  for (let index = 0; index < smallAfterImport; index += 1) {
    await createQuestionV6(bank.id, shortChoice(`卸载合并·小同步第 ${index + 1} 题`));
    if ((await sync()).coalesced) coalescedWithStub = true;
  }
  assert.ok(coalescedWithStub, "带 stub 的热窗口到达阈值应触发合并");
  assert.ok(server.contentPaths().some((path) => path.startsWith("sync/v7/objects/")), "合并后不可变对象应仍然存在（内容寻址，不被删除）");

  // The fresh device pulls the coalesced segments and must hydrate the stub.
  await freshClient("device-b");
  await sync();
  const pulled = await dbV6.questions.count();
  assert.equal(pulled, 600 + smallAfterImport, `合并后新设备应能从 stub 水合出全部题目（期望 ${600 + smallAfterImport}，实际 ${pulled}）`);

  console.log("scenario 5 passed: 含卸载对象 stub 的分段经合并后仍可被新设备水合，数据完整");
  console.log(`  导入卸载后 ${afterImport?.segmentCount} 段；小同步到阈值触发合并；新设备水合 ${pulled} 题`);
}

// ---------------------------------------------------------------------------
// Scenario 6: a LARGE segment (≥ half the 1 MiB per-segment ceiling) must be
// left UNTOUCHED by coalescing. Only the small segments trailing behind it get
// merged; the big one keeps its exact bytes/path (never re-downloaded/re-uploaded).
// ---------------------------------------------------------------------------
{
  server.reset();
  await freshClient("device-a");
  await sync();
  const bank = await createBankV6("大段保留题库");
  await sync();

  // One big sync: 11 heavy inline questions pack into a single ~858 KiB segment
  // (≥ SYNC_V7_COALESCE_LEAVE_BYTES = 512 KiB, so it is classified "large").
  const bigBatch = 11;
  for (let index = 0; index < bigBatch; index += 1) {
    await createQuestionV6(bank.id, bigInlineChoice(index));
  }
  await sync();
  const beforeSmall = await getSyncHotWindowState(settings);
  const largeSegmentSize = Math.max(...(beforeSmall?.segmentSizes ?? [0]));
  assert.ok(largeSegmentSize >= 512 * 1024, `应存在一个大分段（≥512KB，实际 ${largeSegmentSize}B）`);

  // Drive the window to the threshold with tiny syncs AFTER the big segment.
  let coalescedTrace: Trace | undefined;
  let smallCount = 0;
  for (let guard = 0; guard < SEGMENT_THRESHOLD + 4; guard += 1) {
    await createQuestionV6(bank.id, shortChoice(`大段保留·后置小同步第 ${guard + 1} 题`));
    smallCount += 1;
    const trace = await syncAndTrace(guard + 1);
    if (trace.coalesced) { coalescedTrace = trace; break; }
  }
  assert.ok(coalescedTrace, "大段+小段达到阈值应触发合并");
  const afterCoalesce = await getSyncHotWindowState(settings);
  // The large segment's exact byte size survives untouched (same content → same
  // path → same size). If it had been re-packed the size would differ.
  assert.ok(afterCoalesce?.segmentSizes.includes(largeSegmentSize), `大分段应原样保留（合并后仍含 ${largeSegmentSize}B 的段；实际 [${afterCoalesce?.segmentSizes.join(", ")}]）`);
  assert.ok((afterCoalesce?.segmentCount ?? 0) >= 2, "大段应作为独立分段保留，未被并入小段");
  assert.ok((afterCoalesce?.segmentCount ?? 0) < SEGMENT_THRESHOLD, "小段应已被合并");

  await freshClient("device-b");
  await sync();
  const pulled = await dbV6.questions.count();
  assert.equal(pulled, bigBatch + smallCount, `新设备应完整恢复（期望 ${bigBatch + smallCount}，实际 ${pulled}）`);

  console.log("scenario 6 passed: 大段原样保留、仅合并其后的小段，跨设备数据完整");
  console.log(`  大分段 ${largeSegmentSize}B（≥512KB）保留；合并后 ${afterCoalesce?.segmentCount} 段，段大小 [${afterCoalesce?.segmentSizes.join(", ")}]；新设备恢复 ${pulled} 题`);
}

console.log("sync coalescing tests passed");
await server.close();
process.exit(0);
