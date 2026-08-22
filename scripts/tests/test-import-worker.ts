import assert from "node:assert/strict";
import { createImportParseWorkerClient, type ImportWorkerLike } from "../../src/lib/io/import-worker-client";
import type { ImportWorkerMessage, ImportWorkerResponse } from "../../src/lib/io/import-worker-protocol";
import { XlsxImportError } from "../../src/lib/io/xlsx-import";

function jsonFile(content: string): File {
  return new File([content], "bank.json", { type: "application/json" });
}

interface FakeWorkerHarness {
  worker: ImportWorkerLike;
  posted: Array<{ message: ImportWorkerMessage; transfer?: Transferable[] }>;
  terminated: boolean;
  respond(response: ImportWorkerResponse): void;
  crash(): void;
}

function fakeWorkerHarness(): FakeWorkerHarness {
  const posted: Array<{ message: ImportWorkerMessage; transfer?: Transferable[] }> = [];
  let terminated = false;
  const worker: ImportWorkerLike = {
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
      worker.onmessage?.({ data: response } as MessageEvent<ImportWorkerResponse>);
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
  const client = createImportParseWorkerClient(() => harness.worker);
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
  const client = createImportParseWorkerClient(() => harness.worker);
  const promise = client.parse(jsonFile("{}"), { kind: "json" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.respond({
    kind: "parse-error",
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
  const client = createImportParseWorkerClient(() => harness.worker);
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
  const client = createImportParseWorkerClient(() => undefined);
  const result = await client.parse(jsonFile(JSON.stringify([1, 2, 3])), { kind: "json" });
  assert.equal(result.kind, "json");
  assert.deepEqual(result.raw, [1, 2, 3]);
}

// 5. Concurrent parses are rejected instead of stranding the first request,
//    and responses whose requestId no longer matches are ignored.
{
  const harness = fakeWorkerHarness();
  const client = createImportParseWorkerClient(() => harness.worker);
  const first = client.parse(jsonFile("[1]"), { kind: "json" });
  await assert.rejects(client.parse(jsonFile("[2]"), { kind: "json" }), /一次只能解析一个题库文件/);
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
  const client = createImportParseWorkerClient(() => harness.worker);
  const promise = client.parse(jsonFile(JSON.stringify([7])), { kind: "json" });
  client.dispose();
  const result = await promise;
  assert.equal(result.kind, "json");
  assert.deepEqual(result.raw, [7]);
}

console.log("import parse worker tests passed: transfer, error rehydration, crash fallback, staleness, dispose");
