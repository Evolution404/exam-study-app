import {
  claimPendingChangeSetsV7,
  blockChangeSetSnapshotV7,
  commitChangeSetClaimV7,
  dbV7,
  discardPendingChangeSetV7,
  getV7DeviceId,
  listChangeSetsV7,
  releaseChangeSetClaimV7,
  type ChangeSetQueueRecordV7,
} from "../db/db-v7";
import type { GitHubSettings } from "../../types/types";
import { applyChangeSetToOwnedProjectionV7, finalizeRebasedProjectionV7, type ChangeSetProjectionV7 } from "./change-set-v7-projection";
import {
  bandPercent,
  cursorsFor,
  descriptorPath,
  monotonicProgress,
  remote,
  report,
  sha256,
  syncBands,
  type SyncProgressCallback,
  type SyncWithGitHubOptions,
} from "./sync-v7-context";
import {
  loadHeadCache,
  loadInstalledCursors,
  loadInstalledHead,
  loadRemoteCache,
  saveHeadCache,
  saveInstalledCursors,
  saveInstalledHead,
  saveRemoteCache,
} from "./sync-v7-cache";
import { maybeCoalesceHotWindow } from "./sync-v7-coalesce";
import { gcSyncV7Remote } from "./sync-v7-gc";
import { downloadRemoteV7 } from "./sync-v7-download";
import { deriveDirtyInstallKeysV7 } from "./sync-v7-dirty-install";
import {
  checkpointFromProjection,
  installProjection,
  projectionFromCheckpoint,
  replayInWireOrder,
  replayRemoteResilient,
  saveQueueBase,
} from "./sync-v7-checkpoint-bridge";
import type { SyncCheckpointV7 } from "./sync-v7-checkpoint-types";
import { withSyncLock } from "./sync-lock";
import { createRemoteCheckpointV8, encodeSyncCheckpointV8, gcSyncV8HistoryRemote } from "./sync-v8-history";
import { SYNC_V9_CHECKPOINT_PREFIX, SYNC_V9_SEGMENT_PREFIX, type SyncHeadV7, type SyncV7PublicationFile, type SyncV7SegmentDescriptor } from "./sync-v7-head-types";
import { createSyncV7PublicationPlan, encodeSyncV7Segment, mergeSyncV7Segments, paginateSyncV7Events, planSyncV7Compaction } from "./sync-v7-head-operations";
import { offloadSyncV7Events } from "./sync-v7-payload";
import { installFingerprint, projectionNeedsInstall, pruneCommittedChangeSets, publishDeviceWatermark } from "./sync-v7-watermark";
import { SYNC_V7_ASSET_UPLOAD_CONCURRENCY, uploadedDescriptor, uploadPendingImageAssetsV7 } from "./sync-v7-upload";
import { changeSetOutsideHistoryRange, filterProjectionHistoryV7, historySyncStartFor } from "./history-sync-range";
import { assetUploadProgressLabelV7, formatTransferBytesV7, mergeActiveHistoryProjectionV7, reconcileInterruptedClaimsV7 } from "./sync-v7-orchestrator-model";
import { initializeSyncV7Remote } from "./sync-v7-bootstrap";
import { restoreFullHistoryFromGitHub } from "./sync-v7-restore";

/** Yield one macrotask so input events and rendering can interleave with the
 *  rebase loop (auto-sync used to run pending-count × full-dataset clone +
 *  derive in one long task and visibly freeze the UI mid-practice).  Returns
 *  whether a real macrotask boundary happened — hidden pages skip it because
 *  there is nothing to keep responsive. */
function yieldToMainIfVisible(): Promise<boolean> {
  if (typeof document === "undefined" || document.visibilityState !== "visible") return Promise.resolve(false);
  return new Promise<boolean>((resolve) => window.setTimeout(() => resolve(true), 0));
}

