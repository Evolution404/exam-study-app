"use client";

import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  BookOpen, Brain, Check, ChevronLeft, ChevronRight, CircleAlert, Cloud,
  FileUp, GitBranch, Home, Library, Link2, LoaderCircle, Menu,
  NotebookPen, RotateCcw, Search, Settings2, Sparkles, Target, X,
} from "lucide-react";
import { db, importQuestionBank, recordAttempt, saveNote } from "@/lib/db";
import { getGitHubLogin, syncWithGitHub } from "@/lib/github-sync";
import type { GitHubSettings, Question } from "@/lib/types";

type View = "home" | "banks" | "wrong" | "relations" | "preferences" | "settings" | "practice";

interface PracticePreferences {
  autoNextCorrect: boolean;
  showAnswerOnWrong: boolean;
  swipeNavigation: boolean;
}

const DEFAULT_PREFERENCES: PracticePreferences = {
  autoNextCorrect: true,
  showAnswerOnWrong: true,
  swipeNavigation: true,
};

function loadPreferences() {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    return { ...DEFAULT_PREFERENCES, ...JSON.parse(localStorage.getItem("practice-preferences") ?? "{}") } as PracticePreferences;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function answerText(question: Question) {
  return question.answer
    .split("")
    .map((letter) => `${letter}. ${question.options[letter.charCodeAt(0) - 65] ?? ""}`)
    .join("；");
}

function formatDate(value?: string) {
  if (!value) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value));
}

