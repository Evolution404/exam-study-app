import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowDown, ArrowUp, Check, ChevronRight, FolderPlus, Layers3, Merge, Pencil, Play, Plus, Search, Tags, Trash2, X } from "lucide-react";
import { dbV7, deleteQuestionGroupV7, saveQuestionGroupV7, updateQuestionV7 } from "@/lib/db/db-v7";
import { listQuestionViewsForBanksV7 } from "@/lib/db/app-data-v7";
import { summarizeAttemptStats } from "@/lib/practice/practice-metrics";
import type { QuestionGroupV7 } from "@/lib/db/v7-types";
import type { QuestionGroupItem } from "@/types/types";
import { loadImageAssetV7, toQuestionViewModel, type QuestionViewModel } from "@/app/bank/question-editor";
import { ConfirmDialog } from "@/app/ui/confirm-dialog";
import { MathText } from "@/app/ui/math-text";
import { AppSelect } from "@/app/ui/app-select";
import { ContentBlockRenderer } from "@/app/bank/content-block-renderer";

type Question = QuestionViewModel;
type QuestionGroup = QuestionGroupV7;
type QuestionGroupType = QuestionGroupV7["type"];
const GROUP_TYPES: QuestionGroupType[] = ["易混", "相似", "前置", "重复", "专题", "自定义"];

async function allQuestionViews(): Promise<Question[]> {
  const banks = await dbV7.banks.toArray();
  const views = await listQuestionViewsForBanksV7(banks.map((bank) => bank.id));
  return views.map((view) => {
    const bank = view.banks.find((item) => item.id === view.sourceBankId) ?? view.banks[0];
    const membership = view.memberships.find((item) => item.bankId === view.sourceBankId) ?? view.memberships[0];
    return toQuestionViewModel(view.question, view.sourceBankId ?? "", bank?.displayName || bank?.name || "未归档题目", membership?.sortOrder ?? 0);
  });
}

export function KnowledgeView({ initialQuestionIds, onStartTag, onStartQuestions, onNotice }: {
  initialQuestionIds?: string[];
  onStartTag: (tag: string) => void;
  onStartQuestions: (questions: Question[], label: string) => void;
  onNotice: (message: string) => void;
}) {
  const [tab, setTab] = useState<"tags" | "groups">(initialQuestionIds?.length ? "groups" : "tags");
  return <>
    <div className="page-heading compact"><div><p className="eyebrow">自己的知识结构</p><h1>知识整理</h1><p>标签用于分类筛选；题组用于把若干相关题目按顺序放在一起。</p></div></div>
    <div className="knowledge-tabs"><button className={tab === "tags" ? "active" : ""} onClick={() => setTab("tags")}><Tags size={17} />标签</button><button className={tab === "groups" ? "active" : ""} onClick={() => setTab("groups")}><Layers3 size={17} />题组</button></div>
    {tab === "tags" ? <TagWorkspace onStart={onStartTag} onNotice={onNotice} /> : <GroupWorkspace initialQuestionIds={initialQuestionIds} onStart={onStartQuestions} onNotice={onNotice} />}
  </>;
}