async function syncWithGitHubInternal(settings: GitHubSettings, token: string, callback?: SyncProgressCallback, options?: SyncWithGitHubOptions) {
  const client = remote(settings, token, options?.fetch, options?.transport);
  const historySyncStart = historySyncStartFor(settings);
  const progress = monotonicProgress(callback);
  report(progress, "prepare", "正在连接远端", 2, 6);
  let read = await client.readHead(await loadHeadCache(settings));
  if (!read.initialized) { await initializeSyncV7Remote(settings, token, progress, options); read = await client.readHead(); }
  if (!read.initialized) throw new Error("无法初始化 v9 远端。当前客户端只支持 v9 远端数据。");
  let installedHead = await loadInstalledHead(settings);
  let pulled = 0;
  let receivedSnapshot: SyncCheckpointV7["counts"] | undefined;
  // Band layout is decided once per run from whether there is anything to push,
  // so the bar spans 0–100 over the phases this run will actually enter.
  // Image uploads can add a pending change-set during upload, so the
  // variable must be able to switch to the push layout below.
  let bands = syncBands((await listChangeSetsV7(["pending"])).length > 0);
  for (let retry = 0; retry < 4; retry += 1) {
    const cached = await loadRemoteCache(settings);
    report(progress, "download", cached ? "正在检查 v9 热窗口增量" : "正在下载远端完整数据", bandPercent(bands.download, cached ? 0.05 : 0.01), bands.download[1]);
    let downloadSteps = 0;
    const downloaded = await downloadRemoteV7(client, read.head, cached, (fraction, label) => {
      downloadSteps += 1;
      report(progress, "download", label, bandPercent(bands.download, fraction), bands.download[1]);
    }, { historySyncStart });
    if (!downloadSteps) report(progress, "download", "热窗口没有新数据", bands.download[1], bands.download[1]);
    const remoteReplay = replayRemoteResilient(await projectionFromCheckpoint(downloaded.checkpoint), downloaded.changes, (done, total) => report(progress, "merge", `正在回放远端变更（${done}/${total}）`, bandPercent(bands.merge, total ? done / total / 2 : 1), bands.merge[1]));
    let remoteProjection = filterProjectionHistoryV7(remoteReplay.projection, historySyncStart);
    if (historySyncStart) {
      const activeRuns = await dbV7.practiceRuns.where("status").equals("in_progress").toArray();
      if (activeRuns.length) {
        const activeIds = activeRuns.map((run) => run.id);
        const activeAttempts = await dbV7.attempts.where("runId").anyOf(activeIds).toArray();
        remoteProjection = filterProjectionHistoryV7(mergeActiveHistoryProjectionV7(remoteProjection, activeRuns, activeAttempts), historySyncStart);
      }
    }
    if (remoteReplay.skipped.length) report(progress, "merge", `已跳过 ${remoteReplay.skipped.length} 组与已删数据冲突的远端变更`, bandPercent(bands.merge, 0.5), bands.merge[1]);
    const interruptedClaims = reconcileInterruptedClaimsV7(await listChangeSetsV7(["claimed"]), downloaded.changes, read.head.cursors);
    if (interruptedClaims.length) await dbV7.changeSets.bulkPut(interruptedClaims);
    // Dedup by cursor watermark instead of by committed-record id: a change whose
    // localSequence the installed cursor already covers has been applied before,
    // even if its local committed record was garbage-collected.
    const installedCursors = await loadInstalledCursors(settings);
    const unseen = downloaded.changes.filter((change) => change.localSequence > (installedCursors[change.deviceId] ?? 0));
    let rebasedProjection = remoteProjection;
    // Upload local image blobs BEFORE rebasing local pending change-sets, so
    // question.upsert / question.import events that reference those assets can
    // be applied to the in-memory projection instead of being marked blocked.
    const uploadedImageAssets = await uploadPendingImageAssetsV7(client, ({ completed, total, uploadedBytes, totalBytes }) => {
      if (!bands.upload) bands = syncBands(true);
      const label = assetUploadProgressLabelV7({ completed, total, uploadedBytes, totalBytes, concurrency: SYNC_V7_ASSET_UPLOAD_CONCURRENCY });
      const fraction = total ? completed / total : 0;
      report(progress, "upload", label, bandPercent(bands.upload!, 0.02 + 0.16 * fraction), bandPercent(bands.upload!, 0.18));
    });
    if (uploadedImageAssets.length) {
      if (!bands.upload) bands = syncBands(true);
      for (const descriptor of uploadedImageAssets) {
        const index = rebasedProjection.imageAssets.findIndex((asset) => asset.id === descriptor.id);
        if (index >= 0) rebasedProjection.imageAssets[index] = descriptor;
        else rebasedProjection.imageAssets.push(descriptor);
      }
      const uploadedBytes = uploadedImageAssets.reduce((sum, asset) => sum + asset.size, 0);
      report(progress, "upload", `图片上传完成（${uploadedImageAssets.length}/${uploadedImageAssets.length}，${formatTransferBytesV7(uploadedBytes)}）`, bandPercent(bands.upload!, 0.18), bandPercent(bands.upload!, 0.2));
    }
    // Keep a complete queue snapshot for the projection install guard.  A new
    // local edit must either commit after the guarded install or make this
    // attempt retry; otherwise restoreV7Checkpoint could erase its projection.
    let queueSnapshot = await listChangeSetsV7();
    const excludedHistory = queueSnapshot.filter((record) => record.state === "pending" && changeSetOutsideHistoryRange(record, historySyncStart));
    if (excludedHistory.length) {
      await Promise.all(excludedHistory.map((record) => discardPendingChangeSetV7(record.id)));
      queueSnapshot = await listChangeSetsV7();
      report(progress, "merge", `已按同步时间起点忽略 ${excludedHistory.length} 组本机旧历史`, bandPercent(bands.merge, 0.48), bands.merge[1]);
    }
    const localPending = queueSnapshot.filter((record) => record.state === "pending");
    const blocked: ChangeSetQueueRecordV7[] = [];
    if (localPending.length) {
      const localEvery = Math.max(1, Math.floor(localPending.length / 12));
      // 每条变更集只做一次浅信封应用，派生表与校验在循环后统一跑一次——
      // 旧实现每条记录全量克隆 15 张表并全量派生/校验，是自动同步卡界面的主因。
      let yieldedToMain = false;
      for (let localIndex = 0; localIndex < localPending.length; localIndex += 1) {
        const record = localPending[localIndex];
        try {
          rebasedProjection = applyChangeSetToOwnedProjectionV7(rebasedProjection, record);
        } catch (error) {
          blocked.push({
            ...record,
            state: "blocked",
            blockedReason: error instanceof Error ? error.message : "该操作无法应用到最新远端数据。",
          });
        }
        if ((localIndex + 1) % localEvery === 0 || localIndex + 1 === localPending.length) {
          report(progress, "merge", `正在归并本机待上传变更（${localIndex + 1}/${localPending.length}）`, bandPercent(bands.merge, 0.5 + 0.5 * (localIndex + 1) / localPending.length), bands.merge[1]);
        }
        yieldedToMain = (await yieldToMainIfVisible()) || yieldedToMain;
      }
      if (yieldedToMain) {
        // 让出期间用户可在同步抽屉丢弃/修改待同步项；被丢弃的记录已进本投影但
        // 不会上传，若照常写入 committed 基线会污染队列基线。校验快照仍逐一以
        // 相同 digest 待同步，否则整轮重试（外层上限 4 次）。新到的记录忽略——
        // 与无让出时的表现一致。
        const currentPending = await listChangeSetsV7(["pending"]);
        const currentById = new Map(currentPending.map((record) => [record.id, record]));
        const snapshotChanged = localPending.some((record) => currentById.get(record.id)?.digest !== record.digest);
        if (snapshotChanged) continue;
      }
      rebasedProjection = filterProjectionHistoryV7(finalizeRebasedProjectionV7(rebasedProjection), historySyncStart);
    }
    const firstProjectionInstall = !installedHead;
    const needsInstall = !downloaded.reusedCache || projectionNeedsInstall(installedHead, read.cache, unseen.length, blocked.length);
    // Dirty install is only valid when the current local projection is known to
    // match the SAME folded remote cache that downloadRemoteV7 reused. This
    // excludes fresh installs, checkpoint compaction/identity changes, cache
    // misses and history-range changes. Unsupported reducer cascades also return
    // null from the derivation helper and deliberately fall back to full reconcile.
    const dirtyBaseMatches = Boolean(
      needsInstall
      && installedHead
      && cached
      && downloaded.reusedCache
      && excludedHistory.length === 0
      && installedHead === installFingerprint(cached.head)
    );
    const dirtyKeys = dirtyBaseMatches
      ? await deriveDirtyInstallKeysV7(rebasedProjection, [...unseen, ...localPending])
      : null;
    if (needsInstall) {
      report(
        progress,
        "merge",
        dirtyKeys
          ? `正在应用本机增量（${unseen.length + localPending.length} 组变更）`
          : `正在比较本机数据（远端 ${rebasedProjection.questions.length.toLocaleString("zh-CN")} 道题、${rebasedProjection.attempts.length.toLocaleString("zh-CN")} 条作答）`,
        bandPercent(bands.install, 0.02),
        bands.install[1],
      );
      const installed = await installProjection(rebasedProjection, {
        queueGuard: queueSnapshot,
        ...(dirtyKeys ? { dirtyKeys } : {}),
        onProgress: ({ completed, total, label }) => {
          const fraction = total ? completed / total : 1;
          report(progress, "merge", `${label}（${completed.toLocaleString("zh-CN")}/${total.toLocaleString("zh-CN")}）`, bandPercent(bands.install, fraction), bands.install[1]);
        },
      });
      if (!installed) continue;
      report(progress, "merge", "本机数据已更新", bandPercent(bands.install, 1), bands.install[1]);
      installedHead = installFingerprint(read.cache);
      await saveInstalledHead(settings, installedHead);
      if (firstProjectionInstall || !downloaded.reusedCache) receivedSnapshot = downloaded.checkpoint.counts;
      if (blocked.length) await blockChangeSetSnapshotV7(blocked);
      await dbV7.changeSets.bulkPut(unseen.map((change) => ({ ...change, state: "committed" as const, committedAt: new Date().toISOString() })));
      pulled += unseen.length;
    }
    if (!needsInstall && !unseen.length) report(progress, "merge", "远端与本机已一致，无需合并", bands.merge[1], bands.merge[1]);
    // Rebase and the queue claim must describe the same digest.  A pending
    // record edited while the projection was being rebuilt invalidates the
    // in-memory projection; retry instead of publishing a stale queue base.
    const currentPending = await listChangeSetsV7(["pending"]);
    const pendingChanged = localPending.some((record) => currentPending.find((current) => current.id === record.id)?.digest !== record.digest);
    if (pendingChanged) continue;
    const claim = await claimPendingChangeSetsV7(localPending);
    if (claim.records.length !== localPending.length) {
      if (claim.records.length) await releaseChangeSetClaimV7(claim.claimId);
      continue;
    }
    if (!claim.records.length) {
      report(progress, "cache", "正在更新本机缓存", bandPercent(bands.cache, 0.4), bands.cache[1]);
      await saveHeadCache(settings, read.cache);
      await saveRemoteCache(settings, await checkpointFromProjection(remoteProjection, read.head.cursors), read.cache);
      await saveQueueBase(remoteProjection);
      const remaining = (await listChangeSetsV7(["blocked"])).length;
      report(progress, "complete", remaining ? `同步完成，${remaining} 组操作需要处理` : "云端和本机已经一致", 100);
      await saveInstalledHead(settings, installFingerprint(read.cache));
      await saveInstalledCursors(settings, read.head.cursors);
      // H2：游标前进才写设备水位（空闲同步零 head 写入）；冲突静默跳过。
      // 必须先于 prune：prune 清空队列会让同步页的 changeSets 查询触发面板刷新，
      // 此时本地 head 缓存必须已带上最新水位/代数，否则面板读到旧缓存而不过期。
      try { await publishDeviceWatermark(client, settings, getV7DeviceId(), read.head.cursors); } catch { /* best-effort */ }
      await pruneCommittedChangeSets(read.head.cursors);
      return { pulled, pushed: 0, remaining, deferred: 0, formatVersion: 9 as const, compacted: false, coalesced: false, receivedSnapshot };
    }
    try {
      report(progress, "upload", `正在上传 ${claim.records.length} 组变更`, bandPercent(bands.upload!, 0.2), bandPercent(bands.upload!, 0.24));
      const generation = read.head.generation + 1;
      const baseOrdinal = read.head.segments.filter((item) => item.generation === generation).length;
      const now = new Date().toISOString();
      const events = claim.records.map((record) => ({ formatVersion: record.formatVersion, id: record.id, deviceId: record.deviceId, localSequence: record.localSequence, createdAt: record.createdAt, kind: record.kind, mutations: record.mutations, entityRefs: record.entityRefs, payloadRefs: record.payloadRefs, digest: record.digest }));
      const aggregateCursors = cursorsFor(claim.records);
      // A single change-set (a large import, a big practice run) can exceed the
      // 256 KiB inline-event ceiling. Offload any oversized body to a
      // content-addressed immutable object and leave a thin stub in its place;
      // the object files are published alongside the segments in the same plan.
      report(progress, "upload", `正在整理 ${events.length} 组变更`, bandPercent(bands.upload!, 0.24), bandPercent(bands.upload!, 0.28));
      const offloaded = await offloadSyncV7Events(events);
      if (offloaded.objects.length) report(progress, "upload", `已卸载 ${offloaded.objects.length} 个大对象`, bandPercent(bands.upload!, 0.28), bandPercent(bands.upload!, 0.3));
      const objectFiles: SyncV7PublicationFile[] = offloaded.objects;
      // Paginate the (now stub-slender) events into one or more 1 MiB segments
      // that share one generation and publish together.
      const pages = paginateSyncV7Events(offloaded.events);
      // Decide compaction from the PROJECTED byte total (existing + new) BEFORE
      // uploading or merging. Previously the merge guard threw at > 4 MiB before
      // compaction could run, so an overflow push failed ("compact explicitly
      // first") instead of snapshotting — the documented "hot window fills →
      // checkpoint" behaviour was unreachable. Under compaction the new events
      // fold into the checkpoint and the hot window clears, so the new segments
      // are neither uploaded nor referenced (no orphaned immutables).
      const existingHotBytes = read.head.segments.reduce((sum, item) => sum + item.size, 0);
      const projectedHotBytes = existingHotBytes + pages.reduce((sum, page) => sum + page.size, 0);
      const compaction = planSyncV7Compaction({ head: read.head, hotBytes: projectedHotBytes });
      const newSegments: SyncV7SegmentDescriptor[] = [];
      const segmentFiles: SyncV7PublicationFile[] = [];
      const vault = read.head.vaultId;
      const uploadNewSegments = async (): Promise<void> => {
        for (let index = 0; index < pages.length; index += 1) {
          const page = pages[index];
          const ordinal = baseOrdinal + index;
          const metadata = { vaultId: vault, createdAt: now, producer: "exam-study-app" };
          // Page-local coverage cursors (see maybeCoalesceHotWindow): lets a peer
          // skip this page when its events are below the peer's cached watermark.
          const pageCursors = cursorsFor(page.events as Array<{ deviceId: string; localSequence: number }>);
          const segmentBytes = encodeSyncV7Segment({ formatVersion: 9 as const, vaultId: vault, generation, ordinal, metadata, cursors: pageCursors, events: page.events });
          const segmentDigest = await sha256(segmentBytes);
          const segmentPath = descriptorPath(SYNC_V9_SEGMENT_PREFIX, segmentDigest);
          const segmentBase = await uploadedDescriptor(client, segmentPath, segmentBytes, "segment");
          newSegments.push({ ...segmentBase, generation, ordinal, count: page.events.length, cursors: pageCursors, metadata });
          segmentFiles.push({ path: segmentPath, bytes: segmentBytes, kind: "segment", uploaded: true });
          report(progress, "upload", `正在上传分段（${index + 1}/${pages.length}）`, bandPercent(bands.upload!, 0.3 + 0.4 * (index + 1) / pages.length), bandPercent(bands.upload!, 0.7));
        }
      };
      if (!compaction.required) await uploadNewSegments();
      let checkpointFile: { path: string; bytes: Uint8Array; kind: "checkpoint"; uploaded: true } | undefined;
      let checkpointDescriptor = read.head.checkpoint;
      let nextSegments: SyncV7SegmentDescriptor[];
      if (compaction.required) {
        // B3: compacting replays the claimed records in wire order. A single
        // poisoned record (e.g. an upsert rejected by a tombstone that only
        // surfaces under wire-order rather than createdAt-order replay) would
        // previously abort the whole sync. Fall back to ordinary segment push
        // instead of crashing — the events still publish, just uncompressed.
        let compactionProjection: ChangeSetProjectionV7 | undefined;
        try {
          let compactionBase = remoteProjection;
          if (historySyncStart) {
            report(progress, "compact", "正在读取完整远端历史以安全压实", bandPercent(bands.upload!, 0.42), bandPercent(bands.upload!, 0.62));
            const complete = await downloadRemoteV7(client, read.head, undefined, undefined, {});
            compactionBase = replayRemoteResilient(await projectionFromCheckpoint(complete.checkpoint), complete.changes).projection;
          }
          compactionProjection = replayInWireOrder(compactionBase, claim.records);
        } catch (error) {
          report(progress, "compact", `压实重放失败，退回分段推送：${error instanceof Error ? error.message : String(error)}`, bandPercent(bands.upload!, 0.45), bandPercent(bands.upload!, 0.7));
        }
        if (!compactionProjection) {
          await uploadNewSegments();
          nextSegments = mergeSyncV7Segments(read.head.segments, newSegments, read.head.vaultId);
        } else {
          report(progress, "compact", read.head.checkpoint ? "热窗口超过 4 MiB，正在生成检查点" : "正在生成初始检查点", bandPercent(bands.upload!, 0.5), bandPercent(bands.upload!, 0.7));
          const fullCheckpoint = await checkpointFromProjection(compactionProjection, { ...read.head.cursors, ...aggregateCursors }, { tombstoneGc: { devices: read.head.devices ?? {}, headCursors: { ...read.head.cursors, ...aggregateCursors }, selfDeviceId: getV7DeviceId() } });
          const checkpoint = await createRemoteCheckpointV8(client, fullCheckpoint);
          const bytes = encodeSyncCheckpointV8(checkpoint);
          const digest = await sha256(bytes);
          const path = descriptorPath(SYNC_V9_CHECKPOINT_PREFIX, digest);
          const uploaded = await uploadedDescriptor(client, path, bytes, "checkpoint");
          checkpointFile = { path, bytes, kind: "checkpoint", uploaded: true };
          checkpointDescriptor = { ...uploaded, generation };
          nextSegments = [];
        }
      } else {
        // Safe: projectedHotBytes <= 4 MiB here, so the merge guard cannot trip.
        nextSegments = mergeSyncV7Segments(read.head.segments, newSegments, read.head.vaultId);
      }
      const nextHead: SyncHeadV7 = { ...read.head, generatedAt: now, generation, checkpoint: checkpointDescriptor, segments: nextSegments, cursors: { ...read.head.cursors, ...aggregateCursors } };
      const plan = createSyncV7PublicationPlan({ expectedHead: read.head, expectedHeadSha: read.cache.blobSha, head: nextHead, segments: segmentFiles, ...(objectFiles.length ? { objects: objectFiles } : {}), ...(checkpointFile ? { checkpoint: checkpointFile, compaction } : {}) });
      report(progress, "upload", "正在发布新版索引", bandPercent(bands.upload!, 0.72), bandPercent(bands.upload!, 0.8));
      const committed = await client.publish(plan);
      if (committed.ok) report(progress, "upload", "远端已接受本次变更", bandPercent(bands.upload!, 0.8), bandPercent(bands.upload!, 0.88));
      if (!committed.ok) { await releaseChangeSetClaimV7(claim.claimId); read = await client.readHead(); if (!read.initialized) throw new Error("v9 远端索引丢失。"); continue; }
      await commitChangeSetClaimV7(claim.claimId, new Map(claim.records.map((record) => [record.id, record.digest])));
      // B3: reuse the already-validated rebasedProjection (createdAt order) rather
      // than re-replaying claim.records in wire/claim order — a tombstone-sensitive
      // mutation pair would throw here (rejectTombstoned) after the push already
      // committed, leaving the local queue-base stale and the sync in an error state.
      const committedProjection = rebasedProjection;
      report(progress, "cache", "正在更新本机缓存", bandPercent(bands.upload!, 0.86), bands.cache[1]);
      await saveQueueBase(committedProjection);
      await saveHeadCache(settings, committed.cache);
      await saveRemoteCache(settings, await checkpointFromProjection(committedProjection, nextHead.cursors), committed.cache);
      await saveInstalledHead(settings, installFingerprint(committed.cache));
      await saveInstalledCursors(settings, nextHead.cursors);
      // The head CAS is durable before any deletion. Sweep only files unreachable
      // from the current/previous head; failures are maintenance-only.
      try { await gcSyncV7Remote(client, read.head, committed.cache, { checkpointChanged: compaction.required }); } catch { /* best-effort */ }
      if (compaction.required) {
        try { await gcSyncV8HistoryRemote(client, read.head, committed.cache); } catch { /* best-effort */ }
      }
      // The push is already durable. Coalescing is a best-effort maintenance write
      // (re-packs many small segments into fewer); isolate its failures so a
      // transient error never reverts the committed change-sets above.
      let coalesced = false;
      try {
        const replacement = await maybeCoalesceHotWindow(client, committed.cache, callback);
        if (replacement) {
          await saveHeadCache(settings, replacement);
          await saveInstalledHead(settings, installFingerprint(replacement));
          coalesced = true;
        }
      } catch { /* best-effort: a later sync will retry coalescing */ }
      // 同拉取路径：水位（含本地 head 缓存保存）必须先于 prune，否则 changeSets
      // 查询触发的同步页刷新读到旧缓存。
      try { await publishDeviceWatermark(client, settings, getV7DeviceId(), nextHead.cursors); } catch { /* best-effort */ }
      await pruneCommittedChangeSets(nextHead.cursors);
      const remaining = (await listChangeSetsV7(["pending", "blocked"])).length;
      report(progress, "complete", "同步完成", 100);
      return { pulled, pushed: claim.records.length, remaining, deferred: 0, formatVersion: 9 as const, compacted: compaction.required, coalesced, receivedSnapshot };
    } catch (error) { await releaseChangeSetClaimV7(claim.claimId); throw error; }
  }
  throw new Error("远端持续发生并发更新，本地变更已保留，请稍后重试。");
}

