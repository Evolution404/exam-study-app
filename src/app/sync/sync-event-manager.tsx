"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Clock3,
  FilePenLine,
  LoaderCircle,
  Search,
  Send,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { ConfirmDialog } from "@/app/ui/confirm-dialog";
import { AppSelect } from "@/app/ui/app-select";
import { Hint } from "@/app/ui/hint";
import type {
  ChangeSetMutationV7,
  ChangeSetV7,
  SyncPendingChangeEdit,
  SyncQueueItem,
} from "@/lib/sync/sync-application";
import "@/app/styles/sync-events-1.css";
import "@/app/styles/sync-events-2.css";

export type SyncChangeSetStateV7 = SyncQueueItem["state"];
export type SyncChangeSetItemV7 = SyncQueueItem;
export type SyncChangeSetTypedEditV7 = SyncPendingChangeEdit;

export interface SyncEventProgressV7 {
  label: string;
  percent: number;
}

export interface SyncEventManagerProps {
  items: readonly SyncChangeSetItemV7[];
  selectedId?: string;
  onSelectedIdChange?: (id: string | undefined) => void;
  onEdit?: (changeSetId: string, edit: SyncChangeSetTypedEditV7) => void | Promise<void>;
  onDelete?: (changeSetId: string, options: { cascadeDependents: boolean }) => void | Promise<void>;
  onSyncNow?: () => void | Promise<void>;
  progress?: SyncEventProgressV7;
  syncing?: boolean;
  busyChangeSetId?: string;
  showBatchSections?: boolean;
  emptyMessage?: string;
  className?: string;
  /** 渲染在工具栏正下方的状态面板（同步抽屉传入热窗口信息，与同步页一致）。 */
  statusPanel?: ReactNode;
}

const stateLabels: Record<SyncChangeSetStateV7, string> = {
  pending: "待同步",
  claimed: "正在写入",
  blocked: "需处理",
  committed: "已同步",
};

const kindLabels: Partial<Record<ChangeSetMutationV7["kind"], string>> = {
  "bank.create": "创建题库",
  "bank.update": "更新题库",
  "bank.reorder": "调整题库顺序",
  "bank.delete": "删除题库",
  "bank.delete.cascade": "级联删除题库",
  "bankFolder.save": "保存题库文件夹",
  "bankFolder.delete": "删除题库文件夹",
  "question.upsert": "保存题目",
  "question.delete": "删除题目",
  "question.delete.cascade": "级联删除题目",
  "question.split": "分裂共享题目",
  "question.import": "导入题目",
  "question.bulk.upsert": "批量保存题目",
  "question.bulk.delete": "批量删除题目",
  "membership.save": "加入题库",
  "membership.remove": "移出题库",
  "membership.bulk.save": "批量加入题库",
  "membership.bulk.remove": "批量移出题库",
  "image.asset.save": "保存图片",
  "image.asset.delete": "删除图片",
  "attempt.create": "新增作答",
  "attempt.update": "修改作答",
  "attempt.delete": "删除作答",
  "practice.answer.submitted": "提交练习答案",
  "practice.answer.updated": "修改练习答案",
  "practice.answer.deleted": "删除练习答案",
  "practice.run.saved": "保存练习",
  "practice.run.status.changed": "更新练习状态",
  "practice.run.deleted": "删除练习",
  "note.upserted": "保存个人解析",
  "note.deleted": "删除个人解析",
  "questionGroup.saved": "保存题组",
  "questionGroup.deleted": "删除题组",
  "review.round.saved": "保存复习轮次",
  "review.round.completed": "完成复习轮次",
  "review.round.archived": "归档复习轮次",
};

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString("zh-CN", { hour12: false }) : value;
}

