import assert from "node:assert/strict";
import { ActiveElapsedTimer } from "../../src/lib/practice/active-elapsed-time";

const timer = new ActiveElapsedTimer(1_000);
assert.equal(timer.elapsedMs(2_500), 1_500, "前台作答时间应累计");
timer.setPaused(true, 3_000);
assert.equal(timer.elapsedMs(30_000), 2_000, "暂停期间不得累计作答时间");
timer.setPaused(false, 40_000);
assert.equal(timer.elapsedMs(41_250), 3_250, "恢复后应从恢复时刻继续累计");
timer.setPaused(true, 41_500);
timer.setPaused(true, 50_000);
assert.equal(timer.elapsedMs(60_000), 3_500, "重复暂停必须幂等");
timer.reset(70_000);
assert.equal(timer.elapsedMs(70_800), 800, "立即重答必须从零重新计时");
timer.setPaused(true, 70_500);
assert.equal(timer.elapsedMs(80_000), 800, "单调时钟异常回拨不得扣减已累计时间");
timer.reset(90_000, true);
assert.equal(timer.elapsedMs(100_000), 0, "隐藏状态重置后应保持暂停");

console.log("active elapsed timer tests passed: active, pause, resume, reset and monotonic-clock guard");
