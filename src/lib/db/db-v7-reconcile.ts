import Dexie, { type IndexableType, type Table } from "dexie";
import { dbV7 } from "./db-v7-core";
import { decomposePracticeRunV7 } from "./practice-run-store-v7";
import { directImagePlanV7, planImageAssetsV7, type ImageReconcilePlan } from "./db-v7-reconcile-images";
import type { V7RestoreState } from "./db-v7-core";
import type { V7ChangeSetQueueGuard } from "./db-v7-restore";

interface ReconcileV7ProjectionProgress {
  completed: number;
  total: number;
  label: string;
}

type ReconcileV7InstallMode = "full" | "fresh" | "dirty";

interface ReconcileV7Timing {
  phase: "plan" | "write";
  table: string;
  durationMs: number;
  scannedRows: number;
  comparedRows: number;
  putRows: number;
  deleteRows: number;
  mode: ReconcileV7InstallMode;
}

interface ReconcileV7DirtyKeys {
  banks: readonly string[];
  bankFolders: readonly string[];
  questions: readonly string[];
  memberships: readonly string[];
  imageAssets: readonly string[];
  attempts: readonly string[];
  attemptStats: readonly string[];
  attemptDailyStats: readonly string[];
  notes: readonly string[];
  practiceRuns: readonly string[];
  practiceRunStats: readonly string[];
  questionGroups: readonly string[];
  reviewRounds: readonly string[];
  reviewRoundProgress: readonly string[];
  tombstones: readonly string[];
}

interface ReconcileV7ProjectionOptions {
  queueGuard?: readonly V7ChangeSetQueueGuard[];
  clearChangeSets?: boolean;
  dirtyKeys?: ReconcileV7DirtyKeys;
  onProgress?: (progress: ReconcileV7ProjectionProgress) => void;
  onTiming?: (timing: ReconcileV7Timing) => void;
}

interface ReconcilePlan<T, K extends IndexableType = string> {
  puts: T[];
  deletes: K[];
  scannedRows: number;
  comparedRows: number;
}

const RECONCILE_BATCH_SIZE = 150;
const RECONCILE_PLAN_READ_BATCH_SIZE = 500;
const RECONCILE_STALL_TIMEOUT_MS = 30_000;

function clockMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function emitTiming(
  options: ReconcileV7ProjectionOptions,
  mode: ReconcileV7InstallMode,
  timing: Omit<ReconcileV7Timing, "mode">,
): void {
  options.onTiming?.({ ...timing, mode });
}

function queueRow(record: V7ChangeSetQueueGuard): string {
  return JSON.stringify([record.id, record.digest, record.state, record.claimId ?? null, record.claimedAt ?? null]);
}

function queueMatches(current: readonly V7ChangeSetQueueGuard[], expected: readonly V7ChangeSetQueueGuard[]): boolean {
  if (current.length !== expected.length) return false;
  const left = current.map(queueRow).sort();
  const right = expected.map(queueRow).sort();
  return left.every((value, index) => value === right[index]);
}

function equivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!equivalent(left[index], right[index])) return false;
    }
    return true;
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key) || !equivalent(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

async function projectionIsEmpty(): Promise<boolean> {
  const counts = await Promise.all([
    dbV7.banks.count(), dbV7.bankFolders.count(), dbV7.questions.count(), dbV7.bankQuestionMemberships.count(),
    dbV7.imageAssets.count(), dbV7.attempts.count(), dbV7.questionProgress.count(), dbV7.questionDailyProgress.count(),
    dbV7.notes.count(), dbV7.practiceRuns.count(), dbV7.bankPracticeStats.count(), dbV7.questionGroups.count(),
    dbV7.reviewRounds.count(), dbV7.reviewRoundProgress.count(), dbV7.tombstones.count(),
  ]);
  return counts.every((count) => count === 0);
}

function hasDirtyKeys(keys: ReconcileV7DirtyKeys | undefined): keys is ReconcileV7DirtyKeys {
  return Boolean(keys && Object.values(keys).some((items) => items.length > 0));
}

function freshPlan<T>(incoming: readonly T[], keyOf: (row: T) => string | undefined, tableName: string): ReconcilePlan<T> {
  const keys = new Set<string>();
  const puts = incoming.map((row) => {
    const key = keyOf(row);
    if (key === undefined) throw new Error(`远端 ${tableName} 存在缺少主键的记录，无法安全首次安装。`);
    if (keys.has(key)) throw new Error(`远端 ${tableName} 存在重复主键 ${key}，无法安全首次安装。`);
    keys.add(key);
    return row;
  });
  return { puts, deletes: [], scannedRows: 0, comparedRows: 0 };
}

function dirtyPlan<T>(
  incoming: readonly T[],
  dirtyKeys: readonly string[],
  keyOf: (row: T) => string | undefined,
  tableName: string,
): ReconcilePlan<T> {
  const wanted = new Set(dirtyKeys);
  const found = new Set<string>();
  const puts: T[] = [];
  if (wanted.size) {
    for (const row of incoming) {
      const key = keyOf(row);
      if (key === undefined) throw new Error(`远端 ${tableName} 存在缺少主键的记录，无法安全脏键同步。`);
      if (!wanted.has(key)) continue;
      if (found.has(key)) throw new Error(`远端 ${tableName} 存在重复主键 ${key}，无法安全脏键同步。`);
      found.add(key);
      puts.push(row);
    }
  }
  return {
    puts,
    deletes: [...wanted].filter((key) => !found.has(key)),
    scannedRows: 0,
    comparedRows: 0,
  };
}

function directPlanTimed<T>(
  mode: "fresh" | "dirty",
  table: Table<T, string>,
  incoming: readonly T[],
  keyOf: (row: T) => string | undefined,
  dirtyKeys: readonly string[] | undefined,
  options: ReconcileV7ProjectionOptions,
): ReconcilePlan<T> {
  const started = clockMs();
  const plan = mode === "fresh"
    ? freshPlan(incoming, keyOf, table.name)
    : dirtyPlan(incoming, dirtyKeys ?? [], keyOf, table.name);
  emitTiming(options, mode, {
    phase: "plan",
    table: table.name,
    durationMs: Math.max(0, clockMs() - started),
    scannedRows: 0,
    comparedRows: 0,
    putRows: plan.puts.length,
    deleteRows: plan.deletes.length,
  });
  return plan;
}

async function planTable<T>(
  table: Table<T, string>,
  incoming: readonly T[],
  keyOf: (row: T) => string | undefined,
): Promise<ReconcilePlan<T>> {
  const rawCurrentKeys = await table.toCollection().primaryKeys();
  const currentKeys = rawCurrentKeys.map((key) => {
    if (typeof key !== "string") throw new Error(`本机 ${table.name} 存在非字符串主键，无法安全增量同步。`);
    return key;
  });
  const incomingKeys = new Set<string>();
  const puts: T[] = [];

  for (let index = 0; index < incoming.length; index += RECONCILE_PLAN_READ_BATCH_SIZE) {
    const rows = incoming.slice(index, index + RECONCILE_PLAN_READ_BATCH_SIZE);
    const keys = rows.map((row) => {
      const key = keyOf(row);
      if (key === undefined) throw new Error(`远端 ${table.name} 存在缺少主键的记录，无法安全增量同步。`);
      if (incomingKeys.has(key)) throw new Error(`远端 ${table.name} 存在重复主键 ${key}，无法安全增量同步。`);
      incomingKeys.add(key);
      return key;
    });
    const current = await table.bulkGet(keys);
    for (let offset = 0; offset < rows.length; offset += 1) {
      const old = current[offset];
      if (old === undefined || !equivalent(old, rows[offset])) puts.push(rows[offset]);
    }
  }

  const deletes = currentKeys.filter((key) => !incomingKeys.has(key));
  return { puts, deletes, scannedRows: currentKeys.length + incoming.length, comparedRows: incoming.length };
}

function keyIdentity(key: IndexableType): string {
  return typeof key === "string" ? `s:${key}` : `j:${JSON.stringify(key)}`;
}

async function planCompoundTable<T, K extends IndexableType>(
  table: Table<T, K>,
  incoming: readonly T[],
  primaryKeyOf: (row: T) => K,
): Promise<ReconcilePlan<T, K>> {
  const currentKeys = await table.toCollection().primaryKeys();
  const incomingKeyIds = new Set<string>();
  const puts: T[] = [];
  for (let index = 0; index < incoming.length; index += RECONCILE_PLAN_READ_BATCH_SIZE) {
    const rows = incoming.slice(index, index + RECONCILE_PLAN_READ_BATCH_SIZE);
    const keys = rows.map((row) => {
      const key = primaryKeyOf(row);
      const identity = keyIdentity(key);
      if (incomingKeyIds.has(identity)) throw new Error(`远端 ${table.name} 存在重复复合主键 ${identity}，无法安全增量同步。`);
      incomingKeyIds.add(identity);
      return key;
    });
    const current = await table.bulkGet(keys);
    for (let offset = 0; offset < rows.length; offset += 1) {
      if (current[offset] === undefined || !equivalent(current[offset], rows[offset])) puts.push(rows[offset]);
    }
  }
  return {
    puts,
    deletes: currentKeys.filter((key) => !incomingKeyIds.has(keyIdentity(key))),
    scannedRows: currentKeys.length + incoming.length,
    comparedRows: incoming.length,
  };
}

function directCompoundPlan<T, K extends IndexableType>(
  mode: "fresh" | "dirty",
  table: Table<T, K>,
  incoming: readonly T[],
  primaryKeyOf: (row: T) => K,
  syncKeyOf: (row: T) => string,
  dirtyKeys: readonly string[] | undefined,
  primaryKeyFromSyncKey: (key: string) => K,
): ReconcilePlan<T, K> {
  const wanted = mode === "dirty" ? new Set(dirtyKeys ?? []) : undefined;
  const seen = new Set<string>();
  const puts: T[] = [];
  for (const row of incoming) {
    const syncKey = syncKeyOf(row);
    if (wanted && !wanted.has(syncKey)) continue;
    const identity = keyIdentity(primaryKeyOf(row));
    if (seen.has(identity)) throw new Error(`远端 ${table.name} 存在重复复合主键 ${identity}。`);
    seen.add(identity);
    puts.push(row);
  }
  const foundSyncKeys = new Set(puts.map(syncKeyOf));
  return {
    puts,
    deletes: mode === "dirty" ? [...wanted!].filter((key) => !foundSyncKeys.has(key)).map(primaryKeyFromSyncKey) : [],
    scannedRows: 0,
    comparedRows: 0,
  };
}

async function planTableTimed<T>(
  table: Table<T, string>,
  incoming: readonly T[],
  keyOf: (row: T) => string | undefined,
  options: ReconcileV7ProjectionOptions,
): Promise<ReconcilePlan<T>> {
  const started = clockMs();
  const plan = await planTable(table, incoming, keyOf);
  emitTiming(options, "full", {
    phase: "plan",
    table: table.name,
    durationMs: Math.max(0, clockMs() - started),
    scannedRows: plan.scannedRows,
    comparedRows: plan.comparedRows,
    putRows: plan.puts.length,
    deleteRows: plan.deletes.length,
  });
  return plan;
}

function directImagePlanTimed(
  mode: "fresh" | "dirty",
  incoming: V7RestoreState["imageAssets"],
  dirtyKeys: readonly string[] | undefined,
  options: ReconcileV7ProjectionOptions,
): ImageReconcilePlan {
  const started = clockMs();
  const plan = directImagePlanV7(mode, incoming, dirtyKeys);
  emitTiming(options, mode, {
    phase: "plan",
    table: dbV7.imageAssets.name,
    durationMs: Math.max(0, clockMs() - started),
    scannedRows: 0,
    comparedRows: 0,
    putRows: plan.inserts.length,
    deleteRows: plan.deletes.length,
  });
  return plan;
}

async function planImageAssetsTimed(
  incoming: V7RestoreState["imageAssets"],
  options: ReconcileV7ProjectionOptions,
): Promise<ImageReconcilePlan> {
  const started = clockMs();
  const plan = await planImageAssetsV7(incoming);
  emitTiming(options, "full", {
    phase: "plan",
    table: dbV7.imageAssets.name,
    durationMs: Math.max(0, clockMs() - started),
    scannedRows: plan.scannedRows,
    comparedRows: plan.comparedRows,
    putRows: plan.inserts.length + plan.updates.length,
    deleteRows: plan.deletes.length,
  });
  return plan;
}

async function applyPlan<T, K extends IndexableType>(
  table: Table<T, K>,
  plan: ReconcilePlan<T, K>,
  labels: { put: string; remove: string },
  progress: (count: number, label: string) => void,
  options: ReconcileV7ProjectionOptions,
  mode: ReconcileV7InstallMode,
): Promise<void> {
  const started = clockMs();
  for (let index = 0; index < plan.deletes.length; index += RECONCILE_BATCH_SIZE) {
    const chunk = plan.deletes.slice(index, index + RECONCILE_BATCH_SIZE);
    await table.bulkDelete(chunk);
    progress(chunk.length, labels.remove);
  }
  for (let index = 0; index < plan.puts.length; index += RECONCILE_BATCH_SIZE) {
    const chunk = plan.puts.slice(index, index + RECONCILE_BATCH_SIZE);
    await table.bulkPut(chunk);
    progress(chunk.length, labels.put);
  }
  emitTiming(options, mode, {
    phase: "write",
    table: table.name,
    durationMs: Math.max(0, clockMs() - started),
    scannedRows: 0,
    comparedRows: 0,
    putRows: plan.puts.length,
    deleteRows: plan.deletes.length,
  });
}

export async function reconcileV7Projection(
  state: V7RestoreState,
  options: ReconcileV7ProjectionOptions = {},
): Promise<boolean> {
  const fresh = await projectionIsEmpty();
  const mode: ReconcileV7InstallMode = fresh ? "fresh" : hasDirtyKeys(options.dirtyKeys) ? "dirty" : "full";
  options.onProgress?.({
    completed: 0,
    total: 1,
    label: mode === "fresh" ? "正在准备首次本机数据" : mode === "dirty" ? "正在准备本机增量" : "正在比较本机数据",
  });

  const makePlan = <T>(
    table: Table<T, string>,
    incoming: readonly T[],
    keyOf: (row: T) => string | undefined,
    dirtyKeys: readonly string[] | undefined,
  ) => mode === "full"
    ? planTableTimed(table, incoming, keyOf, options)
    : Promise.resolve(directPlanTimed(mode, table, incoming, keyOf, dirtyKeys, options));

  const compoundKeyFromSyncKey = (key: string): [string, string] => {
    const separator = key.indexOf(":");
    if (separator <= 0 || separator >= key.length - 1) throw new Error(`无效复合关系键：${key}`);
    return [key.slice(0, separator), key.slice(separator + 1)];
  };
  const makeCompoundPlan = async <T>(
    table: Table<T, [string, string]>,
    incoming: readonly T[],
    primaryKeyOf: (row: T) => [string, string],
    syncKeyOf: (row: T) => string,
    dirtyKeys: readonly string[] | undefined,
  ): Promise<ReconcilePlan<T, [string, string]>> => mode === "full"
    ? planCompoundTable(table, incoming, primaryKeyOf)
    : directCompoundPlan(mode, table, incoming, primaryKeyOf, syncKeyOf, dirtyKeys, compoundKeyFromSyncKey);

  const dirty = options.dirtyKeys;
  const bankPlan = await makePlan(dbV7.banks, state.banks, (row) => row.id, dirty?.banks);
  const folderPlan = await makePlan(dbV7.bankFolders, state.bankFolders, (row) => row.id, dirty?.bankFolders);
  const questionPlan = await makePlan(dbV7.questions, state.questions, (row) => row.id, dirty?.questions);
  const membershipPlan = await makeCompoundPlan(
    dbV7.bankQuestionMemberships,
    state.memberships,
    (row) => [row.bankId, row.questionId],
    (row) => row.key,
    dirty?.memberships,
  );
  const attemptPlan = await makePlan(dbV7.attempts, state.attempts, (row) => row.id, dirty?.attempts);
  const attemptStatsPlan = await makePlan(dbV7.questionProgress, state.attemptStats, (row) => row.questionId, dirty?.attemptStats);
  const dailyStatsPlan = await makeCompoundPlan(
    dbV7.questionDailyProgress,
    state.attemptDailyStats,
    (row) => [row.date, row.questionId],
    (row) => row.key,
    dirty?.attemptDailyStats,
  );
  const notePlan = await makePlan(dbV7.notes, state.notes, (row) => row.questionId, dirty?.notes);
  const practiceRunBundles = state.practiceRuns.map((run) => decomposePracticeRunV7(run, state.attempts));
  const practiceRunRecords = practiceRunBundles.map((bundle) => bundle.record);
  const practiceRunSources = practiceRunBundles.flatMap((bundle) => bundle.sources);
  const practiceRunItems = practiceRunBundles.flatMap((bundle) => bundle.items);
  const practiceRunPlan = await makePlan(dbV7.practiceRuns, practiceRunRecords, (row) => row.id, dirty?.practiceRuns);
  const makePracticeRelationPlan = async <T extends { runId: string }>(
    table: Table<T, [string, string]>,
    incoming: readonly T[],
    childId: (row: T) => string,
  ): Promise<ReconcilePlan<T, [string, string]>> => {
    const primaryKeyOf = (row: T): [string, string] => [row.runId, childId(row)];
    if (mode === "full") return planCompoundTable(table, incoming, primaryKeyOf);
    if (mode === "fresh") {
      return directCompoundPlan("fresh", table, incoming, primaryKeyOf, (row) => `${row.runId}:${childId(row)}`, undefined, compoundKeyFromSyncKey);
    }
    const dirtyRunIds = dirty?.practiceRuns ?? [];
    const dirtyRunSet = new Set(dirtyRunIds);
    const incomingRows = incoming.filter((row) => dirtyRunSet.has(row.runId));
    const currentRows = dirtyRunIds.length ? await table.where("runId").anyOf(dirtyRunIds).toArray() : [];
    const incomingByKey = new Map(incomingRows.map((row) => [keyIdentity(primaryKeyOf(row)), row]));
    const currentByKey = new Map(currentRows.map((row) => [keyIdentity(primaryKeyOf(row)), row]));
    return {
      puts: incomingRows.filter((row) => {
        const current = currentByKey.get(keyIdentity(primaryKeyOf(row)));
        return current === undefined || !equivalent(current, row);
      }),
      deletes: currentRows.filter((row) => !incomingByKey.has(keyIdentity(primaryKeyOf(row)))).map(primaryKeyOf),
      scannedRows: currentRows.length + incomingRows.length,
      comparedRows: incomingRows.length,
    };
  };
  const practiceRunSourcePlan = await makePracticeRelationPlan(dbV7.practiceRunSources, practiceRunSources, (row) => row.bankId);
  const practiceRunItemPlan = await makePracticeRelationPlan(dbV7.practiceRunItems, practiceRunItems, (row) => row.questionId);
  const bankPracticeStats = state.practiceRunStats.map((row) => ({
    bankId: row.bankId,
    total: row.total,
    completed: row.completed,
    inProgress: row.inProgress,
    abandoned: row.abandoned,
    latestActivityAt: row.latestUpdatedAt,
  }));
  const practiceStatsPlan = await makePlan(dbV7.bankPracticeStats, bankPracticeStats, (row) => row.bankId, dirty?.practiceRunStats);
  const questionGroupRecords = state.questionGroups.map(({ items: _items, ...group }) => group);
  const questionGroupItems = state.questionGroups.flatMap((group) => group.items.map((item, position) => ({
    groupId: group.id,
    questionId: item.questionId,
    position,
    ...(item.note ? { note: item.note } : {}),
  })));
  const groupPlan = await makePlan(dbV7.questionGroups, questionGroupRecords, (row) => row.id, dirty?.questionGroups);
  let groupItemPlan: ReconcilePlan<(typeof questionGroupItems)[number], [string, string]>;
  if (mode === "dirty") {
    const dirtyGroupIds = dirty?.questionGroups ?? [];
    const incomingItems = questionGroupItems.filter((item) => dirtyGroupIds.includes(item.groupId));
    const currentItems = dirtyGroupIds.length
      ? await dbV7.questionGroupItems.where("groupId").anyOf(dirtyGroupIds).toArray()
      : [];
    const incomingByKey = new Map(incomingItems.map((item) => [keyIdentity([item.groupId, item.questionId]), item]));
    const currentByKey = new Map(currentItems.map((item) => [keyIdentity([item.groupId, item.questionId]), item]));
    groupItemPlan = {
      puts: incomingItems.filter((item) => {
        const current = currentByKey.get(keyIdentity([item.groupId, item.questionId]));
        return current === undefined || !equivalent(current, item);
      }),
      deletes: currentItems
        .filter((item) => !incomingByKey.has(keyIdentity([item.groupId, item.questionId])))
        .map((item) => [item.groupId, item.questionId] as [string, string]),
      scannedRows: currentItems.length + incomingItems.length,
      comparedRows: incomingItems.length,
    };
  } else if (mode === "full") {
    groupItemPlan = await planCompoundTable(dbV7.questionGroupItems, questionGroupItems, (item) => [item.groupId, item.questionId]);
  } else {
    groupItemPlan = directCompoundPlan(
      "fresh",
      dbV7.questionGroupItems,
      questionGroupItems,
      (item) => [item.groupId, item.questionId],
      (item) => `${item.groupId}:${item.questionId}`,
      undefined,
      compoundKeyFromSyncKey,
    );
  }
  const reviewRoundRecords = state.reviewRounds.map(({ bankIds: _bankIds, finalQuestionIds: _finalQuestionIds, ...round }) => round);
  const reviewRoundBanks = state.reviewRounds.flatMap((round) => round.bankIds.map((bankId, position) => ({ roundId: round.id, bankId, position })));
  const reviewRoundItems = state.reviewRounds.flatMap((round) => (round.finalQuestionIds ?? []).map((questionId, position) => ({ roundId: round.id, questionId, position })));
  const roundPlan = await makePlan(dbV7.reviewRounds, reviewRoundRecords, (row) => row.id, dirty?.reviewRounds);
  const makeRoundRelationPlan = async <T extends { roundId: string }>(
    table: Table<T, [string, string]>,
    incoming: readonly T[],
    childId: (row: T) => string,
  ): Promise<ReconcilePlan<T, [string, string]>> => {
    const primaryKeyOf = (row: T): [string, string] => [row.roundId, childId(row)];
    if (mode === "full") return planCompoundTable(table, incoming, primaryKeyOf);
    if (mode === "fresh") {
      return directCompoundPlan("fresh", table, incoming, primaryKeyOf, (row) => `${row.roundId}:${childId(row)}`, undefined, compoundKeyFromSyncKey);
    }
    const dirtyRoundIds = dirty?.reviewRounds ?? [];
    const dirtyRoundSet = new Set(dirtyRoundIds);
    const incomingRows = incoming.filter((row) => dirtyRoundSet.has(row.roundId));
    const currentRows = dirtyRoundIds.length ? await table.where("roundId").anyOf(dirtyRoundIds).toArray() : [];
    const incomingByKey = new Map(incomingRows.map((row) => [keyIdentity(primaryKeyOf(row)), row]));
    const currentByKey = new Map(currentRows.map((row) => [keyIdentity(primaryKeyOf(row)), row]));
    return {
      puts: incomingRows.filter((row) => {
        const current = currentByKey.get(keyIdentity(primaryKeyOf(row)));
        return current === undefined || !equivalent(current, row);
      }),
      deletes: currentRows.filter((row) => !incomingByKey.has(keyIdentity(primaryKeyOf(row)))).map(primaryKeyOf),
      scannedRows: currentRows.length + incomingRows.length,
      comparedRows: incomingRows.length,
    };
  };
  const roundBankPlan = await makeRoundRelationPlan(dbV7.reviewRoundBanks, reviewRoundBanks, (row) => row.bankId);
  const roundItemPlan = await makeRoundRelationPlan(dbV7.reviewRoundItems, reviewRoundItems, (row) => row.questionId);
  const roundProgressPlan = await makeCompoundPlan(
    dbV7.reviewRoundProgress,
    state.reviewRoundProgress,
    (row) => [row.roundId, row.questionId],
    (row) => row.key,
    dirty?.reviewRoundProgress,
  );
  const tombstonePlan = await makePlan(dbV7.tombstones, state.tombstones, (row) => row.key, dirty?.tombstones);
  const imagePlan = mode === "full"
    ? await planImageAssetsTimed(state.imageAssets, options)
    : directImagePlanTimed(mode, state.imageAssets, dirty?.imageAssets, options);

  const rowOps =
    bankPlan.puts.length + bankPlan.deletes.length
    + folderPlan.puts.length + folderPlan.deletes.length
    + questionPlan.puts.length + questionPlan.deletes.length
    + membershipPlan.puts.length + membershipPlan.deletes.length
    + attemptPlan.puts.length + attemptPlan.deletes.length
    + attemptStatsPlan.puts.length + attemptStatsPlan.deletes.length
    + dailyStatsPlan.puts.length + dailyStatsPlan.deletes.length
    + notePlan.puts.length + notePlan.deletes.length
    + practiceRunPlan.puts.length + practiceRunPlan.deletes.length
    + practiceRunSourcePlan.puts.length + practiceRunSourcePlan.deletes.length
    + practiceRunItemPlan.puts.length + practiceRunItemPlan.deletes.length
    + practiceStatsPlan.puts.length + practiceStatsPlan.deletes.length
    + groupPlan.puts.length + groupPlan.deletes.length
    + groupItemPlan.puts.length + groupItemPlan.deletes.length
    + roundPlan.puts.length + roundPlan.deletes.length
    + roundBankPlan.puts.length + roundBankPlan.deletes.length
    + roundItemPlan.puts.length + roundItemPlan.deletes.length
    + roundProgressPlan.puts.length + roundProgressPlan.deletes.length
    + tombstonePlan.puts.length + tombstonePlan.deletes.length
    + imagePlan.deletes.length + imagePlan.updates.length + imagePlan.inserts.length;
  const totalOps = Math.max(1, rowOps);

  const transactionTables = [
    dbV7.banks, dbV7.bankFolders, dbV7.questions, dbV7.bankQuestionMemberships,
    dbV7.imageAssets, dbV7.imageBlobs, dbV7.attempts, dbV7.questionProgress, dbV7.questionDailyProgress,
    dbV7.notes, dbV7.practiceRuns, dbV7.practiceRunSources, dbV7.practiceRunItems, dbV7.bankPracticeStats, dbV7.questionGroups, dbV7.questionGroupItems,
    dbV7.reviewRounds, dbV7.reviewRoundBanks, dbV7.reviewRoundItems, dbV7.reviewRoundProgress, dbV7.tombstones, dbV7.changeSets,
  ];

  return dbV7.transaction("rw", transactionTables, async () => {
    const transaction = Dexie.currentTransaction;
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let completed = 0;

    const armWatchdog = () => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        try {
          if (transaction?.active) transaction.abort();
        } catch {
          // Transaction may have completed between timer firing and abort().
        }
      }, RECONCILE_STALL_TIMEOUT_MS);
    };
    const progress = (count: number, label: string) => {
      completed = Math.min(totalOps, completed + count);
      options.onProgress?.({ completed, total: totalOps, label });
      armWatchdog();
    };

    armWatchdog();
    try {
      if (options.queueGuard) {
        const current = await dbV7.changeSets.toArray();
        armWatchdog();
        if (!queueMatches(current, options.queueGuard)) return false;
      }
      if (mode === "fresh" && !await projectionIsEmpty()) return false;

      await applyPlan(dbV7.banks, bankPlan, { put: "更新题库", remove: "清理题库" }, progress, options, mode);
      await applyPlan(dbV7.bankFolders, folderPlan, { put: "更新文件夹", remove: "清理文件夹" }, progress, options, mode);
      await applyPlan(dbV7.questions, questionPlan, { put: "更新题目", remove: "清理题目" }, progress, options, mode);
      await applyPlan(dbV7.bankQuestionMemberships, membershipPlan, { put: "更新题库关系", remove: "清理题库关系" }, progress, options, mode);
      await applyPlan(dbV7.attempts, attemptPlan, { put: "更新作答记录", remove: "清理作答记录" }, progress, options, mode);
      await applyPlan(dbV7.questionProgress, attemptStatsPlan, { put: "更新学习统计", remove: "清理学习统计" }, progress, options, mode);
      await applyPlan(dbV7.questionDailyProgress, dailyStatsPlan, { put: "更新每日统计", remove: "清理每日统计" }, progress, options, mode);
      await applyPlan(dbV7.notes, notePlan, { put: "更新解析笔记", remove: "清理解析笔记" }, progress, options, mode);
      await applyPlan(dbV7.practiceRuns, practiceRunPlan, { put: "更新练习记录", remove: "清理练习记录" }, progress, options, mode);
      await applyPlan(dbV7.practiceRunSources, practiceRunSourcePlan, { put: "更新练习来源关系", remove: "清理练习来源关系" }, progress, options, mode);
      await applyPlan(dbV7.practiceRunItems, practiceRunItemPlan, { put: "更新练习题目关系", remove: "清理练习题目关系" }, progress, options, mode);
      await applyPlan(dbV7.bankPracticeStats, practiceStatsPlan, { put: "更新练习统计", remove: "清理练习统计" }, progress, options, mode);
      await applyPlan(dbV7.questionGroups, groupPlan, { put: "更新题组", remove: "清理题组" }, progress, options, mode);
      await applyPlan(dbV7.questionGroupItems, groupItemPlan, { put: "更新题组关系", remove: "清理题组关系" }, progress, options, mode);
      await applyPlan(dbV7.reviewRounds, roundPlan, { put: "更新复习轮次", remove: "清理复习轮次" }, progress, options, mode);
      await applyPlan(dbV7.reviewRoundBanks, roundBankPlan, { put: "更新复习轮次题库关系", remove: "清理复习轮次题库关系" }, progress, options, mode);
      await applyPlan(dbV7.reviewRoundItems, roundItemPlan, { put: "更新复习轮次题目关系", remove: "清理复习轮次题目关系" }, progress, options, mode);
      await applyPlan(dbV7.reviewRoundProgress, roundProgressPlan, { put: "更新轮次进度", remove: "清理轮次进度" }, progress, options, mode);
      await applyPlan(dbV7.tombstones, tombstonePlan, { put: "更新删除标记", remove: "清理删除标记" }, progress, options, mode);

      const imageWriteStarted = clockMs();
      for (let index = 0; index < imagePlan.deletes.length; index += RECONCILE_BATCH_SIZE) {
        const chunk = imagePlan.deletes.slice(index, index + RECONCILE_BATCH_SIZE);
        await dbV7.imageAssets.bulkDelete(chunk);
        await dbV7.imageBlobs.bulkDelete(chunk);
        progress(chunk.length, "清理图片索引");
      }
      if (mode === "dirty") {
        // Dirty descriptor writes never touch imageBlobs. Blob bytes are
        // device-local cache rows with an independent lifecycle.
        for (let index = 0; index < imagePlan.inserts.length; index += RECONCILE_BATCH_SIZE) {
          const chunk = imagePlan.inserts.slice(index, index + RECONCILE_BATCH_SIZE);
          await dbV7.imageAssets.bulkPut(chunk);
          progress(chunk.length, "更新图片索引");
        }
      } else {
        for (let index = 0; index < imagePlan.updates.length; index += RECONCILE_BATCH_SIZE) {
          const chunk = imagePlan.updates.slice(index, index + RECONCILE_BATCH_SIZE);
          await dbV7.imageAssets.bulkUpdate(chunk.map((asset) => ({
            key: asset.id,
            changes: { mimeType: asset.mimeType, size: asset.size, width: asset.width, height: asset.height },
          })));
          progress(chunk.length, "更新图片索引");
        }
        for (let index = 0; index < imagePlan.inserts.length; index += RECONCILE_BATCH_SIZE) {
          const chunk = imagePlan.inserts.slice(index, index + RECONCILE_BATCH_SIZE);
          await dbV7.imageAssets.bulkPut(chunk);
          progress(chunk.length, "写入图片索引");
        }
      }
      emitTiming(options, mode, {
        phase: "write",
        table: dbV7.imageAssets.name,
        durationMs: Math.max(0, clockMs() - imageWriteStarted),
        scannedRows: 0,
        comparedRows: 0,
        putRows: imagePlan.inserts.length + imagePlan.updates.length,
        deleteRows: imagePlan.deletes.length,
      });

      if (options.clearChangeSets) {
        await dbV7.changeSets.clear();
        armWatchdog();
      }
      options.onProgress?.({
        completed: totalOps,
        total: totalOps,
        label: rowOps
          ? mode === "fresh" ? "首次本机数据写入完成" : mode === "dirty" ? "本机增量更新完成" : "本机增量更新完成"
          : "本机数据无需改写",
      });
      return true;
    } catch (error) {
      if (stalled) throw new Error("本机数据库增量更新长时间无响应，已安全取消本次写入。请保持应用在前台后重试同步。");
      throw error;
    } finally {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
    }
  });
}
