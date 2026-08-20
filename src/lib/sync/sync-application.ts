import { dbV7 } from "../db/db-v7";
import { questionContentFingerprint } from "../question/question-content";
import type { GitHubSettings } from "../../types/types";
import {
  getGitHubLogin,
  getLastRemoteCache,
  getSyncHotWindowState,
  pullFromGitHub,
  restoreFullHistoryFromGitHub,
  restoreLastRemoteCache,
  syncWithGitHub,
  type SyncHotWindowState,
  type SyncProgress,
  type SyncProgressCallback,
} from "./github-sync";
import {
  loadGitHubSettings,
  loadGitHubToken,
  saveGitHubSettings,
  saveGitHubToken,
} from "./github-credentials";
import {
  dependentChangeSetIdsV7,
  type ChangeSetMutationV7,
  type ChangeSetV7,
} from "./change-set-v7";
import {
  discardManagedChangeSetV7,
  ensureChangeSetQueueBaseV7,
  reviseManagedChangeSetV7,
} from "./change-set-v7-queue";

export type { ChangeSetMutationV7, ChangeSetV7, SyncHotWindowState, SyncProgress };
export type { SyncProgressCallback };

export type SyncChangeSetState = "pending" | "claimed" | "blocked" | "committed";

export interface SyncQueueItem {
  changeSet: ChangeSetV7;
  state: SyncChangeSetState;
  blockers?: readonly string[];
  dependentChangeSetIds?: readonly string[];
  editable?: boolean;
  cancellable?: boolean;
  statusMessage?: string;
}

export type SyncPendingChangeEdit =
  | { kind: "note.upserted"; mutationIndex: number; content: string }
  | { kind: "bank.update"; mutationIndex: number; name: string; displayName: string; description: string }
  | { kind: "question.upsert"; mutationIndex: number; stem: string; answer: string; tags: string[] };

export interface SyncConnectionState {
  settings: GitHubSettings;
  token: string;
  ready: boolean;
}

export type SyncRunResult = Awaited<ReturnType<typeof syncWithGitHub>>;
export type SyncRestoreResult = Awaited<ReturnType<typeof restoreFullHistoryFromGitHub>>;
export type SyncCacheRestoreResult = Awaited<ReturnType<typeof restoreLastRemoteCache>>;

function queueItemFor(record: ChangeSetV7 & { state: SyncChangeSetState; blockedReason?: string }, manageable: readonly (ChangeSetV7 & { state: SyncChangeSetState })[]): SyncQueueItem {
  return {
    changeSet: record,
    state: record.state,
    blockers: record.blockedReason ? [record.blockedReason] : undefined,
    dependentChangeSetIds: dependentChangeSetIdsV7(record, manageable),
    editable: record.state === "pending" || record.state === "blocked",
    cancellable: record.state === "pending" || record.state === "blocked",
  };
}

class SyncApplication {
  getConnection(): SyncConnectionState {
    const settings = loadGitHubSettings();
    const token = loadGitHubToken();
    return { settings, token, ready: Boolean(settings.repo && token) };
  }

  saveSettings(settings: GitHubSettings): void {
    saveGitHubSettings(settings);
  }

  saveToken(token: string): void {
    saveGitHubToken(token);
  }

  async resolveConnection(settings = loadGitHubSettings(), token = loadGitHubToken()): Promise<{ settings: GitHubSettings; token: string }> {
    if (!settings.repo || !token) throw new Error("请先在配置页面填写 GitHub 令牌和仓库信息");
    const resolved = settings.owner ? settings : { ...settings, owner: await getGitHubLogin(token) };
    saveGitHubSettings(resolved);
    saveGitHubToken(token);
    return { settings: resolved, token };
  }

  async syncNow(callback?: SyncProgressCallback): Promise<SyncRunResult> {
    const { settings, token } = await this.resolveConnection();
    return syncWithGitHub(settings, token, callback);
  }

  async pullNow(callback?: SyncProgressCallback): Promise<SyncRunResult> {
    const { settings, token } = await this.resolveConnection();
    return pullFromGitHub(settings, token, callback);
  }

  async restoreRemote(callback?: SyncProgressCallback): Promise<SyncRestoreResult> {
    const { settings, token } = await this.resolveConnection();
    return restoreFullHistoryFromGitHub(settings, token, callback);
  }

  restoreCache(settings = loadGitHubSettings(), callback?: SyncProgressCallback): Promise<SyncCacheRestoreResult> {
    return restoreLastRemoteCache(settings, callback);
  }

  getLastRemoteCache(settings = loadGitHubSettings()) {
    return settings.owner && settings.repo ? getLastRemoteCache(settings) : Promise.resolve(null);
  }

  getHotWindow(settings = loadGitHubSettings()): Promise<SyncHotWindowState | null> {
    return settings.owner && settings.repo ? getSyncHotWindowState(settings) : Promise.resolve(null);
  }

  ensureQueueBase(): Promise<void> {
    return ensureChangeSetQueueBaseV7();
  }

  pendingCount(): Promise<number> {
    return dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).count();
  }

  async listQueueItems(limit = 500): Promise<SyncQueueItem[]> {
    const records = await dbV7.changeSets.orderBy("createdAt").reverse().limit(limit).toArray();
    const manageable = records.filter((record) => record.state === "pending" || record.state === "blocked");
    return records.map((record) => queueItemFor(record, manageable));
  }

  async editPendingChange(id: string, edit: SyncPendingChangeEdit): Promise<void> {
    const current = await dbV7.changeSets.get(id);
    if (!current || (current.state !== "pending" && current.state !== "blocked")) {
      throw new Error("该变更已进入同步流程，不能继续修改。");
    }
    const mutations = current.mutations.map((mutation, index): ChangeSetMutationV7 => {
      if (index !== edit.mutationIndex || mutation.kind !== edit.kind) return mutation;
      if (edit.kind === "note.upserted" && mutation.kind === "note.upserted") {
        return { ...mutation, note: { ...mutation.note, content: edit.content, revision: mutation.note.revision + 1, updatedAt: new Date().toISOString() } };
      }
      if (edit.kind === "bank.update" && mutation.kind === "bank.update") {
        return { ...mutation, bank: { ...mutation.bank, name: edit.name.trim() || mutation.bank.name, displayName: edit.displayName.trim() || undefined, description: edit.description.trim() || undefined, updatedAt: new Date().toISOString() } };
      }
      if (edit.kind === "question.upsert" && mutation.kind === "question.upsert") {
        let insertedText = false;
        const content: typeof mutation.question.content = [];
        for (const block of mutation.question.content) {
          if (block.type !== "text") content.push(block);
          else if (!insertedText) {
            content.push({ ...block, text: edit.stem });
            insertedText = true;
          }
        }
        if (!insertedText) content.unshift({ id: "stem-0", type: "text", text: edit.stem });
        const question = { ...mutation.question, answer: edit.answer, tags: edit.tags, content, updatedAt: new Date().toISOString() };
        return { ...mutation, question: { ...question, contentFingerprint: questionContentFingerprint(question) } };
      }
      return mutation;
    });
    await reviseManagedChangeSetV7(id, mutations);
  }

  discardPendingChange(id: string, options: { cascadeDependents: boolean }): Promise<void> {
    return discardManagedChangeSetV7(id, options);
  }
}

export const syncApplication = new SyncApplication();
