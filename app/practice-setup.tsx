import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  BookOpenCheck, ChevronRight, Filter, ListOrdered, RotateCcw, Shuffle, Tags,
} from "lucide-react";
import { db } from "@/lib/db";
import type { Bank, PracticeFilter, PracticeMode, QuestionType } from "@/lib/types";

const modes: Array<{ id: PracticeMode; title: string; detail: string; icon: typeof Shuffle }> = [
  { id: "random30", title: "随机 30 题", detail: "从当前题库随机抽取一组", icon: Shuffle },
  { id: "sequential", title: "全量顺序练习", detail: "按题库原有顺序练完全部题目", icon: ListOrdered },
  { id: "wrong", title: "错题模式", detail: "集中练习曾经答错的题目", icon: RotateCcw },
  { id: "tag", title: "标签模式", detail: "按一个或多个知识标签练习", icon: Tags },
  { id: "advanced", title: "高级筛选", detail: "组合题型、状态、标签和数量", icon: Filter },
];

const questionTypes: QuestionType[] = ["判断", "单选", "多选"];

export function PracticeSetupView({ banks, currentBankId, onBankChange, onStart }: {
  banks: Bank[];
  currentBankId: string;
  onBankChange: (bankId: string) => void;
  onStart: (filter: PracticeFilter) => void;
}) {
  const [bankId, setBankId] = useState(currentBankId);
  const [mode, setMode] = useState<PracticeMode>("sequential");
  const [types, setTypes] = useState<QuestionType[]>(questionTypes);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [status, setStatus] = useState<PracticeFilter["status"]>("all");
  const [order, setOrder] = useState<PracticeFilter["order"]>("sequential");
  const [limit, setLimit] = useState<number | null>(null);
  const questions = useLiveQuery(() => bankId ? db.questions.where("bankId").equals(bankId).toArray() : [], [bankId]) ?? [];
  const tags = [...new Set(questions.flatMap((question) => question.tags))].sort((a, b) => a.localeCompare(b, "zh-CN"));

  function toggleType(type: QuestionType) {
    setTypes(types.includes(type) ? types.filter((item) => item !== type) : [...types, type]);
  }

  function toggleTag(tag: string) {
    setSelectedTags(selectedTags.includes(tag) ? selectedTags.filter((item) => item !== tag) : [...selectedTags, tag]);
  }

  function start() {
    const filter: PracticeFilter = {
      bankId,
      mode,
      types: mode === "advanced" ? types : questionTypes,
      tags: mode === "tag" || mode === "advanced" ? selectedTags : [],
      status: mode === "wrong" ? "wrong" : mode === "advanced" ? status : "all",
      order: mode === "random30" ? "random" : mode === "advanced" ? order : "sequential",
      limit: mode === "random30" ? 30 : mode === "advanced" ? limit : null,
    };
    onStart(filter);
  }

  const disabled = !bankId || (mode === "tag" && !selectedTags.length) || (mode === "advanced" && !types.length);
  return <>
    <div className="page-heading compact"><div><p className="eyebrow">自由安排练习</p><h1>选择练习模式</h1><p>全量顺序、错题、标签或任意组合筛选，进度都会自动保存。</p></div></div>
    <section className="practice-setup-card">
      <label className="setup-bank"><span>练习题库</span><select value={bankId} onChange={(event) => { setBankId(event.target.value); onBankChange(event.target.value); }}>{banks.map((bank) => <option key={bank.id} value={bank.id}>{bank.name}（{bank.questionCount} 题）</option>)}</select></label>
      <div className="mode-grid">{modes.map(({ id, title, detail, icon: Icon }) => <button key={id} className={mode === id ? "active" : ""} onClick={() => setMode(id)}><Icon size={20} /><strong>{title}</strong><small>{detail}</small></button>)}</div>

      {(mode === "tag" || mode === "advanced") && <div className="filter-section"><div className="filter-title"><Tags size={17} /><strong>知识标签</strong><small>{selectedTags.length ? `已选 ${selectedTags.length} 个` : "请选择标签"}</small></div>{tags.length ? <div className="chip-list">{tags.map((tag) => <button key={tag} className={selectedTags.includes(tag) ? "selected" : ""} onClick={() => toggleTag(tag)}>{tag}</button>)}</div> : <p className="filter-empty">当前题库还没有标签，可在练习中编辑题目并添加标签。</p>}</div>}

      {mode === "advanced" && <div className="advanced-grid">
        <div className="filter-section"><div className="filter-title"><BookOpenCheck size={17} /><strong>题型</strong></div><div className="chip-list">{questionTypes.map((type) => <button key={type} className={types.includes(type) ? "selected" : ""} onClick={() => toggleType(type)}>{type}</button>)}</div></div>
        <label>作答状态<select value={status} onChange={(event) => setStatus(event.target.value as PracticeFilter["status"])}><option value="all">全部题目</option><option value="unanswered">尚未作答</option><option value="wrong">曾经答错</option></select></label>
        <label>题目顺序<select value={order} onChange={(event) => setOrder(event.target.value as PracticeFilter["order"])}><option value="sequential">题库顺序</option><option value="random">随机打乱</option></select></label>
        <label>练习数量<select value={limit ?? "all"} onChange={(event) => setLimit(event.target.value === "all" ? null : Number(event.target.value))}><option value="all">全部符合条件的题</option><option value="30">30 题</option><option value="50">50 题</option><option value="100">100 题</option></select></label>
      </div>}

      <div className="setup-footer"><div><strong>{questions.length.toLocaleString()}</strong><span>当前题库题目</span></div><button className="primary" disabled={disabled} onClick={start}>开始练习<ChevronRight size={18} /></button></div>
    </section>
  </>;
}