function TagWorkspace({ onStart, onNotice }: { onStart: (tag: string) => void; onNotice: (message: string) => void }) {
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string>();
  const [renameValue, setRenameValue] = useState("");
  const [deleteTagPrompt, setDeleteTagPrompt] = useState<string>();
  const data = useLiveQuery(async () => ({ questions: await allQuestionViews(), attemptStats: await dbV7.attemptStats.toArray() }), []);
  const tags = useMemo(() => {
    const questions = data?.questions ?? [];
    const statsByQuestion = new Map((data?.attemptStats ?? []).map((stats) => [stats.questionId, { ...stats, bankId: "" }]));
    return [...new Set(questions.flatMap((question) => question.tags))].map((name) => {
      const tagged = questions.filter((question) => question.tags.includes(name));
      const summary = tagged.reduce((result, question) => {
        const stats = statsByQuestion.get(question.id);
        result.total += stats?.total ?? 0;
        result.correct += stats?.correct ?? 0;
        return result;
      }, { total: 0, correct: 0 });
      const difficulty = tagged.length ? Math.round(tagged.reduce((total, question) => total + summarizeAttemptStats(statsByQuestion.get(question.id)).difficulty, 0) / tagged.length) : 50;
      return { name, questions: tagged, count: tagged.length, accuracy: summary.total ? Math.round(summary.correct / summary.total * 100) : 0, difficulty };
    }).filter((item) => item.name.toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN"))).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
  }, [data, query]);
  const selected = tags.find((item) => item.name === activeTag);

  async function replaceTag(from: string, to?: string) {
    const targets = (data?.questions ?? []).filter((question) => question.tags.includes(from));
    await Promise.all(targets.map((question) => updateQuestionV7(question.id, { tags: to ? [...new Set(question.tags.map((tag) => tag === from ? to : tag))] : question.tags.filter((tag) => tag !== from) })));
    setActiveTag(undefined); setRenameValue("");
    onNotice(to ? `标签“${from}”已整理为“${to}”` : `标签“${from}”已从 ${targets.length} 道题移除`);
  }

  return <><div className="tag-workspace"><section className="tag-browser"><header><div className="knowledge-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索用户标签" /></div><span>{tags.length} 个标签</span></header>{tags.length ? <div className="tag-card-grid">{tags.map((item) => <article className={activeTag === item.name ? "active" : ""} key={item.name}><button onClick={() => { setActiveTag(item.name); setRenameValue(item.name); }}><Tags size={17} /><span><strong>{item.name}</strong><small>{item.count} 道题 · 正确率 {item.accuracy}% · 难度 {item.difficulty}</small></span><ChevronRight size={16} /></button><button className="tag-quick-practice" onClick={() => onStart(item.name)}><Play size={14} />练习</button></article>)}</div> : <div className="knowledge-empty"><Tags /><h2>还没有用户标签</h2><p>标签由你自己添加，只负责分类和筛选，不会自动创建题组。</p></div>}</section>{selected && <aside className="tag-detail"><header><div><span className="section-kicker">标签详情</span><h2>{selected.name}</h2></div><button aria-label="关闭标签详情" className="icon-button" onClick={() => setActiveTag(undefined)}><X size={17} /></button></header><div className="tag-detail-stats"><span><strong>{selected.count}</strong>相关题目</span><span><strong>{selected.accuracy}%</strong>正确率</span><span><strong>{selected.difficulty}</strong>平均难度</span></div><label>重命名或合并标签<input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} /><small>目标名称已存在时会合并；题组不受影响。</small></label><div className="tag-manage-actions"><button disabled={!renameValue.trim() || renameValue.trim() === selected.name} onClick={() => void replaceTag(selected.name, renameValue.trim())}><Merge size={16} />保存或合并</button><button className="danger-button" onClick={() => setDeleteTagPrompt(selected.name)}><Trash2 size={16} />删除标签</button></div><button className="primary full" onClick={() => onStart(selected.name)}><Play size={17} />练习这个标签</button><div className="tag-question-preview">{selected.questions.slice(0, 12).map((question, index) => <div key={question.id}><span>{index + 1}</span><ContentBlockRenderer blocks={question.canonical.content} loadAsset={loadImageAssetV7} /></div>)}</div></aside>}</div><ConfirmDialog open={Boolean(deleteTagPrompt)} eyebrow="标签管理" title="移除这个标签？" tone="danger" confirmLabel="移除标签" onCancel={() => setDeleteTagPrompt(undefined)} onConfirm={() => { if (deleteTagPrompt) void replaceTag(deleteTagPrompt); setDeleteTagPrompt(undefined); }} description={<><strong>标签“{deleteTagPrompt}”会从相关题目中移除</strong><span>题目和题组不会被删除，此操作会加入同步队列。</span></>} /></>;
}

