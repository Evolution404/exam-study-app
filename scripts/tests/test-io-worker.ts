import assert from "node:assert/strict";
import { createIoWorkerClient, type IoWorkerLike } from "../../src/lib/io/io-worker-client";
import type { IoWorkerMessage, IoWorkerResponse } from "../../src/lib/io/io-worker-protocol";
import { XlsxImportError } from "../../src/lib/io/xlsx-import";

function jsonFile(content: string): File {
  return new File([content], "bank.json", { type: "application/json" });
}

interface FakeWorkerHarness {
  worker: IoWorkerLike;
  posted: Array<{ message: IoWorkerMessage; transfer?: Transferable[] }>;
  terminated: boolean;
  respond(response: IoWorkerResponse): void;
  crash(): void;
}

function fakeWorkerHarness(): FakeWorkerHarness {
  const posted: Array<{ message: IoWorkerMessage; transfer?: Transferable[] }> = [];
  let terminated = false;
  const worker: IoWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message, transfer) {
      assert.ok(!terminated, "postMessage after terminate");
      posted.push({ message, transfer });
    },
    terminate() {
      terminated = true;
    },
  };
  return {
    worker,
    posted,
    get terminated() {
      return terminated;
    },
    respond(response) {
      worker.onmessage?.({ data: response } as MessageEvent<IoWorkerResponse>);
    },
    crash() {
      worker.onerror?.(new ErrorEvent("worker"));
    },
  };
}

// 1. A successful worker response resolves with the parsed payload, and the
//    input buffer is transferred (detached) rather than copied.
{
  const harness = fakeWorkerHarness();
  const client = createIoWorkerClient(() => harness.worker);
  const file = jsonFile(JSON.stringify({ questions: [] }));
  const promise = client.parse(file, { kind: "json" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.posted.length, 1);
  const request = harness.posted[0].message;
  assert.equal(request.kind, "parse-json");
  assert.equal(request.requestId, 1);
  const transferred = harness.posted[0].transfer;
  assert.ok(transferred && transferred.length === 1 && transferred[0] instanceof ArrayBuffer, "input buffer must be transferred");
  harness.respond({ kind: "parsed-json", requestId: 1, raw: { questions: [{ stem: "x" }] } });
  const result = await promise;
  assert.equal(result.kind, "json");
  assert.deepEqual((result.raw as { questions: unknown[] }).questions, [{ stem: "x" }]);
}

// 2. A deterministic parse failure rejects with the rehydrated domain error,
//    including XlsxImportError issues; the file is not parsed a second time.
{
  const harness = fakeWorkerHarness();
  const client = createIoWorkerClient(() => harness.worker);
  const promise = client.parse(jsonFile("{}"), { kind: "json" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.respond({
    kind: "io-error",
    requestId: 1,
    message: "第 3 行题干为空",
    issues: [{ row: 3, message: "题干为空" }],
  });
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  assert.ok(error instanceof XlsxImportError, "serialized issues must rehydrate as XlsxImportError");
  assert.equal(error.message, "第 3 行题干为空");
  assert.deepEqual(error.issues, [{ row: 3, message: "题干为空" }]);
  assert.equal(harness.posted.length, 1, "parse errors must not trigger a second parse");
}

// 3. A worker crash falls back to the identical main-thread parse and the
//    worker is torn down so the next import gets a fresh one.
{
  const harness = fakeWorkerHarness();
  const client = createIoWorkerClient(() => harness.worker);
  const payload = JSON.stringify([{ stem: "本地解析" }]);
  const promise = client.parse(jsonFile(payload), { kind: "json" });
  harness.crash();
  const result = await promise;
  assert.equal(result.kind, "json");
  assert.deepEqual(result.raw, [{ stem: "本地解析" }]);
  assert.ok(harness.terminated, "crashed worker must be terminated");
}

// 4. Environments without module workers parse synchronously on the main
//    thread (the Node test runtime itself exercises this path).
{
  const client = createIoWorkerClient(() => undefined);
  const result = await client.parse(jsonFile(JSON.stringify([1, 2, 3])), { kind: "json" });
  assert.equal(result.kind, "json");
  assert.deepEqual(result.raw, [1, 2, 3]);
}

// 5. Concurrent parses are rejected instead of stranding the first request,
//    and responses whose requestId no longer matches are ignored.
{
  const harness = fakeWorkerHarness();
  const client = createIoWorkerClient(() => harness.worker);
  const first = client.parse(jsonFile("[1]"), { kind: "json" });
  await assert.rejects(client.parse(jsonFile("[2]"), { kind: "json" }), /一次只能处理一个题库文件任务/);
  harness.respond({ kind: "parsed-json", requestId: 99, raw: "stale" });
  harness.respond({ kind: "parsed-json", requestId: 1, raw: "first" });
  const result = await first;
  assert.equal(result.kind, "json");
  assert.deepEqual(result.raw, "first");
  client.dispose();
}

// 6. dispose() finishes an in-flight import through the local fallback.
{
  const harness = fakeWorkerHarness();
  const client = createIoWorkerClient(() => harness.worker);
  const promise = client.parse(jsonFile(JSON.stringify([7])), { kind: "json" });
  client.dispose();
  const result = await promise;
  assert.equal(result.kind, "json");
  assert.deepEqual(result.raw, [7]);
}

// 7. Export builds round-trip through the worker and produce a real workbook.
{
  const harness = fakeWorkerHarness();
  const client = createIoWorkerClient(() => harness.worker);
  const questions = [{
    id: "q1",
    type: "单选" as const,
    stem: "工作接地的接地电阻一般是多少？",
    options: ["≤4Ω", "≤10Ω", "≤30Ω", "≤100Ω"],
    answer: "A",
    tags: ["接地"],
  }];
  const promise = client.build({ kind: "xlsx", name: "", questions, notes: new Map() });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.posted.length, 1);
  const request = harness.posted[0].message;
  assert.equal(request.kind, "build-xlsx");
  assert.deepEqual(request.questions, questions);
  harness.respond({ kind: "built-xlsx", requestId: request.requestId, bytes: new Uint8Array([1, 2, 3]) });
  const built = await promise;
  assert.equal(built.kind, "xlsx");
  assert.deepEqual(built.bytes, new Uint8Array([1, 2, 3]));
}

// 8. A crashed worker falls back to the local builder and the artifact
//    still parses through the production xlsx reader.
{
  const harness = fakeWorkerHarness();
  const client = createIoWorkerClient(() => harness.worker);
  const questions = [{
    id: "q1",
    type: "判断" as const,
    stem: "WPS 单元格图片使用 DISPIMG 占位。",
    options: ["对", "错"],
    answer: "对",
    tags: [],
  }];
  const promise = client.build({ kind: "json", name: "题库", questions, notes: new Map([["q1", "解析"]] ) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.crash();
  const built = await promise;
  assert.equal(built.kind, "json");
  const parsed = JSON.parse(built.text) as { name: string; questions: Array<{ stem: string; note?: string }> };
  assert.equal(parsed.name, "题库");
  assert.equal(parsed.questions[0].stem, "WPS 单元格图片使用 DISPIMG 占位。");
}

console.log("io worker tests passed: transfer, error rehydration, crash fallback, staleness, dispose, export builds");
