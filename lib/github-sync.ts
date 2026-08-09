import {
  applyRemoteEvents,
  applySyncSnapshot,
  createSyncSnapshot,
  db,
  getDeviceId,
  resetLocalDatabase,
  validateSyncSnapshot,
} from "./db";
import type { GitHubSettings, SyncEvent, SyncManifestV2, SyncSnapshotV2 } from "./types";

const api = "https://api.github.com";
const manifestPath = "sync/manifest.json";
const uploadBatchSize = 100;
const downloadConcurrency = 4;
const compactionFileThreshold = 120;

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

interface DownloadedEventFile {
  path: string;
  sha: string;
  events: SyncEvent[];
}

interface RemotePackage {
  formatVersion: 2;
  manifest: SyncManifestV2;
  manifestSha: string;
  snapshot?: SyncSnapshotV2;
  snapshotPath: string;
  snapshotSha: string;
  eventFiles: DownloadedEventFile[];
}

function headers(token: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function encodeBase64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

function decodeBase64(value: string) {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function request<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...headers(token), ...(init?.headers ?? {}) } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub ${response.status}: ${body.slice(0, 180)}`);
  }
  return response.json() as Promise<T>;
}

function contentUrl(settings: GitHubSettings, path: string) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${api}/repos/${settings.owner}/${settings.repo}/contents/${encodedPath}`;
}

async function readBlob(settings: GitHubSettings, token: string, sha: string) {
  const file = await request<{ content: string }>(`${api}/repos/${settings.owner}/${settings.repo}/git/blobs/${sha}`, token);
  return decodeBase64(file.content);
}

async function getTree(settings: GitHubSettings, token: string) {
  const branch = settings.branch || "main";
  const tree = await request<{ tree: TreeEntry[]; truncated?: boolean }>(
    `${api}/repos/${settings.owner}/${settings.repo}/git/trees/${branch}?recursive=1`,
    token,
  );
  if (tree.truncated) throw new Error("远程仓库文件树过大，GitHub 返回了不完整结果，已停止同步。");
  return tree.tree;
}

function validateEvents(value: unknown, path: string): SyncEvent[] {
  if (!Array.isArray(value)) throw new Error(`远程事件文件格式无效：${path}`);
  for (const event of value) {
    if (!event || typeof event !== "object" || typeof event.id !== "string" || typeof event.type !== "string"
      || typeof event.createdAt !== "string" || typeof event.deviceId !== "string") {
      throw new Error(`远程事件文件包含无效记录：${path}`);
    }
  }
  return value as SyncEvent[];
}

async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function downloadRemotePackage(settings: GitHubSettings, token: string, onlyUnseen = false): Promise<RemotePackage | null> {
  const tree = await getTree(settings, token);
  const manifestEntry = tree.find((entry) => entry.type === "blob" && entry.path === manifestPath);
  if (!manifestEntry) {
    if (tree.some((entry) => entry.type === "blob" && /^events\/.+\.json$/.test(entry.path))) {
      throw new Error("远程仓库仍是旧版同步格式，当前客户端仅支持 v2 资料库。");
    }
    return null;
  }
  {
    const manifestText = await readBlob(settings, token, manifestEntry.sha);
    const manifest = JSON.parse(manifestText) as SyncManifestV2;
    if (manifest.formatVersion !== 2 || !manifest.snapshot?.path || !manifest.snapshot.sha256 || !manifest.eventPrefix) {
      throw new Error("远程同步清单格式无效。");
    }
    const snapshotEntry = tree.find((entry) => entry.type === "blob" && entry.path === manifest.snapshot.path);
    if (!snapshotEntry) throw new Error("远程同步清单指向的快照不存在。");
    let snapshot: SyncSnapshotV2 | undefined;
    const seenSnapshot = onlyUnseen ? await db.syncFiles.get(snapshotEntry.path) : undefined;
    if (!seenSnapshot || seenSnapshot.sha !== snapshotEntry.sha) {
      const snapshotText = await readBlob(settings, token, snapshotEntry.sha);
      if (await sha256(snapshotText) !== manifest.snapshot.sha256) throw new Error("远程快照校验失败，已停止同步。");
      const parsed = JSON.parse(snapshotText) as unknown;
      validateSyncSnapshot(parsed);
      snapshot = parsed;
    }
    const eventEntries = tree.filter((entry) => entry.type === "blob" && entry.path.startsWith(manifest.eventPrefix) && entry.path.endsWith(".json"));
    const wantedEntries: TreeEntry[] = [];
    for (const entry of eventEntries) {
      const seen = onlyUnseen ? await db.syncFiles.get(entry.path) : undefined;
      if (!seen || seen.sha !== entry.sha) wantedEntries.push(entry);
    }
    const eventFiles = await mapConcurrent(wantedEntries, downloadConcurrency, async (entry) => ({
      path: entry.path,
      sha: entry.sha,
      events: validateEvents(JSON.parse(await readBlob(settings, token, entry.sha)), entry.path),
    }));
    return {
      formatVersion: 2, manifest, manifestSha: manifestEntry.sha, snapshot,
      snapshotPath: snapshotEntry.path, snapshotSha: snapshotEntry.sha, eventFiles,
    };
  }

}