function shortId(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function firstMutation(changeSet: ChangeSetV7): ChangeSetMutationV7 {
  return changeSet.mutations[0];
}

function mutationSummary(mutation: ChangeSetMutationV7): string {
  switch (mutation.kind) {
    case "bank.create": case "bank.update": return `${kindLabels[mutation.kind]}「${mutation.bank.displayName || mutation.bank.name}」`;
    case "bank.reorder": return `调整 ${mutation.bankIds.length} 个题库的顺序`;
    case "bankFolder.save": return `保存文件夹「${mutation.folder.name}」`;
    case "question.import": return `向「${mutation.bank.displayName || mutation.bank.name}」导入 ${mutation.questions.length} 道题`;
    case "question.bulk.upsert": return `批量保存 ${mutation.questions.length} 道题`;
    case "question.bulk.delete": return `批量删除 ${mutation.questionIds.length} 道题`;
    case "membership.bulk.save": return `批量加入 ${mutation.memberships.length} 条题库关系`;
    case "membership.bulk.remove": return `批量移除 ${mutation.keys.length} 条题库关系`;
    case "note.upserted": return `更新题目 ${shortId(mutation.note.questionId)} 的个人解析`;
    case "questionGroup.saved": return `保存题组「${mutation.group.name}」`;
    case "review.round.saved": case "review.round.completed": case "review.round.archived": return `${kindLabels[mutation.kind]}「${mutation.round.name}」`;
    default: return `${kindLabels[mutation.kind] ?? mutation.kind} · ${shortId(mutationEntityId(mutation) ?? mutation.kind)}`;
  }
}

function mutationEntityId(mutation: ChangeSetMutationV7): string | undefined {
  if ("questionId" in mutation) return mutation.questionId;
  if ("bankId" in mutation) return mutation.bankId;
  if ("runId" in mutation) return mutation.runId;
  if ("groupId" in mutation) return mutation.groupId;
  if ("folderId" in mutation) return mutation.folderId;
  if ("attemptId" in mutation) return mutation.attemptId;
  if ("assetId" in mutation) return mutation.assetId;
  return undefined;
}

function changeSetSummary(changeSet: ChangeSetV7): string {
  const first = mutationSummary(firstMutation(changeSet));
  return changeSet.mutations.length > 1 ? `${first}，另有 ${changeSet.mutations.length - 1} 项` : first;
}

function stateIcon(state: SyncChangeSetStateV7): ReactNode {
  if (state === "blocked") return <AlertCircle size={15} />;
  if (state === "committed") return <Check size={15} />;
  if (state === "claimed") return <ShieldAlert size={15} />;
  return <Clock3 size={15} />;
}

function editableMutation(mutation: ChangeSetMutationV7): boolean {
  return mutation.kind === "note.upserted" || mutation.kind === "bank.update" || mutation.kind === "question.upsert";
}

function changeSetMatches(item: SyncChangeSetItemV7, query: string): boolean {
  if (!query) return true;
  const haystack = [
    changeSetSummary(item.changeSet),
    item.changeSet.kind,
    item.changeSet.id,
    item.changeSet.deviceId,
    ...item.changeSet.entityRefs.flatMap((ref) => [ref.type, ref.id]),
    ...(item.blockers ?? []),
  ].join(" ").toLocaleLowerCase("zh-CN");
  return haystack.includes(query.toLocaleLowerCase("zh-CN"));
}

function TypedMutationEditor({
  item,
  mutation,
  mutationIndex,
  busy,
  onSave,
  onCancel,
}: {
  item: SyncChangeSetItemV7;
  mutation: ChangeSetMutationV7;
  mutationIndex: number;
  busy: boolean;
  onSave: (edit: SyncChangeSetTypedEditV7) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [noteContent, setNoteContent] = useState(mutation.kind === "note.upserted" ? mutation.note.content : "");
  const [bankName, setBankName] = useState(mutation.kind === "bank.update" ? mutation.bank.name : "");
  const [bankDisplayName, setBankDisplayName] = useState(mutation.kind === "bank.update" ? mutation.bank.displayName ?? "" : "");
  const [bankDescription, setBankDescription] = useState(mutation.kind === "bank.update" ? mutation.bank.description ?? "" : "");
  const [questionStem, setQuestionStem] = useState(mutation.kind === "question.upsert" ? mutation.question.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : "");
  const [questionAnswer, setQuestionAnswer] = useState(mutation.kind === "question.upsert" ? mutation.question.answer : "");
  const [questionTags, setQuestionTags] = useState(mutation.kind === "question.upsert" ? mutation.question.tags.join("，") : "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mutation.kind === "note.upserted") {
      await onSave({ kind: "note.upserted", mutationIndex, content: noteContent });
    } else if (mutation.kind === "bank.update") {
      await onSave({ kind: "bank.update", mutationIndex, name: bankName.trim(), displayName: bankDisplayName.trim(), description: bankDescription.trim() });
    } else if (mutation.kind === "question.upsert") {
      await onSave({ kind: "question.upsert", mutationIndex, stem: questionStem, answer: questionAnswer.trim(), tags: questionTags.split(/[，,、\n]+/).map((tag) => tag.trim()).filter(Boolean) });
    }
  }

  return <form className="sync-event-editor" onSubmit={(event) => void submit(event)} aria-label={`编辑 ${changeSetSummary(item.changeSet)}`}>
    {mutation.kind === "note.upserted" && <label>个人解析<textarea value={noteContent} onChange={(event) => setNoteContent(event.target.value)} rows={6} /></label>}
    {mutation.kind === "bank.update" && <>
      <label>题库名称<input required value={bankName} onChange={(event) => setBankName(event.target.value)} /></label>
      <label>显示名称<input value={bankDisplayName} onChange={(event) => setBankDisplayName(event.target.value)} /></label>
      <label>说明<textarea value={bankDescription} onChange={(event) => setBankDescription(event.target.value)} rows={3} /></label>
    </>}
    {mutation.kind === "question.upsert" && <>
      <label>题干文字<textarea required value={questionStem} onChange={(event) => setQuestionStem(event.target.value)} rows={5} /></label>
      {mutation.question.type === "计算"
        ? <label>各空答案（每行一个）<textarea required value={questionAnswer} onChange={(event) => setQuestionAnswer(event.target.value)} rows={Math.max(2, questionAnswer.split("\n").length)} /></label>
        : <label>答案<input required value={questionAnswer} onChange={(event) => setQuestionAnswer(event.target.value)} /></label>}
      <label>标签<input value={questionTags} onChange={(event) => setQuestionTags(event.target.value)} placeholder="多个标签用逗号分隔" /></label>
      <p className="sync-event-editor-note">这里只修改简化文字字段；图片和公式块保持不变，由业务层重新生成 change-set 摘要。</p>
    </>}
    <div className="sync-event-editor-actions">
      <button type="button" disabled={busy} onClick={onCancel}>取消</button>
      <button className="primary" type="submit" disabled={busy}>{busy && <LoaderCircle className="spin" size={16} />}保存修改</button>
    </div>
  </form>;
}

export function SyncEventManager({
  items,
  selectedId: controlledSelectedId,
  onSelectedIdChange,
  onEdit,
  onDelete,
  onSyncNow,
  progress,
  syncing = false,
  busyChangeSetId,
  showBatchSections = false,
  emptyMessage = "还没有符合条件的同步操作。",
  className = "",
  statusPanel,
}: SyncEventManagerProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | SyncChangeSetStateV7>("all");
  const [internalSelectedId, setInternalSelectedId] = useState<string>();
  const [editing, setEditing] = useState<{ changeSetId: string; mutationIndex: number }>();
  const [deleteTarget, setDeleteTarget] = useState<SyncChangeSetItemV7>();
  const [cascadeDependents, setCascadeDependents] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const selectionIsControlled = Boolean(onSelectedIdChange);
  const requestedSelectedId = selectionIsControlled ? controlledSelectedId : internalSelectedId;
  const selectedId = requestedSelectedId && items.some((item) => item.changeSet.id === requestedSelectedId) ? requestedSelectedId : undefined;

  const filtered = useMemo(() => items.filter((item) => (status === "all" || item.state === status) && changeSetMatches(item, query.trim())), [items, query, status]);
  const syncingItems = filtered.filter((item) => item.state === "claimed");
  const pendingItems = filtered.filter((item) => item.state === "pending" || item.state === "blocked");
  const committedItems = filtered.filter((item) => item.state === "committed");
  const showHistory = historyExpanded || status !== "all" || query.trim() !== "";
  function select(id: string) {
    const next = selectedId === id ? undefined : id;
    if (!selectionIsControlled) setInternalSelectedId(next);
    onSelectedIdChange?.(next);
    setEditing(undefined);
  }

  async function confirmDelete() {
    if (!deleteTarget || !onDelete) return;
    try {
      setDeleteError(undefined);
      await onDelete(deleteTarget.changeSet.id, { cascadeDependents });
      setDeleteTarget(undefined);
      setCascadeDependents(false);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "删除失败，请重试。");
    }
  }

  function renderItem(item: SyncChangeSetItemV7) {
    const { changeSet } = item;
    const open = selectedId === changeSet.id;
    const busy = busyChangeSetId === changeSet.id;
    const canEdit = (item.state === "pending" || item.state === "blocked") && item.editable !== false && changeSet.mutations.some(editableMutation) && Boolean(onEdit);
    const canDelete = (item.state === "pending" || item.state === "blocked") && item.cancellable !== false && Boolean(onDelete);
    return <article className={`sync-event-item state-${item.state}`} key={changeSet.id}>
      <div className="sync-event-item-main">
        <button className="sync-event-summary" type="button" aria-expanded={open} aria-controls={`sync-event-detail-${changeSet.id}`} onClick={() => select(changeSet.id)}>
          <span className={`sync-event-state state-${item.state}`}>{stateIcon(item.state)}{stateLabels[item.state]}</span>
          <span className="sync-event-copy"><strong>{changeSetSummary(changeSet)}</strong><small>{formatDate(changeSet.createdAt)} · {changeSet.mutations.length} 项变更</small></span>
          <ChevronDown className={open ? "expanded" : ""} size={17} aria-hidden="true" />
        </button>
        <div className="sync-event-row-actions">
          {canEdit && <button type="button" aria-label={`编辑 ${changeSetSummary(changeSet)}`} onClick={() => { select(changeSet.id); setEditing({ changeSetId: changeSet.id, mutationIndex: changeSet.mutations.findIndex(editableMutation) }); }}><FilePenLine size={16} /></button>}
          {canDelete && <button className="danger-quiet" type="button" aria-label={`删除整组 ${changeSetSummary(changeSet)}`} onClick={() => { setDeleteTarget(item); setCascadeDependents(false); setDeleteError(undefined); }}><Trash2 size={16} /></button>}
        </div>
      </div>
      {open && <div className="sync-event-detail" id={`sync-event-detail-${changeSet.id}`}>
        {item.statusMessage && <p className="sync-event-status-message">{item.statusMessage}</p>}
        {item.blockers?.length ? <div className="sync-event-blockers" role="status"><strong><AlertCircle size={16} />暂时不能同步</strong><ul>{item.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div> : null}
        <dl className="sync-event-metadata">
          <div><dt>操作编号</dt><Hint label={changeSet.id}><dd>{shortId(changeSet.id)}</dd></Hint></div>
          <div><dt>设备</dt><Hint label={changeSet.deviceId}><dd>{shortId(changeSet.deviceId)}</dd></Hint></div>
          <div><dt>本地顺序</dt><dd>{changeSet.localSequence.toLocaleString("zh-CN")}</dd></div>
          <div><dt>校验摘要</dt><Hint label={changeSet.digest}><dd>{shortId(changeSet.digest)}</dd></Hint></div>
        </dl>
        <div className="sync-event-mutations" aria-label="变更明细">
          {changeSet.mutations.map((mutation, index) => <section key={`${mutation.kind}-${index}`}>
            <div><span>{index + 1}</span><div><strong>{kindLabels[mutation.kind] ?? mutation.kind}</strong><p>{mutationSummary(mutation)}</p></div></div>
            {item.state !== "committed" && item.state !== "claimed" && item.editable !== false && editableMutation(mutation) && onEdit && editing?.changeSetId !== changeSet.id && <button type="button" onClick={() => setEditing({ changeSetId: changeSet.id, mutationIndex: index })}>编辑业务字段</button>}
            {editing?.changeSetId === changeSet.id && editing.mutationIndex === index && <TypedMutationEditor item={item} mutation={mutation} mutationIndex={index} busy={busy} onCancel={() => setEditing(undefined)} onSave={async (edit) => { await onEdit?.(changeSet.id, edit); setEditing(undefined); }} />}
          </section>)}
        </div>
        <div className="sync-event-refs"><strong>涉及对象</strong><div>{changeSet.entityRefs.map((ref) => <Hint label={ref.id} key={`${ref.type}:${ref.id}`}><span>{ref.type} · {shortId(ref.id)}</span></Hint>)}</div></div>
      </div>}
    </article>;
  }

  return <section className={`sync-event-manager ${className}`.trim()} aria-label="同步操作管理">
    <div className="sync-event-toolbar">
      <label className="sync-event-search"><Search size={17} /><span className="sr-only">搜索同步操作</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索类型、对象或编号" /></label>
      <AppSelect className="sync-event-filter" ariaLabel="按状态筛选" value={status} onValueChange={(value) => setStatus(value as typeof status)} options={[{ value: "all", label: "全部状态" }, ...Object.entries(stateLabels).map(([value, label]) => ({ value, label }))]} />
      <div className="sync-event-manager-actions">
        {onSyncNow && <button className="primary" type="button" disabled={syncing || !items.some((item) => item.state === "pending" || item.state === "claimed")} onClick={() => void onSyncNow()}>{syncing ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}{syncing ? "同步中" : "立即同步"}</button>}
      </div>
    </div>

    {statusPanel}

    {progress && <div className="sync-event-progress" role="progressbar" aria-label={progress.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><span><strong>{progress.label}</strong><em>{progress.percent}%</em></span><i aria-hidden="true"><b style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} /></i></div>}

    <div className="sync-event-list" aria-live="polite">
      {showBatchSections ? <>
        {syncingItems.length > 0 && (
          <section className="sync-event-batch" aria-labelledby="sync-syncing-title">
            <header><div><span>上传中</span><h3 id="sync-syncing-title">正在同步</h3></div><b>{syncingItems.length}</b></header>
            <div className="sync-event-batch-items">{syncingItems.map(renderItem)}</div>
          </section>
        )}
        <section className="sync-event-batch" aria-labelledby="sync-pending-title">
          <header><div><span>待办</span><h3 id="sync-pending-title">等待同步</h3></div><b>{pendingItems.length}</b></header>
          <div className="sync-event-batch-items">{pendingItems.length ? pendingItems.map(renderItem) : <p className="sync-event-empty">没有待同步的操作。</p>}</div>
        </section>
        {committedItems.length > 0 && (
          <section className={`sync-event-batch is-history${showHistory ? "" : " collapsed"}`} aria-labelledby="sync-history-title">
            <header>
              <div><span>历史</span><h3 id="sync-history-title">已同步</h3></div>
              <button type="button" className="sync-event-history-toggle" aria-expanded={showHistory} onClick={() => setHistoryExpanded((value) => !value)}>
                <b>{committedItems.length}</b>
                <ChevronDown className={showHistory ? "expanded" : ""} size={15} aria-hidden="true" />
              </button>
            </header>
            {showHistory && <div className="sync-event-batch-items">{committedItems.map(renderItem)}</div>}
          </section>
        )}
      </> : filtered.length ? filtered.map(renderItem) : <p className="sync-event-empty">{emptyMessage}</p>}
    </div>

    <ConfirmDialog
      open={Boolean(deleteTarget)}
      eyebrow="删除暂存操作"
      title="删除整个 change-set？"
      tone="danger"
      busy={Boolean(deleteTarget && busyChangeSetId === deleteTarget.changeSet.id)}
      confirmLabel="删除整组"
      onCancel={() => { setDeleteTarget(undefined); setCascadeDependents(false); setDeleteError(undefined); }}
      onConfirm={() => void confirmDelete()}
      error={deleteError}
      description={deleteTarget ? <><strong>{changeSetSummary(deleteTarget.changeSet)}</strong><span>删除后，上层数据服务会从安全基线重建本地投影；不会只移除其中一条变更。</span>{deleteTarget.dependentChangeSetIds?.length ? <label className="sync-event-cascade"><input type="checkbox" checked={cascadeDependents} onChange={(event) => setCascadeDependents(event.target.checked)} />同时删除依赖它的 {deleteTarget.dependentChangeSetIds.length} 组操作</label> : null}</> : null}
    />
  </section>;
}
