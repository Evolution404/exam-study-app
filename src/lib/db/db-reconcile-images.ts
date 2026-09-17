import { studyDb, type RestoreState } from "./db-core";

export interface ImageReconcilePlan {
  updates: RestoreState["imageAssets"];
  inserts: RestoreState["imageAssets"];
  deletes: string[];
  scannedRows: number;
  comparedRows: number;
}

const IMAGE_PLAN_READ_BATCH_SIZE = 500;

function sameDescriptor(
  left: RestoreState["imageAssets"][number],
  right: RestoreState["imageAssets"][number],
): boolean {
  return left.id === right.id
    && left.mimeType === right.mimeType
    && left.size === right.size
    && left.width === right.width
    && left.height === right.height;
}

export function directImagePlan(
  mode: "fresh" | "dirty",
  incoming: RestoreState["imageAssets"],
  dirtyKeys: readonly string[] | undefined,
): ImageReconcilePlan {
  const wanted = mode === "dirty" ? new Set(dirtyKeys ?? []) : undefined;
  const found = new Set<string>();
  const inserts: RestoreState["imageAssets"] = [];
  for (const asset of incoming) {
    if (wanted && !wanted.has(asset.id)) continue;
    if (found.has(asset.id)) throw new Error(`远端 imageAssets 存在重复主键 ${asset.id}，无法安全${mode === "fresh" ? "首次安装" : "脏键同步"}。`);
    found.add(asset.id);
    inserts.push(asset);
  }
  return {
    updates: [],
    inserts,
    deletes: mode === "dirty" ? [...wanted!].filter((id) => !found.has(id)) : [],
    scannedRows: 0,
    comparedRows: 0,
  };
}

export async function planImageAssets(incoming: RestoreState["imageAssets"]): Promise<ImageReconcilePlan> {
  const rawCurrentKeys = await studyDb.imageAssets.toCollection().primaryKeys();
  const currentKeys = rawCurrentKeys.map((key) => {
    if (typeof key !== "string") throw new Error("本机 imageAssets 存在非字符串主键，无法安全增量同步。");
    return key;
  });
  const currentIds = new Set(currentKeys);
  const incomingIds = new Set<string>();
  const updates: RestoreState["imageAssets"] = [];
  const inserts: RestoreState["imageAssets"] = [];
  const existing: RestoreState["imageAssets"] = [];
  for (const asset of incoming) {
    if (incomingIds.has(asset.id)) throw new Error(`远端 imageAssets 存在重复主键 ${asset.id}，无法安全增量同步。`);
    incomingIds.add(asset.id);
    if (currentIds.has(asset.id)) existing.push(asset);
    else inserts.push(asset);
  }
  for (let index = 0; index < existing.length; index += IMAGE_PLAN_READ_BATCH_SIZE) {
    const rows = existing.slice(index, index + IMAGE_PLAN_READ_BATCH_SIZE);
    const current = await studyDb.imageAssets.bulkGet(rows.map((asset) => asset.id));
    for (let offset = 0; offset < rows.length; offset += 1) {
      const old = current[offset];
      if (!old) inserts.push(rows[offset]);
      else if (!sameDescriptor(old, rows[offset])) updates.push(rows[offset]);
    }
  }
  return {
    updates,
    inserts,
    deletes: currentKeys.filter((id) => !incomingIds.has(id)),
    scannedRows: currentKeys.length + existing.length,
    comparedRows: existing.length,
  };
}