async function initializeGitHubVault(settings: GitHubSettings, token: string) {
  const branch = settings.branch || "main";
  const snapshot = await createSyncSnapshot();
  const snapshotText = JSON.stringify(snapshot);
  const snapshotPath = `snapshots/v2/${snapshot.generatedAt.replace(/[:.]/g, "-")}-${crypto.randomUUID()}.json`;
  const manifest: SyncManifestV2 = {
    formatVersion: 2,
    generatedAt: snapshot.generatedAt,
    snapshot: { path: snapshotPath, sha256: await sha256(snapshotText) },
    eventPrefix: "events/v2/",
  };
  for (const [path, content, message] of [
    [snapshotPath, snapshotText, "sync: initialize v2 snapshot"],
    [manifestPath, JSON.stringify(manifest, null, 2), "sync: initialize v2 manifest"],
  ] as const) {
    await request(contentUrl(settings, path), token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, content: encodeBase64(content), branch }),
    });
  }
  return manifest;
}

async function applyPackage(remote: RemotePackage, replace = false) {
  let pulled = 0;
  if (remote.snapshot) {
    await applySyncSnapshot(remote.snapshot, replace);
    pulled += Object.values(remote.snapshot.counts).reduce((sum, count) => sum + count, 0);
    if (remote.snapshotPath && remote.snapshotSha) {
      await db.syncFiles.put({ path: remote.snapshotPath, sha: remote.snapshotSha, appliedAt: new Date().toISOString() });
    }
  }
  const events = remote.eventFiles.flatMap((file) => file.events);
  if (events.length) await applyRemoteEvents(events);
  for (const file of remote.eventFiles) {
    await db.syncFiles.put({ path: file.path, sha: file.sha, appliedAt: new Date().toISOString() });
    pulled += file.events.length;
  }
  if (remote.manifestSha) await db.syncFiles.put({ path: manifestPath, sha: remote.manifestSha, appliedAt: new Date().toISOString() });
  return pulled;
}

async function uploadPendingEvents(settings: GitHubSettings, token: string) {
  const branch = settings.branch || "main";
  let pushed = 0;
  for (;;) {
    const pending = await db.events.where("synced").equals(0).limit(uploadBatchSize).toArray();
    if (!pending.length) break;
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const path = `events/v2/${getDeviceId()}/${month}/${now.getTime()}-${crypto.randomUUID()}.json`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await request(contentUrl(settings, path), token, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: `sync: ${pending.length} study events`,
            content: encodeBase64(JSON.stringify(pending)),
            branch,
          }),
        });
        await db.events.bulkPut(pending.map((event) => ({ ...event, synced: 1 as const })));
        pushed += pending.length;
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
    if (lastError) throw lastError;
  }
  return pushed;
}

async function createGitBlob(settings: GitHubSettings, token: string, content: string) {
  const blob = await request<{ sha: string }>(`${api}/repos/${settings.owner}/${settings.repo}/git/blobs`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, encoding: "utf-8" }),
  });
  return blob.sha;
}