function GroupWorkspace({ initialQuestionIds, onStart, onNotice }: { initialQuestionIds?: string[]; onStart: (questions: Question[], label: string) => void; onNotice: (message: string) => void }) {
  const data = useLiveQuery(async () => ({ questions: await allQuestionViews(), groups: await dbV7.questionGroups.orderBy("updatedAt").reverse().toArray() }), []);
  const [editingId, setEditingId] = useState<string>();
  const [name, setName] = useState("");
  const [type, setType] = useState<QuestionGroupType>("易混");
  const [description, setDescription] = useState("");
  const [items, setItems] = useState<QuestionGroupItem[]>((initialQuestionIds ?? []).map((questionId) => ({ questionId, note: "" })));
  const [query, setQuery] = useState("");
  const [deleteGroupPrompt, setDeleteGroupPrompt] = useState<QuestionGroup>();
  const questions = data?.questions ?? [];
  const byId = new Map(questions.map((question) => [question.id, question]));
  const results = query.trim() ? questions.filter((question) => !items.some((item) => item.questionId === question.id) && [question.stem, question.bankName, ...question.tags].join(" ").toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN"))).slice(0, 8) : [];

  function reset() { setEditingId(undefined); setName(""); setType("易混"); setDescription(""); setItems([]); setQuery(""); }
  function edit(group: QuestionGroup) { setEditingId(group.id); setName(group.name); setType(group.type); setDescription(group.description); setItems(group.items); setQuery(""); window.scrollTo({ top: 0, behavior: "smooth" }); }
  function move(index: number, offset: number) { const next = [...items]; const target = index + offset; if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; setItems(next); }
  async function save() {
      try { const group = await saveQuestionGroupV7({ id: editingId, name, type, description, items }); onNotice(`题组“${group.name}”已保存，共 ${group.items.length} 道题`); reset(); }
    catch (error) { onNotice(error instanceof Error ? error.message : "题组保存失败"); }
  }

  return <div className="group-workspace">
    <section className="group-editor"><header><FolderPlus size={20} /><div><strong>{editingId ? "编辑题组" : "新建题组"}</strong><p>可加入任意数量题目、调整顺序，并为每道题写组内提示。</p></div></header><div className="group-fields"><label>题组名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：弧垂计算易混题" /></label><label htmlFor="question-group-type-select">题组类型<AppSelect id="question-group-type-select" ariaLabel="题组类型" value={type} onValueChange={(value) => setType(value as QuestionGroupType)} options={GROUP_TYPES.map((item) => ({ value: item, label: item }))} /></label><label className="group-description">题组说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="记录这些题为什么要放在一起" /></label></div>
      <div className="group-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索题干、题库或标签，连续添加多道题" /></div>{results.length > 0 && <div className="group-search-results">{results.map((question) => <button key={question.id} onClick={() => { setItems([...items, { questionId: question.id, note: "" }]); setQuery(""); }}><Plus size={15} /><span><strong><MathText text={question.stem} /></strong><small>{question.type} · {question.bankName}</small></span></button>)}</div>}
      <div className="group-items">{items.length ? items.map((item, index) => { const question = byId.get(item.questionId); if (!question) return null; return <article key={item.questionId}><span className="group-order">{index + 1}</span><div><strong><MathText text={question.stem} /></strong><small>{question.type} · {question.bankName}</small><input value={item.note} onChange={(event) => setItems(items.map((row, rowIndex) => rowIndex === index ? { ...row, note: event.target.value } : row))} placeholder="这道题在本组中的区分点（可选）" /></div><aside><button disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} /></button><button disabled={index === items.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} /></button><button onClick={() => setItems(items.filter((_, rowIndex) => rowIndex !== index))}><X size={15} /></button></aside></article>; }) : <div className="group-items-empty">还没有题目。搜索后可连续添加，至少添加一道。</div>}</div>
      <footer>{editingId && <button onClick={reset}>取消编辑</button>}<button className="primary" disabled={!name.trim() || !items.length} onClick={() => void save()}><Check size={16} />保存题组</button></footer>
    </section>
    <section className="group-list"><header><div><span className="section-kicker">独立于标签的精细整理</span><h2>{data?.groups.length ?? 0} 个题组</h2></div></header>{data?.groups.length ? <div>{data.groups.map((group) => { const groupQuestions = group.items.map((item) => byId.get(item.questionId)).filter((question): question is Question => Boolean(question)); return <article key={group.id}><header><span className="group-type">{group.type}</span><div><h3>{group.name}</h3><p>{group.description || "未填写题组说明"}</p></div><strong>{groupQuestions.length} 题</strong></header><ol>{groupQuestions.slice(0, 4).map((question, index) => <li key={question.id}><span>{index + 1}</span><MathText text={question.stem} /></li>)}</ol>{groupQuestions.length > 4 && <small>还有 {groupQuestions.length - 4} 道题</small>}<footer><button onClick={() => edit(group)}><Pencil size={15} />编辑</button><button onClick={() => onStart(groupQuestions, `题组 · ${group.name}`)}><Play size={15} />练习题组</button><button className="danger-button" onClick={() => setDeleteGroupPrompt(group)}><Trash2 size={15} />删除</button></footer></article>; })}</div> : <div className="knowledge-empty"><Layers3 /><h2>还没有题组</h2><p>在上方搜索并添加若干题目，建立第一组易混题、专题题或自定义题组。</p></div>}</section>
    <ConfirmDialog open={Boolean(deleteGroupPrompt)} eyebrow="题组管理" title="删除这个题组？" tone="danger" confirmLabel="删除题组" onCancel={() => setDeleteGroupPrompt(undefined)} onConfirm={() => { if (deleteGroupPrompt) void deleteQuestionGroupV7(deleteGroupPrompt.id).then(() => onNotice(`题组“${deleteGroupPrompt.name}”已删除`)); setDeleteGroupPrompt(undefined); }} description={<><strong>题组“{deleteGroupPrompt?.name}”将被删除</strong><span>题组内的题目和标签会保留，此操作会加入同步队列。</span></>} />
  </div>;
}
