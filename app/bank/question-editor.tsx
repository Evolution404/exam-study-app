import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Plus, Save, Trash2, X } from "lucide-react";
import type { ContentBlock, QuestionV6, QuestionTypeV6 } from "@/lib/db/v6-types";
import type { GitHubSettings } from "@/lib/db/types";
import type { QuestionDraftV6 } from "@/lib/db/db-v6";
import { dbV6 } from "@/lib/db/db-v6";
import { deriveContentText, plainTextToContentBlocks } from "@/lib/question/question-content";
import { optimizeImageFile } from "@/lib/io/image-assets";
import { getImageAssetBlobV6, putImageAssetV6, saveNoteV6, splitQuestionV6, updateQuestionV6 } from "@/lib/db/db-v6";
import { getQuestionViewV6, type QuestionViewV6 } from "@/lib/db/app-data-v6";
import { loadGitHubSettings, loadGitHubToken } from "@/lib/sync/github-credentials";
import { ModalPortal } from "@/app/ui/modal-portal";
import { AppSelect } from "@/app/ui/app-select";
import { ContentBlockEditor } from "@/app/bank/content-block-editor";
import { ContentBlockRenderer } from "@/app/bank/content-block-renderer";

/** Changes accepted by v6 question update/create callers. */
export type QuestionChanges = QuestionDraftV6;

/** Presentation-only join used by legacy-shaped layouts. Canonical content remains `canonical`. */
export interface QuestionViewModel {
  canonical: QuestionV6;
  id: string;
  bankId: string;
  bankName: string;
  sortOrder: number;
  stem: string;
  normalizedStem: string;
  answer: string;
  options: string[];
  type: QuestionTypeV6;
  tags: string[];
  favorite?: boolean;
}

export function toQuestionViewModel(question: QuestionV6, bankId = "", bankName = "未归档题目", sortOrder = 0): QuestionViewModel {
  const stem = deriveContentText(question.content);
  return {
    canonical: question,
    id: question.id,
    bankId,
    bankName,
    sortOrder,
    stem,
    normalizedStem: stem.normalize("NFKC").toLocaleLowerCase("zh-CN"),
    answer: question.answer,
    options: question.options.map((blocks) => deriveContentText(blocks)),
    type: question.type,
    tags: [...question.tags],
    favorite: question.favorite,
  };
}

const questionTypes: QuestionTypeV6[] = ["判断", "单选", "多选", "计算"];

function textBlocks(text: string, prefix: string): ContentBlock[] {
  return plainTextToContentBlocks(text, `${prefix}-0`);
}

function defaultOptions(type: QuestionTypeV6): ContentBlock[][] {
  if (type === "判断") return [textBlocks("正确", "option-0"), textBlocks("错误", "option-1")];
  if (type === "计算") return [];
  return Array.from({ length: 4 }, (_, index) => textBlocks("", `option-${index}`));
}

function normalizeAnswer(type: QuestionTypeV6, answer: string): string {
  if (type === "计算") return answer.trim();
  return [...new Set(answer.toUpperCase().replace(/[^A-Z]/g, "").split(""))].sort().join("");
}

async function prepareImage(file: File) {
  const optimized = await optimizeImageFile(file);
  await putImageAssetV6({
    id: optimized.id,
    blob: optimized.blob,
    mimeType: optimized.mimeType,
    size: optimized.size,
    width: optimized.width,
    height: optimized.height,
  });
  return { assetId: optimized.id };
}

/** Local-first image loader. A cache miss may lazily ask the public sync
 * facade for the blob; no URL is ever accepted or returned. */
export async function loadImageAssetV6(assetId: string): Promise<Blob | undefined> {
  const cached = await getImageAssetBlobV6(assetId);
  if (cached) return cached;
  try {
    const settings = loadGitHubSettings();
    const token = loadGitHubToken();
    if (!settings.repo || !token) return undefined;
    const facade = await import("@/lib/sync/github-sync") as unknown as { downloadImageAsset?: (settings: GitHubSettings, token: string, assetId: string) => Promise<unknown> };
    if (!facade.downloadImageAsset) return undefined;
    await facade.downloadImageAsset(settings, token, assetId);
    return getImageAssetBlobV6(assetId);
  } catch {
    return undefined;
  }
}