async function compactGitHubVaultIfNeeded(settings: GitHubSettings, token: string) {
  const firstTree = await getTree(settings, token);
  if (firstTree.filter((entry) => entry.type === "blob" && entry.path.startsWith("events/v2/") && entry.path.endsWith(".json")).length < compactionFileThreshold) {
    return { compacted: false, pulled: 0 };
  }

  const catchUp = await downloadRemotePackage(settings, token, true);
  if (!catchUp) return { compacted: false, pulled: 0 };
  const pulled = await applyPackage(catchUp);
  if (await db.events.where("synced").equals(0).count()) return { compacted: false, pulled };

  const branch = settings.branch || "main";
  const ref = await request<{ object: { sha: string } }>(`${api}/repos/${settings.owner}/${settings.repo}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  const commit = await request<{ tree: { sha: string } }>(`${api}/repos/${settings.owner}/${settings.repo}/git/commits/${ref.object.sha}`, token);
  const tree = await request<{ tree: TreeEntry[]; truncated?: boolean }>(`${api}/repos/${settings.owner}/${settings.repo}/git/trees/${commit.tree.sha}?recursive=1`, token);
  if (tree.truncated) return { compacted: false, pulled };
  const eventEntries = tree.tree.filter((entry) => entry.type === "blob" && entry.path.startsWith("events/v2/") && entry.path.endsWith(".json"));
  for (const entry of eventEntries) {
    if ((await db.syncFiles.get(entry.path))?.sha !== entry.sha) return { compacted: false, pulled };
  }

  const snapshot = await createSyncSnapshot();
  const snapshotText = JSON.stringify(snapshot);
  const safeTimestamp = snapshot.generatedAt.replace(/[:.]/g, "-");
  const snapshotPath = `snapshots/v2/${safeTimestamp}.json`;
  const previousSnapshotPath = catchUp.manifest?.snapshot.path;
  const manifest: SyncManifestV2 = {
    formatVersion: 2,
    generatedAt: snapshot.generatedAt,
    snapshot: { path: snapshotPath, sha256: await sha256(snapshotText) },
    eventPrefix: "events/v2/",
  };
  const [snapshotBlob, manifestBlob] = await Promise.all([
    createGitBlob(settings, token, snapshotText),
    createGitBlob(settings, token, JSON.stringify(manifest, null, 2)),
  ]);
  const newTree = await request<{ sha: string }>(`${api}/repos/${settings.owner}/${settings.repo}/git/trees`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_tree: commit.tree.sha,
      tree: [
        { path: snapshotPath, mode: "100644", type: "blob", sha: snapshotBlob },
        { path: manifestPath, mode: "100644", type: "blob", sha: manifestBlob },
        ...(previousSnapshotPath && previousSnapshotPath !== snapshotPath && tree.tree.some((entry) => entry.path === previousSnapshotPath)
          ? [{ path: previousSnapshotPath, mode: "100644", type: "blob", sha: null }]
          : []),
        ...eventEntries.map((entry) => ({ path: entry.path, mode: "100644", type: "blob", sha: null })),
      ],
    }),
  });
  const newCommit = await request<{ sha: string }>(`${api}/repos/${settings.owner}/${settings.repo}/git/commits`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: `sync: compact ${eventEntries.length} event files`, tree: newTree.sha, parents: [ref.object.sha] }),
  });
  try {
    await request(`${api}/repos/${settings.owner}/${settings.repo}/git/refs/heads/${encodeURIComponent(branch)}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: newCommit.sha, force: false }),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("GitHub 422")) return { compacted: false, pulled };
    throw error;
  }
  await db.syncFiles.bulkDelete(eventEntries.map((entry) => entry.path));
  if (previousSnapshotPath && previousSnapshotPath !== snapshotPath) await db.syncFiles.delete(previousSnapshotPath);
  await db.syncFiles.bulkPut([
    { path: snapshotPath, sha: snapshotBlob, appliedAt: new Date().toISOString() },
    { path: manifestPath, sha: manifestBlob, appliedAt: new Date().toISOString() },
  ]);
  return { compacted: true, pulled };
}

export async function getGitHubLogin(token: string) {
  const user = await request<{ login: string }>(`${api}/user`, token);
  return user.login;
}

export async function verifyGitHubVault(settings: GitHubSettings, token: string) {
  const tree = await getTree(settings, token);
  return Number(tree.some((entry) => entry.type === "blob" && entry.path === manifestPath));
}

export async function syncWithGitHub(settings: GitHubSettings, token: string) {
  const remote = await downloadRemotePackage(settings, token, true);
  if (!remote) await initializeGitHubVault(settings, token);
  let pulled = remote ? await applyPackage(remote) : 0;
  const pushed = await uploadPendingEvents(settings, token);
  const compaction = await compactGitHubVaultIfNeeded(settings, token);
  pulled += compaction.pulled;
  const remaining = await db.events.where("synced").equals(0).count();
  return { pulled, pushed, remaining, formatVersion: 2 as const, compacted: compaction.compacted };
}

export async function restoreFromGitHub(settings: GitHubSettings, token: string) {
  const remote = await downloadRemotePackage(settings, token, false);
  if (!remote || (!remote.snapshot && !remote.eventFiles.length)) throw new Error("远程仓库中没有可恢复的同步记录，已保留本地数据。");
  const backup = {
    snapshot: await createSyncSnapshot(),
    sessions: await db.sessions.toArray(),
    events: await db.events.toArray(),
    syncFiles: await db.syncFiles.toArray(),
  };
  try {
    await resetLocalDatabase();
    const pulled = await applyPackage(remote, Boolean(remote.snapshot));
    const snapshot = await createSyncSnapshot();
    validateSyncSnapshot(snapshot);
    return { pulled, formatVersion: remote.formatVersion, counts: snapshot.counts };
  } catch (error) {
    await resetLocalDatabase();
    await applySyncSnapshot(backup.snapshot, true);
    await db.sessions.bulkPut(backup.sessions);
    await db.events.bulkPut(backup.events);
    await db.syncFiles.bulkPut(backup.syncFiles);
    throw error;
  }
}
