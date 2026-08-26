import assert from "node:assert/strict";
import { createChangeSetV7 } from "../../src/lib/sync/change-set-v7-codec";
import { SYNC_V7_MAX_EVENT_BYTES, SYNC_V7_OBJECT_PREFIX } from "../../src/lib/sync/sync-v7-head-types";
import { encodeSyncV7Event } from "../../src/lib/sync/sync-v7-head-operations";
import { hydrateSyncV7Events, offloadedRefOf, offloadSyncV7Events, SYNC_V7_INLINE_EVENT_BUDGET } from "../../src/lib/sync/sync-v7-payload";
import type { BankV7, QuestionV7 } from "../../src/lib/db/v7-types";

const at = "2026-08-13T00:00:00.000Z";
const bank: BankV7 = { id: "bank-1", name: "载荷题库", sortOrder: 0, questionCount: 0, importedAt: at, updatedAt: at, deviceId: "dev-a" };

// A change-set body of ~300 KiB — comfortably above both the 128 KiB inline
// budget and the 256 KiB hard event ceiling. This is the exact shape that used
// to throw "v7 event exceeds 262144 UTF-8 bytes".
function bigQuestion(): QuestionV7 {
  return { id: "q-big", type: "单选", content: [{ id: "stem-0", type: "text", text: "考点".repeat(150000) }], options: [[{ id: "a", type: "text", text: "A" }], [{ id: "b", type: "text", text: "B" }]], answer: "A", tags: [], contentFingerprint: "fp-big", updatedAt: at, deviceId: "dev-a" };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

const big = await createChangeSetV7({ deviceId: "dev-a", localSequence: 1, createdAt: at, mutation: { kind: "question.upsert", question: bigQuestion() } });
const small = await createChangeSetV7({ deviceId: "dev-a", localSequence: 2, createdAt: at, mutation: { kind: "bank.create", bank } });

// The budget sits below the hard inline ceiling so inline events stay safe.
assert.equal(SYNC_V7_INLINE_EVENT_BUDGET, 128 * 1024);
assert.ok(SYNC_V7_INLINE_EVENT_BUDGET < SYNC_V7_MAX_EVENT_BYTES, "inline budget must stay under the hard event ceiling");

// (1) Without offload, an oversized body cannot be encoded inline — this is the
// error the offload path exists to eliminate.
assert.throws(() => encodeSyncV7Event(big), /exceeds 262144/);

// (2) Offload moves the body into one content-addressed immutable object and
// leaves a thin stub.
const offloaded = await offloadSyncV7Events([big as unknown as Record<string, unknown>]);
assert.equal(offloaded.objects.length, 1, "the oversized body becomes exactly one immutable object");
assert.equal(offloaded.events.length, 1);
const objectFile = offloaded.objects[0];
assert.ok(objectFile.path.startsWith(SYNC_V7_OBJECT_PREFIX), "object lives in the v7 objects namespace");
const objectBytes = objectFile.bytes as Uint8Array;
const objectSha = await sha256Hex(objectBytes);
const stub = offloaded.events[0];
const ref = offloadedRefOf(stub);
assert.ok(ref, "the wire event is a stub carrying a payloadRef");
assert.equal(ref!.path, objectFile.path);
assert.equal(ref!.sha256, objectSha, "the ref digest matches the object body");
assert.equal(ref!.path.slice(SYNC_V7_OBJECT_PREFIX.length, SYNC_V7_OBJECT_PREFIX.length + 64), objectSha, "the path embeds the content digest");
// The stub preserves ordering/dedup identity but drops the heavy body.
assert.equal(stub.id, big.id);
assert.equal(stub.deviceId, "dev-a");
assert.equal(stub.localSequence, 1);
assert.equal(stub.kind, big.kind);
assert.equal(stub.digest, big.digest);
assert.equal((stub as { mutations?: unknown }).mutations, undefined, "the heavy mutations stay in the object");
// The stub now encodes inline without threatening the ceiling.
assert.doesNotThrow(() => encodeSyncV7Event(stub));

// (3) Hydration is lossless: stub → object → full change-set === original.
const store = new Map([[objectFile.path, objectBytes]]);
const hydrated = await hydrateSyncV7Events(offloaded.events, (r) => Promise.resolve(store.get(r.path)!));
assert.deepEqual(hydrated[0], big, "offload + hydrate must be a lossless round-trip");

// (4) Mixed inline + offloaded events hydrate in order.
const mixed = await offloadSyncV7Events([small, big, small] as unknown as Record<string, unknown>[]);
assert.equal(mixed.objects.length, 1, "only the oversized event is offloaded");
assert.equal(mixed.events.length, 3);
assert.equal(offloadedRefOf(mixed.events[0]), undefined, "small events stay inline");
assert.ok(offloadedRefOf(mixed.events[1]), "the big event becomes a stub");
assert.equal(offloadedRefOf(mixed.events[2]), undefined);
const mixedStore = new Map(mixed.objects.map((o) => [o.path, o.bytes as Uint8Array]));
const mixedHydrated = await hydrateSyncV7Events(mixed.events, (r) => Promise.resolve(mixedStore.get(r.path)!));
assert.deepEqual(mixedHydrated, [small, big, small], "order and identity are preserved across the round-trip");

// (5) A tampered object body (same size, different content) is rejected.
const tampered = objectBytes.slice();
tampered[0] = tampered[0]! ^ 0xff;
await assert.rejects(() => hydrateSyncV7Events(offloaded.events, () => Promise.resolve(tampered)), /integrity/, "a mutated body must fail the sha256/size check");

// (6) Idempotency: identical bodies hash to identical paths, so re-publication
// never conflicts and never duplicates.
const reoffloaded = await offloadSyncV7Events([big as unknown as Record<string, unknown>]);
assert.equal(reoffloaded.objects[0]!.path, objectFile.path, "the same body always offloads to the same path");

// (7) Budget boundary: small events stay inline (same reference); a zero budget
// forces everything offload.
const tinyResult = await offloadSyncV7Events([small as unknown as Record<string, unknown>]);
assert.equal(tinyResult.objects.length, 0);
assert.equal(tinyResult.events[0], small, "an inline event is passed through untouched");
const forced = await offloadSyncV7Events([small as unknown as Record<string, unknown>], 0);
assert.equal(forced.objects.length, 1, "a zero budget offloads even small events");

console.log("sync v7 payload offload tests passed: ceiling bypass, lossless round-trip, ordering, integrity, idempotency and budget boundary");