// B5: coalesce all in-realm callers of syncWithGitHub. Manual sync, auto-sync,
// quick-sync and loadAttemptHistory all funnel here; withSyncLock additionally
// serializes pull/restore and extends the critical section across tabs/workers
// whenever Web Locks are available.
let syncInFlight: ReturnType<typeof syncWithGitHubInternal> | null = null;
export async function syncWithGitHub(settings: GitHubSettings, token: string, callback?: SyncProgressCallback, options?: SyncWithGitHubOptions) {
  if (syncInFlight) return syncInFlight;
  syncInFlight = withSyncLock(() => syncWithGitHubInternal(settings, token, callback, options));
  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

export { restoreFullHistoryFromGitHub };

export const restoreFromGitHub = restoreFullHistoryFromGitHub;
export const pullFromGitHub = async (settings: GitHubSettings, token: string, callback?: SyncProgressCallback, options?: SyncWithGitHubOptions) => syncWithGitHub(settings, token, callback, options);
export const initializeGitHubVault = (settings: GitHubSettings, token: string, callback?: SyncProgressCallback, fetchImpl?: SyncWithGitHubOptions["fetch"], transport?: SyncWithGitHubOptions["transport"]) => withSyncLock(() => initializeSyncV7Remote(settings, token, callback, { ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(transport ? { transport } : {}) }));

export async function loadAttemptHistory(settings: GitHubSettings, token: string, options: { month?: string; questionId?: string } = {}, syncOptions?: SyncWithGitHubOptions) { await syncWithGitHub(settings, token, undefined, syncOptions); const rows = (await dbV7.attempts.toArray()).filter((attempt) => (!options.questionId || attempt.questionId === options.questionId) && (!options.month || attempt.createdAt.startsWith(options.month))); return { loaded: rows.length, segments: 0 }; }