export function QuestionEditor({
  question,
  onSave,
  onCancel,
  title = "编辑题目",
  eyebrow = "使用 v6 富内容模型",
  submitLabel = "保存修改",
  initialNote = "",
}: {
  question: QuestionV6;
  onSave: (changes: QuestionChanges, note?: string) => Promise<void>;
  onCancel: () => void;
  title?: string;
  eyebrow?: string;
  submitLabel?: string;
  /** Current personal note; the editor saves it back only when it changes. */
  initialNote?: string;
}) {
  const [content, setContent] = useState<ContentBlock[]>(question.content.map((block) => ({ ...block })));
  const [options, setOptions] = useState<ContentBlock[][]>(question.options.map((blocks) => blocks.map((block) => ({ ...block }))));
  const [answer, setAnswer] = useState(question.answer);
  const [type, setType] = useState<QuestionTypeV6>(question.type);
  const [tags, setTags] = useState(question.tags.join("，"));
  const [note, setNote] = useState(initialNote);
  // The existing note is loaded asynchronously by the shared editor (useLiveQuery),
  // so `initialNote` arrives after mount; sync it into the field until the user
  // starts editing, so a question that already has a note shows its content.
  const noteLoadedRef = useRef(false);
  useEffect(() => {
    if (!noteLoadedRef.current && initialNote) { setNote(initialNote); noteLoadedRef.current = true; }
  }, [initialNote]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const answerText = useMemo(() => normalizeAnswer(type, answer), [answer, type]);

  function changeType(value: QuestionTypeV6) {
    setType(value);
    if (value === "判断") {
      setOptions(defaultOptions(value));
      setAnswer("A");
    } else if (value === "计算") {
      setOptions([]);
      setAnswer("");
    } else if (type === "计算" || type === "判断") {
      setOptions(defaultOptions(value));
      setAnswer("A");
    } else if (value === "单选" && answer.length > 1) {
      setAnswer(answer[0]);
    }
  }

  function toggleAnswer(letter: string) {
    if (type === "多选") {
      setAnswer(normalizeAnswer(type, answer.includes(letter) ? answer.replace(letter, "") : `${answer}${letter}`));
    } else setAnswer(letter);
  }

  function updateOption(index: number, value: ContentBlock[]) {
    setOptions((current) => current.map((item, optionIndex) => optionIndex === index ? value : item));
  }

  function addOption() {
    if (options.length >= 8) return;
    setOptions((current) => [...current, textBlocks("", `option-${current.length}`)]);
  }

  function removeOption(index: number) {
    const next = options.filter((_, optionIndex) => optionIndex !== index);
    setOptions(next);
    setAnswer(normalizeAnswer(type, answer.replace(String.fromCharCode(65 + index), "")));
  }

  async function save() {
    try {
      setSaving(true);
      setError("");
      const normalizedOptions = type === "计算" ? [] : options;
      const normalizedAnswer = normalizeAnswer(type, answer);
      if (!deriveContentText(content).trim() && !content.some((block) => block.type === "image")) throw new Error("题干不能为空。");
      if (type !== "计算" && normalizedOptions.length < 2) throw new Error("至少需要两个选项。");
      if (!normalizedAnswer) throw new Error("请填写正确答案。");
      // Forward the personal note only when it changed; callers persist it to
      // the resolved question id (which may differ in a shared-question split).
      const notePayload = note !== initialNote ? note : undefined;
      await onSave({
        type,
        content,
        options: normalizedOptions,
        answer: normalizedAnswer,
        tags: tags.split(/[，,、\n]+/).map((tag) => tag.trim()).filter(Boolean),
      }, notePayload);
      // Shared-question editing may open a decision dialog without unmounting
      // this editor; keep the form usable if that decision is cancelled.
      setSaving(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败");
      setSaving(false);
    }
  }

  return <ModalPortal><div className="editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><section className="question-editor" role="dialog" aria-modal="true" aria-labelledby="question-editor-title">
    <header><div><p className="eyebrow">{eyebrow}</p><h2 id="question-editor-title">{title}</h2></div><button className="icon-button" aria-label="关闭编辑器" onClick={onCancel}><X size={18} /></button></header>
    <div className="editor-body">
      <label htmlFor="question-type-select">题型<AppSelect id="question-type-select" ariaLabel="题型" value={type} onValueChange={(value) => changeType(value as QuestionTypeV6)} options={questionTypes.map((value) => ({ value, label: value }))} /></label>
      <div className="editor-rich-field"><div className="editor-label"><span>题干</span><small>文本、公式与本地图片可混排；图片不会接受 URL。</small></div><ContentBlockEditor value={content} onChange={setContent} prepareImage={prepareImage} loadAsset={loadImageAssetV6} /></div>
      {type === "计算" ? <label>标准数值答案<input aria-label="计算题标准答案" type="number" inputMode="decimal" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="例如：12.5" /><small>答题时按配置页设置的相对误差比例判定。</small></label> : <><div className="editor-label"><span>选项与正确答案</span><small>点击字母标记正确答案；每个选项支持文本、公式和图片。</small></div>
        <div className="editor-options editor-rich-options">{options.map((option, index) => { const letter = String.fromCharCode(65 + index); return <div className="editor-rich-option" key={`${letter}-${index}`}><button type="button" aria-label={`将 ${letter} 设为正确答案`} className={answerText.includes(letter) ? "answer-selected" : ""} onClick={() => toggleAnswer(letter)}>{letter}</button><ContentBlockEditor value={option} onChange={(next) => updateOption(index, next)} prepareImage={prepareImage} loadAsset={loadImageAssetV6} />{type !== "判断" && options.length > 2 && <button type="button" aria-label={`删除选项 ${letter}`} className="delete-option" onClick={() => removeOption(index)}><Trash2 size={16} /></button>}</div>; })}</div>
        {type !== "判断" && options.length < 8 && <button type="button" className="add-option" onClick={addOption}><Plus size={16} />添加选项</button>}</>}
      <label>自定义标签<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="例如：弧垂，易混，必背" /><small>使用逗号分隔，可添加、修改或删除标签。</small></label>
      <label>个人解析<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="写下错因、口诀或区分条件…" rows={4} /><small>支持 Markdown 与 LaTeX 公式；保存时与题目一起写入，可在做题页继续编辑。</small></label>
      <div className="editor-preview"><span>预览</span><ContentBlockRenderer blocks={content} loadAsset={loadImageAssetV6} /></div>
      {error && <p className="editor-error">{error}</p>}
    </div>
    <footer><button className="secondary-action" onClick={onCancel}>取消</button><button className="primary" disabled={saving} onClick={() => void save()}><Save size={17} />{saving ? "保存中…" : submitLabel}</button></footer>
  </section></div></ModalPortal>;
}

/**
 * Shared-question editing guard. A canonical question can be a member of
 * several banks, so saving must explicitly choose synchronized editing or a
 * split clone before touching the v6 row.
 */
export function SharedQuestionEditor({
  question,
  preferredBankId,
  onCancel,
  onSaved,
  title = "编辑题目",
}: {
  question: QuestionV6;
  preferredBankId?: string;
  onCancel: () => void;
  onSaved: () => void;
  title?: string;
}) {
  const [memberships, setMemberships] = useState<Array<{ bankId: string; name: string }>>([]);
  const [selectedBankIds, setSelectedBankIds] = useState<string[]>([]);
  const [pendingChanges, setPendingChanges] = useState<{ changes: QuestionChanges; note?: string }>();
  const existingNote = useLiveQuery(() => dbV6.notes.get(question.id), [question.id]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const membershipKey = `${question.id}:${preferredBankId ?? ""}`;
  const [loadedMembershipKey, setLoadedMembershipKey] = useState("");
  const [membershipLoadError, setMembershipLoadError] = useState<{ key: string; message: string }>();
  const membershipsReady = loadedMembershipKey === membershipKey;
  const membershipLoadFailed = membershipLoadError?.key === membershipKey;
  const membershipRequestRef = useRef<Promise<QuestionViewV6 | undefined> | undefined>(undefined);

  function rowsFromView(view: QuestionViewV6) {
    return view.memberships.map((membership) => ({
      bankId: membership.bankId,
      name: view.banks.find((bank) => bank.id === membership.bankId)?.displayName
        || view.banks.find((bank) => bank.id === membership.bankId)?.name
        || `题库 ${membership.bankId}`,
    }));
  }

  useEffect(() => {
    let disposed = false;
    const requestKey = membershipKey;
    const request = getQuestionViewV6(question.id, preferredBankId);
    membershipRequestRef.current = request;
    void request.then((view) => {
      if (disposed) return;
      if (!view) throw new Error("题目不存在或已被删除。");
      const rows = rowsFromView(view);
      setMemberships(rows);
      setSelectedBankIds(preferredBankId && rows.some((row) => row.bankId === preferredBankId) ? [preferredBankId] : rows.slice(0, 1).map((row) => row.bankId));
      setMembershipLoadError((current) => current?.key === requestKey ? undefined : current);
      setLoadedMembershipKey(requestKey);
    }).catch((loadError) => {
      if (!disposed) {
        const message = loadError instanceof Error ? loadError.message : "无法读取题库归属。";
        setMembershipLoadError({ key: requestKey, message });
        setError(message);
      }
    });
    return () => { disposed = true; };
  }, [membershipKey, preferredBankId, question.id]);

  async function applyChanges(changes: QuestionChanges, note: string | undefined, mode: "sync" | "split"): Promise<boolean> {
    setError("");
    setBusy(true);
    try {
      let targetId = question.id;
      if (mode === "sync") {
        await updateQuestionV6(question.id, changes);
      } else {
        if (!selectedBankIds.length) throw new Error("分裂题目时至少选择一个题库。");
        const result = await splitQuestionV6(question.id, selectedBankIds);
        const clone = result.clones[0];
        if (!clone) throw new Error("未找到可分裂的题库 membership。");
        await updateQuestionV6(clone.id, changes);
        targetId = clone.id;
      }
      // Persist the personal note to the resolved question (the clone on a
      // split); an undefined note means the editor left it unchanged.
      if (note !== undefined) await saveNoteV6(targetId, note);
      onSaved();
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(changes: QuestionChanges, note?: string) {
    // Do not treat the initial empty state as an unfiled/single-membership
    // question. A fast save must wait for the authoritative membership join.
    if (membershipLoadFailed) throw new Error(membershipLoadError?.message || error || "无法读取题库归属，请稍后重试。");
    let rows = memberships;
    if (!membershipsReady) {
      const view = await (membershipRequestRef.current ?? getQuestionViewV6(question.id, preferredBankId));
      if (!view) throw new Error("无法读取题库归属，请稍后重试。");
      rows = rowsFromView(view);
      setMemberships(rows);
      const defaults = preferredBankId && rows.some((row) => row.bankId === preferredBankId) ? [preferredBankId] : rows.slice(0, 1).map((row) => row.bankId);
      setSelectedBankIds(defaults);
    }
    if (rows.length <= 1) {
      await applyChanges(changes, note, "sync");
      return;
    }
    const defaults = preferredBankId && rows.some((row) => row.bankId === preferredBankId) ? [preferredBankId] : rows.slice(0, 1).map((row) => row.bankId);
    setSelectedBankIds((current) => current.length ? current : defaults);
    setPendingChanges({ changes, note });
  }

  const decisionDialog = pendingChanges ? <ModalPortal><div className="shared-edit-backdrop" role="presentation"><section className="shared-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="shared-edit-title"><header><div><span className="eyebrow">共享题目</span><h2 id="shared-edit-title">这道题属于多个题库</h2></div><button className="icon-button" onClick={() => setPendingChanges(undefined)} aria-label="取消共享题目决策"><X size={18} /></button></header><p>请选择本次修改的范围：同步修改会影响全部题库；分裂题目会将勾选的题库移到新的题目，原题的历史记录保留。</p><div className="shared-edit-memberships">{memberships.map((membership) => <label key={membership.bankId}><input type="checkbox" checked={selectedBankIds.includes(membership.bankId)} onChange={() => setSelectedBankIds((current) => current.includes(membership.bankId) ? current.filter((id) => id !== membership.bankId) : [...current, membership.bankId])} /><span>{membership.name}</span></label>)}</div>{error && <p className="editor-error">{error}</p>}<footer><button className="secondary-action" disabled={busy} onClick={() => setPendingChanges(undefined)}>取消</button><button className="secondary-action" disabled={busy} onClick={() => { if (!pendingChanges) return; void applyChanges(pendingChanges.changes, pendingChanges.note, "sync").then((success) => { if (success) setPendingChanges(undefined); }); }}>同步修改全部题库</button><button className="primary" disabled={busy || !selectedBankIds.length} onClick={() => { if (!pendingChanges) return; void applyChanges(pendingChanges.changes, pendingChanges.note, "split").then((success) => { if (success) setPendingChanges(undefined); }); }}>{busy ? "保存中…" : "分裂勾选题库"}</button></footer></section></div></ModalPortal> : null;
  return <>{decisionDialog}<QuestionEditor question={question} title={title} onCancel={onCancel} onSave={save} initialNote={existingNote?.content ?? ""} /></>;
}