function shuffle<T>(values: T[]) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function StudyApp() {
  const [view, setView] = useState<View>("home");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [queue, setQueue] = useState<Question[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [currentBankId, setCurrentBankId] = useState(() => typeof window === "undefined" ? "" : localStorage.getItem("study-current-bank") ?? "");
  const [preferences, setPreferences] = useState<PracticePreferences>(loadPreferences);
  const fileRef = useRef<HTMLInputElement>(null);


  const banks = useLiveQuery(() => db.banks.orderBy("importedAt").reverse().toArray(), []) ?? [];
  const currentBank = banks.find((bank) => bank.id === currentBankId) ?? banks[0];
  const stats = useLiveQuery(async () => {
    const [questions, attempts, correct, pending, notes] = await Promise.all([
      db.questions.count(), db.attempts.count(), db.attempts.where("correct").equals(1).count(),
      db.events.where("synced").equals(0).count(), db.notes.count(),
    ]);
    const last = await db.attempts.orderBy("createdAt").last();
    return { questions, attempts, correct, pending, notes, last: last?.createdAt };
  }, []) ?? { questions: 0, attempts: 0, correct: 0, pending: 0, notes: 0, last: undefined };

  async function onImport(file?: File) {
    if (!file) return;
    try {
      setNotice("正在整理题库…");
      const raw = JSON.parse(await file.text());
      const bank = await importQuestionBank(file.name, raw);
      setNotice(`已导入「${bank.name}」的 ${bank.questionCount} 道题`);
      setView("banks");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "题库导入失败");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function selectBank(bankId: string) {
    setCurrentBankId(bankId);
    localStorage.setItem("study-current-bank", bankId);
  }

  function updatePreferences(value: PracticePreferences) {
    setPreferences(value);
    localStorage.setItem("practice-preferences", JSON.stringify(value));
  }

  async function startPractice(filter: "all" | "wrong" = "all", bankId = currentBank?.id) {
    if (!bankId) {
      setNotice("请先选择一个题库");
      return;
    }
    let questions: Question[];
    if (filter === "wrong") {
      const attempts = (await db.attempts.where("correct").equals(0).toArray()).filter((item) => item.bankId === bankId);
      const ids = [...new Set(attempts.map((item) => item.questionId))];
      questions = (await db.questions.bulkGet(ids)).filter(Boolean) as Question[];
    } else {
      questions = await db.questions.where("bankId").equals(bankId).toArray();
    }
    if (!questions.length) {
      setNotice(filter === "wrong" ? "还没有错题" : "请先导入一个题库");
      return;
    }
    setQueue(shuffle(questions).slice(0, 30));
    setQueueIndex(0);
    setView("practice");
  }

  const navItems = [
    { id: "home" as const, label: "今日", icon: Home },
    { id: "banks" as const, label: "题库", icon: Library },
    { id: "wrong" as const, label: "错题", icon: RotateCcw },
    { id: "relations" as const, label: "关联", icon: Link2 },
    { id: "preferences" as const, label: "配置", icon: Settings2 },
    { id: "settings" as const, label: "同步", icon: Cloud },
  ];

  return (
    <main className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand"><span className="brand-mark">拾</span><span>拾卷</span></div>
        <nav>
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={view === id ? "nav-active" : ""} onClick={() => { setView(id); setSidebarOpen(false); }}>
              <Icon size={19} strokeWidth={1.8} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="local-dot" />本地数据已保存
          <small>{stats.pending ? `${stats.pending} 条等待同步` : "没有待同步更改"}</small>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={20} /></button>
          <div className="searchbox"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索题目、知识点或解析" /></div>
          <button className="sync-pill" onClick={() => setView("settings")}><Cloud size={16} />{stats.pending ? `待同步 ${stats.pending}` : "已保存"}</button>
          <button className="avatar" aria-label="个人设置">Y</button>
        </header>

        {notice && <div className="toast"><Sparkles size={16} /><span>{notice}</span><button onClick={() => setNotice("")}><X size={15} /></button></div>}
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(event) => onImport(event.target.files?.[0])} />

        <div className="content">
          {view === "home" && <Dashboard stats={stats} banks={banks} currentBankId={currentBank?.id ?? ""} onBankChange={selectBank} onImport={() => fileRef.current?.click()} onStart={() => startPractice()} />}
          {view === "banks" && <BanksView banks={banks} currentBankId={currentBank?.id ?? ""} query={query} onImport={() => fileRef.current?.click()} onStart={(bankId) => { selectBank(bankId); void startPractice("all", bankId); }} />}
          {view === "wrong" && <WrongView bankId={currentBank?.id} bankName={currentBank?.name} onStart={() => startPractice("wrong")} />}
          {view === "relations" && <RelationsView />}
          {view === "preferences" && <PreferencesView preferences={preferences} onChange={updatePreferences} />}
          {view === "settings" && <SyncView pending={stats.pending} onNotice={setNotice} />}
          {view === "practice" && queue[queueIndex] && (
            <Practice key={queue[queueIndex].id} question={queue[queueIndex]} index={queueIndex} total={queue.length} preferences={preferences} onExit={() => setView("home")} onPrevious={() => setQueueIndex(Math.max(0, queueIndex - 1))} onNext={() => {
              if (queueIndex + 1 >= queue.length) { setNotice("本组练习完成"); setView("home"); }
              else setQueueIndex(queueIndex + 1);
            }} />
          )}
        </div>
      </section>
    </main>
  );
}

function Dashboard({ stats, banks, currentBankId, onBankChange, onImport, onStart }: {
  stats: { questions: number; attempts: number; correct: number; pending: number; notes: number; last?: string };
  banks: Array<{ id: string; name: string; questionCount: number }>;
  currentBankId: string;
  onBankChange: (bankId: string) => void;
  onImport: () => void; onStart: () => void;
}) {
  const accuracy = stats.attempts ? Math.round(stats.correct / stats.attempts * 100) : 0;
  const currentBank = banks.find((bank) => bank.id === currentBankId);
  return <>
    <div className="page-heading"><div><p className="eyebrow">今天也向前一点</p><h1>把知识，练成下意识。</h1><p>题库留在你的设备里，记录完整，随时继续。</p></div><div className="heading-actions">{banks.length > 0 && <label className="bank-picker"><span>当前题库</span><select value={currentBankId} onChange={(event) => onBankChange(event.target.value)}>{banks.map((bank) => <option key={bank.id} value={bank.id}>{bank.name}（{bank.questionCount}题）</option>)}</select></label>}<button className="primary" onClick={onStart}><Brain size={18} />开始练习</button></div></div>
    <section className="hero-grid">
      <article className="focus-card">
        <div className="focus-copy"><span className="section-kicker">今日推荐</span><h2>{currentBank ? "来一组 30 题" : "先导入第一份题库"}</h2><p>{currentBank ? `从「${currentBank.name}」随机抽取，题型混合。` : "支持当前项目的 q / ans / a JSON 格式。"}</p><button onClick={currentBank ? onStart : onImport}>{currentBank ? "开始这一组" : "选择 JSON 文件"}<ChevronRight size={17} /></button></div>
        <div className="progress-orbit"><div><strong>{stats.questions ? Math.min(stats.attempts, 30) : 0}</strong><span>/ 30</span></div></div>
      </article>
      <article className="quote-card"><span>记忆提示</span><blockquote>“不要重复阅读答案，<br />先遮住它，再努力想起来。”</blockquote><small>主动回忆比熟悉感更可靠</small></article>
    </section>
    <section className="stat-grid">
      <Stat icon={<BookOpen />} label="题目总数" value={stats.questions.toLocaleString()} foot={`${banks.length} 个题库`} />
      <Stat icon={<Target />} label="累计作答" value={stats.attempts.toLocaleString()} foot={`最近：${formatDate(stats.last)}`} />
      <Stat icon={<Check />} label="正确率" value={`${accuracy}%`} foot={stats.attempts ? `${stats.correct} 次答对` : "等待第一次作答"} />
      <Stat icon={<NotebookPen />} label="个人解析" value={stats.notes.toLocaleString()} foot="沉淀自己的记忆钩子" />
    </section>
    <section className="section-block"><div className="section-title"><div><span className="section-kicker">最近题库</span><h2>从熟悉的内容继续</h2></div><button className="text-button" onClick={onImport}><FileUp size={16} />导入题库</button></div>
      {banks.length ? <div className="bank-list">{banks.slice(0, 3).map((bank, index) => <div className="bank-row" key={bank.id}><span className={`bank-icon tone-${index % 3}`}><Library size={18} /></span><div><strong>{bank.name}</strong><small>{bank.questionCount} 道题</small></div><span className="bank-ready">可练习</span><ChevronRight size={17} /></div>)}</div> : <EmptyImport onImport={onImport} />}
    </section>
  </>;
}

function Stat({ icon, label, value, foot }: { icon: React.ReactNode; label: string; value: string; foot: string }) {
  return <article className="stat-card"><span className="stat-icon">{icon}</span><span>{label}</span><strong>{value}</strong><small>{foot}</small></article>;
}

function EmptyImport({ onImport }: { onImport: () => void }) {
  return <button className="empty-import" onClick={onImport}><span><FileUp size={22} /></span><div><strong>导入 JSON 题库</strong><small>数据直接写入本机，不经过第三方服务器</small></div><ChevronRight size={18} /></button>;
}

function BanksView({ banks, currentBankId, query, onImport, onStart }: { banks: Array<{ id: string; name: string; questionCount: number; importedAt: string }>; currentBankId: string; query: string; onImport: () => void; onStart: (bankId: string) => void }) {
  const filtered = banks.filter((bank) => bank.name.toLowerCase().includes(query.toLowerCase()));
  return <><div className="page-heading compact"><div><p className="eyebrow">我的资料</p><h1>题库</h1><p>导入、版本化并随时开始一组练习。</p></div><button className="primary" onClick={onImport}><FileUp size={18} />导入题库</button></div>
    {filtered.length ? <div className="library-grid">{filtered.map((bank, index) => <article className={`library-card ${bank.id === currentBankId ? "current" : ""}`} key={bank.id}><span className={`bank-icon large tone-${index % 3}`}><Library size={22} /></span><span className="bank-ready">{bank.id === currentBankId ? "当前题库" : "本地可用"}</span><h2>{bank.name}</h2><p>{bank.questionCount.toLocaleString()} 道题 · {formatDate(bank.importedAt)} 导入</p><button onClick={() => onStart(bank.id)}>{bank.id === currentBankId ? "开始当前题库" : "设为当前并练习"}<ChevronRight size={17} /></button></article>)}</div> : <EmptyImport onImport={onImport} />}
  </>;
}

function WrongView({ bankId, bankName, onStart }: { bankId?: string; bankName?: string; onStart: () => void }) {
  const count = useLiveQuery(async () => {
    const rows = await db.attempts.where("correct").equals(0).toArray();
    return new Set(rows.filter((row) => !bankId || row.bankId === bankId).map((row) => row.questionId)).size;
  }, [bankId]) ?? 0;
  return <div className="center-panel"><span className="center-icon warning"><CircleAlert /></span><p className="eyebrow">错题回炉 · {bankName ?? "当前题库"}</p><h1>{count ? `${count} 道题等你攻克` : "当前题库还没有错题"}</h1><p>{count ? "重新作答，连续答对后再移出重点复习。" : "每次作答都会自动记录，答错的题会出现在这里。"}</p><button className="primary" onClick={onStart} disabled={!count}><RotateCcw size={18} />开始错题练习</button></div>;
}

function RelationsView() {
  const tags = useLiveQuery(async () => {
    const questions = await db.questions.toArray();
    const counts = new Map<string, number>();
    questions.flatMap((question) => question.tags).forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, []) ?? [];
  return <><div className="page-heading compact"><div><p className="eyebrow">知识网络</p><h1>题目关联</h1><p>先按知识点聚合，再逐步标记易混、相似和前置关系。</p></div></div>
    <div className="topic-grid">{tags.length ? tags.map(([tag, count], index) => <article key={tag}><span>{String(index + 1).padStart(2, "0")}</span><h2>{tag}</h2><p>{count} 道相关题</p><div className="topic-line"><i style={{ width: `${Math.min(100, 25 + count)}%` }} /></div></article>) : <div className="center-panel small"><Link2 /><h2>导入题库后自动生成知识点关联</h2><p>弧垂、杆塔、接地等关键词会成为第一层索引。</p></div>}</div>
  </>;
}

function PreferencesView({ preferences, onChange }: { preferences: PracticePreferences; onChange: (value: PracticePreferences) => void }) {
  const items: Array<{ key: keyof PracticePreferences; title: string; detail: string }> = [
    { key: "autoNextCorrect", title: "答对后自动下一题", detail: "单选题和判断题选择正确答案后自动前进；多选题仍需确认。" },
    { key: "showAnswerOnWrong", title: "答错显示正确答案", detail: "立即标出错误选项和正确选项，方便当场纠正记忆。" },
    { key: "swipeNavigation", title: "左右滑动切换题目", detail: "向左滑进入下一题，向右滑返回上一题。" },
  ];
  return <><div className="page-heading compact"><div><p className="eyebrow">练习偏好</p><h1>答题配置</h1><p>设置只保存在当前浏览器，不会修改题库内容。</p></div></div>
    <section className="preference-card"><div className="settings-title"><span><Settings2 /></span><div><h2>答题交互</h2><p>根据自己的背题节奏随时调整。</p></div></div>
      <div className="preference-list">{items.map((item) => <label aria-label={item.title} className="preference-row" key={item.key}><div><strong>{item.title}</strong><p>{item.detail}</p></div><input aria-label={item.title} type="checkbox" checked={preferences[item.key]} onChange={(event) => onChange({ ...preferences, [item.key]: event.target.checked })} /><span className="toggle" aria-hidden="true" /></label>)}</div>
    </section>
    <section className="gesture-guide"><span><ChevronLeft size={19} />右滑</span><p>上一题</p><i /><p>下一题</p><span>左滑<ChevronRight size={19} /></span></section>
  </>;
}

function Practice({ question, index, total, preferences, onPrevious, onNext, onExit }: { question: Question; index: number; total: number; preferences: PracticePreferences; onPrevious: () => void; onNext: () => void; onExit: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [autoAdvancing, setAutoAdvancing] = useState(false);
  const [startedAt] = useState(() => Date.now());
  const note = useLiveQuery(() => db.notes.get(question.id), [question.id]);
  const [draft, setDraft] = useState<string | null>(null);
  const autoNextTimer = useRef<number | undefined>(undefined);
  const answering = useRef(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const effectiveDraft = draft ?? note?.content ?? "";
  const selectedAnswer = [...selected].sort().join("");
  const correct = submitted && selectedAnswer === [...question.answer].sort().join("");
  const revealAnswer = submitted && (correct || preferences.showAnswerOnWrong);

  useEffect(() => () => window.clearTimeout(autoNextTimer.current), []);

  async function choose(letter: string) {
    if (submitted) return;
    if (question.type === "多选") {
      setSelected(selected.includes(letter) ? selected.filter((item) => item !== letter) : [...selected, letter]);
      return;
    }
    const value = [letter];
    setSelected(value);
    await submit(value);
  }

  async function submit(valueList = selected) {
    if (!valueList.length || submitted || answering.current) return;
    answering.current = true;
    const value = [...valueList].sort().join("");
    const isCorrect = value === [...question.answer].sort().join("");
    try {
      await recordAttempt({ questionId: question.id, bankId: question.bankId, selected: value, correct: isCorrect, elapsedMs: Date.now() - startedAt });
    } catch {
      answering.current = false;
      return;
    }
    setSubmitted(true);
    if (isCorrect && question.type !== "多选" && preferences.autoNextCorrect) {
      setAutoAdvancing(true);
      autoNextTimer.current = window.setTimeout(onNext, 650);
    }
  }

  function handleTouchEnd(event: React.TouchEvent) {
    if (!preferences.swipeNavigation || !touchStart.current) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchStart.current.x;
    const dy = touch.clientY - touchStart.current.y;
    touchStart.current = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) <= Math.abs(dy)) return;
    window.clearTimeout(autoNextTimer.current);
    if (dx < 0) onNext();
    else if (index > 0) onPrevious();
  }

  return <div className="practice-layout"><section className="question-card" onTouchStart={(event) => { const touch = event.touches[0]; touchStart.current = { x: touch.clientX, y: touch.clientY }; }} onTouchEnd={handleTouchEnd}><div className="practice-head"><button className="icon-button" onClick={onExit}><X size={19} /></button><div><span>{index + 1} / {total}</span><i><b style={{ width: `${(index + 1) / total * 100}%` }} /></i></div><span className="type-chip">{question.type}</span></div>
    <div className="question-body"><div className="question-meta"><span>{question.bankName}</span>{question.tags.map((tag) => <em key={tag}>{tag}</em>)}</div><h1>{question.stem}</h1><div className="options">{question.options.map((option, optionIndex) => { const letter = String.fromCharCode(65 + optionIndex); const isAnswer = revealAnswer && question.answer.includes(letter); const isWrong = submitted && selected.includes(letter) && !question.answer.includes(letter); return <button key={letter} className={`${selected.includes(letter) ? "selected" : ""} ${isAnswer ? "right" : ""} ${isWrong ? "wrong" : ""}`} onClick={() => void choose(letter)}><span>{letter}</span><p>{option}</p>{isAnswer && <Check size={18} />}{isWrong && <X size={18} />}</button>; })}</div>
      {submitted && <div className={`result-box ${correct ? "success" : "error"}`}><strong>{correct ? (autoAdvancing ? "回答正确，即将进入下一题" : "回答正确") : "这次没有答对"}</strong>{(correct || preferences.showAnswerOnWrong) ? <p>正确答案：{question.answer}｜{answerText(question)}</p> : <p>正确答案已按配置隐藏。</p>}</div>}
      {preferences.swipeNavigation && <div className="swipe-hint"><ChevronLeft size={15} />右滑上一题 · 左滑下一题<ChevronRight size={15} /></div>}
    </div><div className="practice-actions"><button className="secondary-action" onClick={onPrevious} disabled={index === 0}><ChevronLeft size={18} />上一题</button>{question.type === "多选" && !submitted ? <button className="primary" disabled={!selected.length} onClick={() => void submit()}>确认答案</button> : submitted && !autoAdvancing ? <button className="primary" onClick={onNext}>下一题<ChevronRight size={18} /></button> : <span className="answer-action-hint">{autoAdvancing ? "正在自动前进…" : "选择答案后立即判定"}</span>}</div></section>
    <aside className="note-panel"><div><NotebookPen size={18} /><strong>我的解析</strong></div><textarea value={effectiveDraft} onChange={(event) => setDraft(event.target.value)} placeholder="写下错因、口诀或区分条件…" /><button onClick={async () => { await saveNote(question.id, effectiveDraft); setDraft(effectiveDraft); }}>保存解析</button><small>解析会和题目ID关联，并进入同步队列。</small></aside></div>;
}

function SyncView({ pending, onNotice }: { pending: number; onNotice: (message: string) => void }) {
  const [settings, setSettings] = useState<GitHubSettings>(() => {
    const defaults = { owner: "", repo: "exam-study-vault", branch: "main" };
    if (typeof window === "undefined") return defaults;
    try { return JSON.parse(localStorage.getItem("github-settings") ?? "") as GitHubSettings; } catch { return defaults; }
  });
  const [token, setToken] = useState(() => typeof window === "undefined" ? "" : sessionStorage.getItem("github-token") ?? "");
  const [syncing, setSyncing] = useState(false);
  const ready = settings.repo && token;
  async function sync() {
    if (!ready) return;
    try {
      setSyncing(true);
      const resolved = settings.owner ? settings : { ...settings, owner: await getGitHubLogin(token) };
      setSettings(resolved);
      localStorage.setItem("github-settings", JSON.stringify(resolved));
      sessionStorage.setItem("github-token", token);
      const result = await syncWithGitHub(resolved, token);
      onNotice(`同步完成：上传 ${result.pushed} 条，接收 ${result.pulled} 条`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "同步失败");
    } finally { setSyncing(false); }
  }
  return <><div className="page-heading compact"><div><p className="eyebrow">无需自建服务器</p><h1>GitHub 同步</h1><p>使用一个私有仓库保存增量记录，每台设备只写自己的目录。</p></div></div>
    <div className="settings-grid"><section className="settings-card"><div className="settings-title"><span><GitBranch /></span><div><h2>连接私有仓库</h2><p>令牌只保留在当前浏览器会话中。</p></div></div><label>仓库所有者<input value={settings.owner} onChange={(event) => setSettings({ ...settings, owner: event.target.value.trim() })} placeholder="github-username" /></label><label>仓库名称<input value={settings.repo} onChange={(event) => setSettings({ ...settings, repo: event.target.value.trim() })} placeholder="exam-study-vault" /></label><div className="field-row"><label>分支<input value={settings.branch} onChange={(event) => setSettings({ ...settings, branch: event.target.value.trim() || "main" })} /></label><label>细粒度令牌<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="github_pat_…" /></label></div><button className="primary full" disabled={!ready || syncing} onClick={sync}>{syncing ? <LoaderCircle className="spin" size={18} /> : <Cloud size={18} />}{syncing ? "正在合并…" : `立即同步${pending ? `（${pending}）` : ""}`}</button></section>
      <section className="guide-card"><span className="section-kicker">首次设置</span><h2>三步建立同步资料库</h2><ol><li><span>1</span><div><strong>新建私有仓库</strong><p>建议命名 exam-study-vault，并创建 README。</p></div></li><li><span>2</span><div><strong>创建细粒度令牌</strong><p>只授权该仓库的 Contents 读写权限。</p></div></li><li><span>3</span><div><strong>在每台设备连接</strong><p>首次拉取后，题库和学习记录会自动合并。</p></div></li></ol></section></div>
  </>;
}
