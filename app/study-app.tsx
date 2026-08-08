"use client";

import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  BookOpen, Brain, Check, ChevronLeft, ChevronRight, CircleAlert, Cloud, CloudDownload,
  CircleHelp, FileUp, GitBranch, Grid3X3, Home, Library, Link2, ListFilter,
  LoaderCircle, Menu, NotebookPen, Pencil, Play, RefreshCw, RotateCcw, Search,
  Settings2, Sparkles, Star, Target, X,
} from "lucide-react";
import { clearLegacyGeneratedTags, clearPracticeSession, db, importQuestionBank, recordAttempt, resetLocalDatabase, saveNote, savePracticeSession, toggleQuestionFavorite, updateQuestion } from "@/lib/db";
import { getGitHubLogin, syncWithGitHub, verifyGitHubVault } from "@/lib/github-sync";
import { difficultyLabel, needsWrongReview, summarizeAttempts } from "@/lib/practice-metrics";
import { PracticeSetupView } from "@/app/practice-setup";
import { QuestionEditor, type QuestionChanges } from "@/app/question-editor";
import type { GitHubSettings, PracticeAnswerState, PracticeFilter, PracticeSession, Question, QuestionType, SyncEvent } from "@/lib/types";

type View = "home" | "banks" | "wrong" | "relations" | "practiceSetup" | "preferences" | "settings" | "practice";

interface PracticePreferences {
  autoNextCorrect: boolean;
  showAnswerOnWrong: boolean;
  swipeNavigation: boolean;
  shuffleOptions: boolean;
  wrongRemovalStreak: number;
}

const DEFAULT_PREFERENCES: PracticePreferences = {
  autoNextCorrect: true,
  showAnswerOnWrong: true,
  swipeNavigation: true,
  shuffleOptions: false,
  wrongRemovalStreak: 2,
};

function loadPreferences() {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    return { ...DEFAULT_PREFERENCES, ...JSON.parse(localStorage.getItem("practice-preferences") ?? "{}") } as PracticePreferences;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function displayedAnswer(question: Question, optionOrder: number[]) {
  return question.answer
    .split("")
    .map((letter) => optionOrder.indexOf(letter.charCodeAt(0) - 65))
    .filter((index) => index >= 0)
    .map((index) => String.fromCharCode(65 + index))
    .sort()
    .join("");
}

function answerText(question: Question, optionOrder: number[]) {
  return question.answer
    .split("")
    .map((letter) => letter.charCodeAt(0) - 65)
    .map((originalIndex) => ({ originalIndex, displayIndex: optionOrder.indexOf(originalIndex) }))
    .sort((a, b) => a.displayIndex - b.displayIndex)
    .map(({ originalIndex, displayIndex }) => `${String.fromCharCode(65 + displayIndex)}. ${question.options[originalIndex] ?? ""}`)
    .join("；");
}

function formatDate(value?: string) {
  if (!value) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value));
}

function formatFullDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function shuffle<T>(values: T[]) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const modeLabels = {
  random30: "随机 30 题",
  sequential: "全量顺序练习",
  wrong: "错题模式",
  favorite: "收藏题模式",
  difficult: "难题优先",
  tag: "标签模式",
  advanced: "高级筛选",
};

const TYPE_ORDER: QuestionType[] = ["单选", "多选", "判断"];

function loadSelectedBankIds() {
  if (typeof window === "undefined") return [];
  try {
    const saved = JSON.parse(localStorage.getItem("study-current-banks") ?? "[]") as string[];
    if (Array.isArray(saved) && saved.length) return saved;
  } catch { /* use legacy selection */ }
  const legacy = localStorage.getItem("study-current-bank");
  return legacy ? [legacy] : [];
}

async function questionsInOriginalOrder(bankId: string) {
  const questions = await db.questions.where("bankId").equals(bankId).toArray();
  const events = await db.events.orderBy("createdAt").reverse().toArray();
  const imported = events.find((event) => {
    if (event.type !== "bank.imported") return false;
    const payload = event.payload as { bank?: { id?: string } };
    return payload.bank?.id === bankId;
  }) as SyncEvent | undefined;
  const payload = imported?.payload as { questions?: Question[] } | undefined;
  const order = new Map((payload?.questions ?? []).map((question, index) => [question.id, index]));
  return questions.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.normalizedStem.localeCompare(b.normalizedStem, "zh-CN"));
}

function quickFilter(mode: "random30" | "wrong", bankIds: string[]): PracticeFilter {
  return {
    bankIds,
    mode,
    types: TYPE_ORDER,
    tags: [],
    tagMatch: "any",
    status: mode === "wrong" ? "wrong" : "all",
    order: mode === "random30" ? "random" : "sequential",
    limit: mode === "random30" ? 30 : null,
    keyword: "",
    keywordMode: "plain",
    totalAttemptsMin: null,
    totalAttemptsMax: null,
    wrongAttemptsMin: null,
    wrongAttemptsMax: null,
    difficultyMin: null,
    difficultyMax: null,
    lastAttemptFrom: "",
    lastAttemptTo: "",
  };
}

export function StudyApp() {
  const [view, setView] = useState<View>("home");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [practiceSession, setPracticeSession] = useState<PracticeSession | null>(null);
  const [selectedBankIds, setSelectedBankIds] = useState<string[]>(loadSelectedBankIds);
  const [preferences, setPreferences] = useState<PracticePreferences>(loadPreferences);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { void clearLegacyGeneratedTags(); }, []);


  const banks = useLiveQuery(() => db.banks.orderBy("importedAt").reverse().toArray(), []) ?? [];
  const validSelectedBankIds = selectedBankIds.filter((id) => banks.some((bank) => bank.id === id));
  const activeBankIds = validSelectedBankIds.length ? validSelectedBankIds : banks[0] ? [banks[0].id] : [];
  const selectedBanks = banks.filter((bank) => activeBankIds.includes(bank.id));
  const savedSession = useLiveQuery(() => db.sessions.get("active"), []);
  const activeQuestionId = practiceSession?.questionIds[practiceSession.currentIndex];
  const activeQuestion = useLiveQuery(() => activeQuestionId ? db.questions.get(activeQuestionId) : undefined, [activeQuestionId]);
  const stats = useLiveQuery(async () => {
    const [questions, attemptRows, pending, notes] = await Promise.all([
      db.questions.count(), db.attempts.toArray(),
      db.events.where("synced").equals(0).count(), db.notes.count(),
    ]);
    const last = await db.attempts.orderBy("createdAt").last();
    return {
      questions,
      attempts: attemptRows.length,
      correct: attemptRows.filter((row) => row.correct).length,
      pending,
      notes,
      last: last?.createdAt,
    };
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

  function selectBanks(bankIds: string[]) {
    const unique = [...new Set(bankIds)];
    setSelectedBankIds(unique);
    localStorage.setItem("study-current-banks", JSON.stringify(unique));
  }

  function toggleBank(bankId: string) {
    const next = activeBankIds.includes(bankId)
      ? activeBankIds.length > 1 ? activeBankIds.filter((id) => id !== bankId) : activeBankIds
      : [...activeBankIds, bankId];
    selectBanks(next);
  }

  function updatePreferences(value: PracticePreferences) {
    setPreferences(value);
    localStorage.setItem("practice-preferences", JSON.stringify(value));
  }

  async function startPractice(filter: PracticeFilter) {
    const practiceBanks = banks.filter((item) => filter.bankIds.includes(item.id));
    if (!practiceBanks.length) {
      setNotice("请先选择一个题库");
      return;
    }
    let questions = (await Promise.all(filter.bankIds.map((bankId) => questionsInOriginalOrder(bankId)))).flat();
    questions = questions.filter((question) => filter.types.includes(question.type));
    if (filter.tags.length) questions = questions.filter((question) => filter.tagMatch === "all"
      ? filter.tags.every((tag) => question.tags.includes(tag))
      : filter.tags.some((tag) => question.tags.includes(tag)));
    if (filter.keyword.trim()) {
      const keyword = filter.keyword.trim();
      let pattern: RegExp | null = null;
      if (filter.keywordMode === "regex") {
        try { pattern = new RegExp(keyword, "i"); } catch { setNotice("正则表达式格式不正确，请检查后重试"); return; }
      }
      questions = questions.filter((question) => {
        const searchable = [question.stem, ...question.options, ...question.tags].join("\n");
        return pattern ? pattern.test(searchable) : searchable.toLocaleLowerCase("zh-CN").includes(keyword.toLocaleLowerCase("zh-CN"));
      });
    }
    const attempts = (await Promise.all(filter.bankIds.map((bankId) => db.attempts.where("bankId").equals(bankId).toArray()))).flat();
    const attemptsByQuestion = new Map<string, typeof attempts>();
    attempts.forEach((attempt) => {
      const rows = attemptsByQuestion.get(attempt.questionId) ?? [];
      rows.push(attempt);
      attemptsByQuestion.set(attempt.questionId, rows);
    });
    const attemptStats = new Map([...attemptsByQuestion].map(([questionId, rows]) => [questionId, summarizeAttempts(rows)]));
    const lastAttemptFrom = filter.lastAttemptFrom ? new Date(`${filter.lastAttemptFrom}T00:00:00`).getTime() : null;
    const lastAttemptTo = filter.lastAttemptTo ? new Date(`${filter.lastAttemptTo}T23:59:59.999`).getTime() : null;
    questions = questions.filter((question) => {
      const rows = attemptsByQuestion.get(question.id) ?? [];
      const metric = attemptStats.get(question.id) ?? summarizeAttempts([]);
      if (filter.status === "unanswered" && metric.total !== 0) return false;
      if (filter.status === "wrong" && !needsWrongReview(rows, preferences.wrongRemovalStreak)) return false;
      if (filter.status === "favorite" && !question.favorite) return false;
      if (filter.totalAttemptsMin !== null && metric.total < filter.totalAttemptsMin) return false;
      if (filter.totalAttemptsMax !== null && metric.total > filter.totalAttemptsMax) return false;
      if (filter.wrongAttemptsMin !== null && metric.wrong < filter.wrongAttemptsMin) return false;
      if (filter.wrongAttemptsMax !== null && metric.wrong > filter.wrongAttemptsMax) return false;
      if (filter.difficultyMin !== null && metric.difficulty < filter.difficultyMin) return false;
      if (filter.difficultyMax !== null && metric.difficulty > filter.difficultyMax) return false;
      if ((lastAttemptFrom !== null || lastAttemptTo !== null) && metric.latest === null) return false;
      if (lastAttemptFrom !== null && metric.latest !== null && metric.latest < lastAttemptFrom) return false;
      if (lastAttemptTo !== null && metric.latest !== null && metric.latest > lastAttemptTo) return false;
      return true;
    });
    let limitApplied = false;
    if (filter.order === "random") {
      questions = shuffle(questions);
      if (filter.limit) {
        questions = questions.slice(0, filter.limit);
        limitApplied = true;
      }
    }
    questions = TYPE_ORDER.flatMap((type) => {
      const group = questions.filter((question) => question.type === type);
      if (filter.order === "random") return shuffle(group);
      if (filter.order === "difficulty") return group.sort((a, b) => (attemptStats.get(b.id)?.difficulty ?? 50) - (attemptStats.get(a.id)?.difficulty ?? 50));
      return group;
    });
    if (filter.limit && !limitApplied) questions = questions.slice(0, filter.limit);
    if (!questions.length) {
      setNotice("没有符合当前条件的题目，请调整筛选条件");
      return;
    }
    const now = new Date().toISOString();
    const session: PracticeSession = {
      id: "active",
      runId: crypto.randomUUID(),
      bankId: practiceBanks[0].id,
      bankIds: practiceBanks.map((bank) => bank.id),
      bankName: practiceBanks.length === 1 ? practiceBanks[0].name : `${practiceBanks.length} 个题库组合`,
      mode: filter.mode,
      modeLabel: modeLabels[filter.mode],
      questionIds: questions.map((question) => question.id),
      questionTypes: Object.fromEntries(questions.map((question) => [question.id, question.type])),
      currentIndex: 0,
      answers: {},
      shuffleOptions: preferences.shuffleOptions,
      optionOrders: preferences.shuffleOptions ? Object.fromEntries(questions.map((question) => [
        question.id,
        question.type === "判断"
          ? question.options.map((_, index) => index)
          : shuffle(question.options.map((_, index) => index)),
      ])) : {},
      startedAt: now,
      updatedAt: now,
      revision: 1,
    };
    await savePracticeSession(session);
    setPracticeSession(session);
    setView("practice");
  }

  async function startSearchPractice(questions: Question[], questionId: string) {
    const practiceBanks = banks.filter((bank) => questions.some((question) => question.bankId === bank.id));
    if (!questions.length || !practiceBanks.length) return;
    const now = new Date().toISOString();
    const session: PracticeSession = {
      id: "active",
      runId: crypto.randomUUID(),
      bankId: practiceBanks[0].id,
      bankIds: practiceBanks.map((bank) => bank.id),
      bankName: practiceBanks.length === 1 ? practiceBanks[0].name : `${practiceBanks.length} 个题库组合`,
      mode: "advanced",
      modeLabel: `搜索“${query.trim()}”`,
      questionIds: questions.map((question) => question.id),
      questionTypes: Object.fromEntries(questions.map((question) => [question.id, question.type])),
      currentIndex: Math.max(0, questions.findIndex((question) => question.id === questionId)),
      answers: {},
      shuffleOptions: preferences.shuffleOptions,
      optionOrders: preferences.shuffleOptions ? Object.fromEntries(questions.map((question) => [
        question.id,
        question.type === "判断"
          ? question.options.map((_, index) => index)
          : shuffle(question.options.map((_, index) => index)),
      ])) : {},
      startedAt: now,
      updatedAt: now,
      revision: 1,
    };
    await savePracticeSession(session);
    setPracticeSession(session);
    setQuery("");
    setView("practice");
  }

  function changeSession(mutator: (session: PracticeSession) => PracticeSession) {
    setPracticeSession((current) => {
      if (!current) return current;
      const changed = mutator(current);
      const next = { ...changed, updatedAt: new Date().toISOString(), revision: current.revision + 1 };
      void savePracticeSession(next);
      return next;
    });
  }

  async function resumePractice() {
    if (!savedSession?.questionIds.length) return;
    let session = savedSession;
    if (!session.questionTypes || Object.keys(session.questionTypes).length !== session.questionIds.length) {
      const questions = await db.questions.bulkGet(session.questionIds);
      session = {
        ...session,
        questionTypes: Object.fromEntries(questions.filter(Boolean).map((question) => [question!.id, question!.type])),
        updatedAt: new Date().toISOString(),
        revision: session.revision + 1,
      };
      await savePracticeSession(session);
    }
    setPracticeSession(session);
    selectBanks(session.bankIds?.length ? session.bankIds : [session.bankId]);
    setView("practice");
  }

  function movePractice(offset: number) {
    if (!practiceSession) return;
    const nextIndex = practiceSession.currentIndex + offset;
    if (nextIndex >= practiceSession.questionIds.length) {
      void clearPracticeSession();
      setPracticeSession(null);
      setNotice("本次练习已完成");
      setView("home");
      return;
    }
    if (nextIndex < 0) return;
    changeSession((session) => ({ ...session, currentIndex: nextIndex }));
  }

  function saveAnswerState(questionId: string, answerState: PracticeAnswerState) {
    changeSession((session) => ({ ...session, answers: { ...session.answers, [questionId]: answerState } }));
  }

  function jumpPractice(index: number) {
    if (!practiceSession || index < 0 || index >= practiceSession.questionIds.length) return;
    changeSession((session) => ({ ...session, currentIndex: index }));
  }

  const navItems = [
    { id: "home" as const, label: "今日", icon: Home },
    { id: "banks" as const, label: "题库", icon: Library },
    { id: "wrong" as const, label: "错题", icon: RotateCcw },
    { id: "practiceSetup" as const, label: "练习", icon: ListFilter },
    { id: "relations" as const, label: "关联", icon: Link2 },
    { id: "preferences" as const, label: "配置", icon: Settings2 },
    { id: "settings" as const, label: "同步", icon: Cloud },
  ];

  return (
    <main className="app-shell">
      <PullToRefresh />
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
      <button className={`sidebar-backdrop ${sidebarOpen ? "visible" : ""}`} aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />

      <section className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={20} /></button>
          <div className="searchbox"><Search size={17} /><input aria-label="搜索题目、选项、标签或解析" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} placeholder="搜索题目、知识点或解析" />{query && <button className="search-clear" aria-label="清除搜索" onClick={() => setQuery("")}><X size={15} /></button>}<SearchResults query={query} bankIds={activeBankIds} onChoose={(questions, questionId) => void startSearchPractice(questions, questionId)} /></div>
          <button className="sync-pill" onClick={() => setView("settings")}><Cloud size={16} />{stats.pending ? `待同步 ${stats.pending}` : "已保存"}</button>
          <button className="avatar" aria-label="个人设置">Y</button>
        </header>

        {notice && <div className="toast"><Sparkles size={16} /><span>{notice}</span><button onClick={() => setNotice("")}><X size={15} /></button></div>}
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(event) => onImport(event.target.files?.[0])} />

        <div className="content">
          {view === "home" && <Dashboard stats={stats} banks={banks} savedSession={savedSession} selectedBankIds={activeBankIds} onBankToggle={toggleBank} onImport={() => fileRef.current?.click()} onStart={() => activeBankIds.length && void startPractice(quickFilter("random30", activeBankIds))} onResume={resumePractice} onMoreModes={() => setView("practiceSetup")} />}
          {view === "banks" && <BanksView banks={banks} selectedBankIds={activeBankIds} onImport={() => fileRef.current?.click()} onStart={(bankId) => { selectBanks([bankId]); void startPractice(quickFilter("random30", [bankId])); }} />}
          {view === "wrong" && <WrongView bankIds={activeBankIds} bankName={selectedBanks.length === 1 ? selectedBanks[0].name : `${selectedBanks.length} 个题库`} wrongRemovalStreak={preferences.wrongRemovalStreak} onStart={() => activeBankIds.length && void startPractice(quickFilter("wrong", activeBankIds))} />}
          {view === "practiceSetup" && <PracticeSetupView banks={banks} currentBankIds={activeBankIds} onBankChange={selectBanks} onStart={(filter) => void startPractice(filter)} />}
          {view === "relations" && <RelationsView />}
          {view === "preferences" && <PreferencesView preferences={preferences} onChange={updatePreferences} />}
          {view === "settings" && <SyncView pending={stats.pending} onNotice={setNotice} />}
          {view === "practice" && practiceSession && activeQuestion && (
            <Practice key={activeQuestion.id} question={activeQuestion} initialState={practiceSession.answers[activeQuestion.id]} optionOrder={practiceSession.optionOrders?.[activeQuestion.id]} questionIds={practiceSession.questionIds} questionTypes={practiceSession.questionTypes ?? {}} answers={practiceSession.answers} index={practiceSession.currentIndex} total={practiceSession.questionIds.length} modeLabel={practiceSession.modeLabel} preferences={preferences} onStateChange={(state) => saveAnswerState(activeQuestion.id, state)} onJump={jumpPractice} onFavorite={async () => { const updated = await toggleQuestionFavorite(activeQuestion.id); setNotice(updated.favorite ? "已收藏这道题" : "已取消收藏"); }} onEdit={async (changes) => { await updateQuestion(activeQuestion.id, changes); setNotice("题目和标签已保存，并加入同步队列"); }} onExit={() => { setPracticeSession(null); setView("home"); }} onPrevious={() => movePractice(-1)} onNext={() => movePractice(1)} />
          )}
        </div>
      </section>
    </main>
  );
}

function SearchResults({ query, bankIds, onChoose }: { query: string; bankIds: string[]; onChoose: (questions: Question[], questionId: string) => void }) {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const bankKey = bankIds.join("|");
  const results = useLiveQuery(async () => {
    if (!normalizedQuery || !bankIds.length) return [];
    const [questions, notes] = await Promise.all([
      Promise.all(bankIds.map((bankId) => db.questions.where("bankId").equals(bankId).toArray())).then((rows) => rows.flat()),
      db.notes.toArray(),
    ]);
    const notesByQuestion = new Map(notes.map((note) => [note.questionId, note.content]));
    return questions.filter((question) => [
      question.stem,
      ...question.options,
      ...question.tags,
      notesByQuestion.get(question.id) ?? "",
    ].join("\n").toLocaleLowerCase("zh-CN").includes(normalizedQuery)).slice(0, 30);
  }, [normalizedQuery, bankKey]);

  if (!normalizedQuery) return null;
  if (results === undefined) return <section className="search-results"><div className="search-state"><LoaderCircle className="spin" size={17} />正在搜索…</div></section>;
  return <section className="search-results" aria-label="搜索结果">
    <header><strong>搜索结果</strong><span>{results.length ? `显示 ${results.length} 道匹配题目` : "没有匹配题目"}</span></header>
    {results.length ? <div>{results.map((question) => <button key={question.id} onClick={() => onChoose(results, question.id)}><span className="search-type">{question.type}</span><span><strong>{question.stem}</strong><small>{question.bankName}{question.tags.length ? ` · ${question.tags.join("、")}` : ""}</small></span><ChevronRight size={16} /></button>)}</div> : <div className="search-state">试试更短的关键词，搜索范围为首页已选题库。</div>}
  </section>;
}

function PullToRefresh() {
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const currentDistance = useRef(0);

  useEffect(() => {
    const onStart = (event: TouchEvent) => {
      if (window.scrollY > 0 || event.touches.length !== 1) return;
      start.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    };
    const onMove = (event: TouchEvent) => {
      if (!start.current || window.scrollY > 0) return;
      const dx = event.touches[0].clientX - start.current.x;
      const dy = event.touches[0].clientY - start.current.y;
      if (dy <= 0 || Math.abs(dx) >= dy) return;
      const next = Math.min(110, dy * .48);
      currentDistance.current = next;
      setDistance(next);
    };
    const onEnd = async () => {
      start.current = null;
      if (currentDistance.current < 72 || refreshing) {
        currentDistance.current = 0;
        setDistance(0);
        return;
      }
      setRefreshing(true);
      setDistance(52);
      try {
        const registration = await navigator.serviceWorker?.getRegistration();
        await registration?.update();
        if ("caches" in window) {
          const keys = await caches.keys();
          await Promise.all(keys.filter((key) => key.startsWith("shijuan-")).map((key) => caches.delete(key)));
        }
      } finally {
        window.location.reload();
      }
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
    };
  }, [refreshing]);

  return <div className={`pull-refresh ${refreshing ? "refreshing" : ""}`} style={{ transform: `translate(-50%, ${distance - 54}px)`, opacity: distance ? 1 : 0 }}><RefreshCw size={17} /><span>{refreshing ? "正在加载最新版…" : distance >= 72 ? "松开刷新" : "下拉刷新"}</span></div>;
}

function Dashboard({ stats, banks, savedSession, selectedBankIds, onBankToggle, onImport, onStart, onResume, onMoreModes }: {
  stats: { questions: number; attempts: number; correct: number; pending: number; notes: number; last?: string };
  banks: Array<{ id: string; name: string; questionCount: number }>;
  savedSession?: PracticeSession;
  selectedBankIds: string[];
  onBankToggle: (bankId: string) => void;
  onImport: () => void; onStart: () => void; onResume: () => void; onMoreModes: () => void;
}) {
  const accuracy = stats.attempts ? Math.round(stats.correct / stats.attempts * 100) : 0;
  const selectedBanks = banks.filter((bank) => selectedBankIds.includes(bank.id));
  const selectedQuestions = selectedBanks.reduce((total, bank) => total + bank.questionCount, 0);
  const answeredInSession = savedSession ? Object.values(savedSession.answers).filter((answer) => answer.submitted).length : 0;
  return <>
    <div className="home-heading"><p className="eyebrow">今天也向前一点</p><h1>把知识，练成下意识。</h1><p>自由组合题库，记录每一次选择，随时从中断处继续。</p></div>
    {banks.length ? <section className="home-bank-scope"><div className="scope-heading"><div><span className="section-kicker">当前题库范围</span><h2>选择一个或多个题库</h2></div><small>至少保留一个</small></div><div className="home-bank-grid">{banks.map((bank) => { const selected = selectedBankIds.includes(bank.id); return <button key={bank.id} aria-pressed={selected} className={selected ? "selected" : ""} onClick={() => onBankToggle(bank.id)}><span className="scope-check">{selected && <Check size={14} />}</span><div><strong>{bank.name}</strong><small>{bank.questionCount.toLocaleString()} 题</small></div></button>; })}</div><div className="scope-footer"><p>已选择 <strong>{selectedBanks.length}</strong> 个题库，共 <strong>{selectedQuestions.toLocaleString()}</strong> 题</p><button className="primary" onClick={onStart}><Brain size={18} />开始随机 30 题</button></div></section> : <EmptyImport onImport={onImport} />}
    {savedSession && <section className="resume-card"><span><Play size={20} /></span><div><small>上次练习 · {savedSession.modeLabel}</small><strong>{savedSession.bankName}</strong><p>停在第 {savedSession.currentIndex + 1} / {savedSession.questionIds.length} 题，已作答 {answeredInSession} 题</p></div><button onClick={onResume}>继续练习<ChevronRight size={17} /></button></section>}
    <section className="home-feature-grid">
      <article className="daily-practice"><div><span className="section-kicker">今日推荐</span><h2>来一组 30 题</h2><p>从已选题库随机抽题，再按单选、多选、判断分组。</p><div><button onClick={onStart}>开始这一组<ChevronRight size={17} /></button><button className="feature-secondary" onClick={onMoreModes}><ListFilter size={16} />更多练习模式</button></div></div><span className="daily-number"><strong>30</strong><small>题</small></span></article>
      <article className="memory-card"><span>记忆提示</span><blockquote>“先遮住答案，努力回忆，再用反馈纠正。”</blockquote><small>主动回忆比重复阅读更可靠</small></article>
    </section>
    <section className="stat-grid">
      <Stat icon={<BookOpen />} label="题目总数" value={stats.questions.toLocaleString()} foot={`${banks.length} 个题库`} />
      <Stat icon={<Target />} label="累计作答" value={stats.attempts.toLocaleString()} foot={`最近：${formatDate(stats.last)}`} />
      <Stat icon={<Check />} label="正确率" value={`${accuracy}%`} foot={stats.attempts ? `${stats.correct} 次答对` : "等待第一次作答"} />
      <Stat icon={<NotebookPen />} label="个人解析" value={stats.notes.toLocaleString()} foot="沉淀自己的记忆钩子" />
    </section>
    <section className="section-block"><div className="section-title"><div><span className="section-kicker">题库管理</span><h2>继续扩充你的练习范围</h2></div><button className="text-button" onClick={onImport}><FileUp size={16} />导入题库</button></div></section>
  </>;
}

function Stat({ icon, label, value, foot }: { icon: React.ReactNode; label: string; value: string; foot: string }) {
  return <article className="stat-card"><span className="stat-icon">{icon}</span><span>{label}</span><strong>{value}</strong><small>{foot}</small></article>;
}

function EmptyImport({ onImport }: { onImport: () => void }) {
  return <button className="empty-import" onClick={onImport}><span><FileUp size={22} /></span><div><strong>导入 JSON 题库</strong><small>数据直接写入本机，不经过第三方服务器</small></div><ChevronRight size={18} /></button>;
}

function BanksView({ banks, selectedBankIds, onImport, onStart }: { banks: Array<{ id: string; name: string; questionCount: number; importedAt: string }>; selectedBankIds: string[]; onImport: () => void; onStart: (bankId: string) => void }) {
  return <><div className="page-heading compact"><div><p className="eyebrow">我的资料</p><h1>题库</h1><p>导入、版本化并随时开始一组练习。</p></div><button className="primary" onClick={onImport}><FileUp size={18} />导入题库</button></div>
    {banks.length ? <div className="library-grid">{banks.map((bank, index) => { const selected = selectedBankIds.includes(bank.id); return <article className={`library-card ${selected ? "current" : ""}`} key={bank.id}><span className={`bank-icon large tone-${index % 3}`}><Library size={22} /></span><span className="bank-ready">{selected ? "已选范围" : "本地可用"}</span><h2>{bank.name}</h2><p>{bank.questionCount.toLocaleString()} 道题 · 导入时间：{formatFullDate(bank.importedAt)}</p><button onClick={() => onStart(bank.id)}>仅练此题库<ChevronRight size={17} /></button></article>; })}</div> : <EmptyImport onImport={onImport} />}
  </>;
}

function WrongView({ bankIds, bankName, wrongRemovalStreak, onStart }: { bankIds: string[]; bankName?: string; wrongRemovalStreak: number; onStart: () => void }) {
  const bankKey = bankIds.join("|");
  const count = useLiveQuery(async () => {
    const allRows = (await Promise.all(bankIds.map((bankId) => db.attempts.where("bankId").equals(bankId).toArray()))).flat();
    const rowsByQuestion = new Map<string, typeof allRows>();
    allRows.forEach((row) => {
      const questionRows = rowsByQuestion.get(row.questionId);
      if (questionRows) questionRows.push(row);
      else rowsByQuestion.set(row.questionId, [row]);
    });
    return [...rowsByQuestion.values()].filter((rows) => rows.some((row) => !row.correct) && needsWrongReview(rows, wrongRemovalStreak)).length;
  }, [bankKey, wrongRemovalStreak]) ?? 0;
  return <div className="center-panel"><span className="center-icon warning"><CircleAlert /></span><p className="eyebrow">错题回炉 · {bankName ?? "已选题库"}</p><h1>{count ? `${count} 道题等你攻克` : "已选题库还没有错题"}</h1><p>{count ? `连续答对 ${wrongRemovalStreak} 次后自动移出错题。` : "每次作答都会自动记录，不会和答错的题会出现在这里。"}</p><button className="primary" onClick={onStart} disabled={!count}><RotateCcw size={18} />开始错题练习</button></div>;
}

function RelationsView() {
  const tags = useLiveQuery(async () => {
    const questions = await db.questions.toArray();
    const counts = new Map<string, number>();
    questions.flatMap((question) => question.tags).forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, []) ?? [];
  return <><div className="page-heading compact"><div><p className="eyebrow">知识网络</p><h1>题目关联</h1><p>先按知识点聚合，再逐步标记易混、相似和前置关系。</p></div></div>
    <div className="topic-grid">{tags.length ? tags.map(([tag, count], index) => <article key={tag}><span>{String(index + 1).padStart(2, "0")}</span><h2>{tag}</h2><p>{count} 道相关题</p><div className="topic-line"><i style={{ width: `${Math.min(100, 25 + count)}%` }} /></div></article>) : <div className="center-panel small"><Link2 /><h2>还没有用户标签</h2><p>练习时编辑题目并添加标签，就能在这里形成知识点索引。</p></div>}</div>
  </>;
}

function PreferencesView({ preferences, onChange }: { preferences: PracticePreferences; onChange: (value: PracticePreferences) => void }) {
  const items: Array<{ key: "autoNextCorrect" | "showAnswerOnWrong" | "swipeNavigation" | "shuffleOptions"; title: string; detail: string }> = [
    { key: "autoNextCorrect", title: "答对后自动下一题", detail: "单选题和判断题选对后自动前进；多选题确认答案正确后自动前进。" },
    { key: "showAnswerOnWrong", title: "答错显示正确答案", detail: "立即标出错误选项和正确选项，方便当场纠正记忆。" },
    { key: "swipeNavigation", title: "左右滑动切换题目", detail: "向左滑进入下一题，向右滑返回上一题。" },
    { key: "shuffleOptions", title: "随机排列选项", detail: "仅随机单选题和多选题；判断题始终保持“正确、错误”。" },
  ];
  return <><div className="page-heading compact"><div><p className="eyebrow">练习偏好</p><h1>答题配置</h1><p>设置只保存在当前浏览器，不会修改题库内容。</p></div></div>
    <section className="preference-card"><div className="settings-title"><span><Settings2 /></span><div><h2>答题交互</h2><p>根据自己的背题节奏随时调整。</p></div></div>
      <div className="preference-list">{items.map((item) => <label aria-label={item.title} className="preference-row" key={item.key}><div><strong>{item.title}</strong><p>{item.detail}</p></div><input aria-label={item.title} type="checkbox" checked={preferences[item.key]} onChange={(event) => onChange({ ...preferences, [item.key]: event.target.checked })} /><span className="toggle" aria-hidden="true" /></label>)}<label className="preference-row streak-preference"><div><strong>连续答对后移出错题</strong><p>题目答错或选择“不会”后进入错题；达到连续正确次数后自动移除。</p></div><select aria-label="连续答对后移出错题" value={preferences.wrongRemovalStreak} onChange={(event) => onChange({ ...preferences, wrongRemovalStreak: Number(event.target.value) })}><option value="1">1 次</option><option value="2">2 次</option><option value="3">3 次</option><option value="5">5 次</option></select></label></div>
    </section>
    <section className="gesture-guide"><span><ChevronLeft size={19} />右滑</span><p>上一题</p><i /><p>下一题</p><span>左滑<ChevronRight size={19} /></span></section>
  </>;
}

function Practice({ question, initialState, optionOrder, questionIds, questionTypes, answers, index, total, modeLabel, preferences, onStateChange, onJump, onFavorite, onEdit, onPrevious, onNext, onExit }: { question: Question; initialState?: PracticeAnswerState; optionOrder?: number[]; questionIds: string[]; questionTypes: Record<string, QuestionType>; answers: Record<string, PracticeAnswerState>; index: number; total: number; modeLabel: string; preferences: PracticePreferences; onStateChange: (state: PracticeAnswerState) => void; onJump: (index: number) => void; onFavorite: () => Promise<void>; onEdit: (changes: QuestionChanges) => Promise<void>; onPrevious: () => void; onNext: () => void; onExit: () => void }) {
  const [selected, setSelected] = useState<string[]>(initialState?.selected ?? []);
  const [submitted, setSubmitted] = useState(initialState?.submitted ?? false);
  const [autoAdvancing, setAutoAdvancing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [startedAt] = useState(() => Date.now());
  const note = useLiveQuery(() => db.notes.get(question.id), [question.id]);
  const attemptSummary = useLiveQuery(async () => summarizeAttempts(await db.attempts.where("questionId").equals(question.id).toArray()), [question.id]) ?? summarizeAttempts([]);
  const [draft, setDraft] = useState<string | null>(null);
  const autoNextTimer = useRef<number | undefined>(undefined);
  const answering = useRef(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const effectiveDraft = draft ?? note?.content ?? "";
  const displayOrder = optionOrder?.length === question.options.length ? optionOrder : question.options.map((_, optionIndex) => optionIndex);
  const displayAnswer = displayedAnswer(question, displayOrder);
  const selectedAnswer = [...selected].sort().join("");
  const correct = submitted && selectedAnswer === [...question.answer].sort().join("");
  const gaveUp = submitted && selected.length === 0;
  const revealAnswer = submitted && (correct || preferences.showAnswerOnWrong);

  useEffect(() => () => window.clearTimeout(autoNextTimer.current), []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isEditingText = target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      if (editing || overviewOpen || isEditingText) return;
      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        window.clearTimeout(autoNextTimer.current);
        onPrevious();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        window.clearTimeout(autoNextTimer.current);
        onNext();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editing, overviewOpen, index, onNext, onPrevious]);

  async function choose(letter: string) {
    if (submitted) return;
    if (question.type === "多选") {
      const next = selected.includes(letter) ? selected.filter((item) => item !== letter) : [...selected, letter];
      setSelected(next);
      onStateChange({ selected: next, submitted: false });
      return;
    }
    const value = [letter];
    setSelected(value);
    onStateChange({ selected: value, submitted: false });
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
    onStateChange({ selected: valueList, submitted: true, correct: isCorrect });
    if (isCorrect && preferences.autoNextCorrect) {
      setAutoAdvancing(true);
      autoNextTimer.current = window.setTimeout(onNext, 650);
    }
  }

  async function giveUp() {
    if (submitted || answering.current) return;
    answering.current = true;
    try {
      await recordAttempt({ questionId: question.id, bankId: question.bankId, selected: "", correct: false, elapsedMs: Date.now() - startedAt });
    } catch {
      answering.current = false;
      return;
    }
    setSelected([]);
    setSubmitted(true);
    onStateChange({ selected: [], submitted: true, correct: false });
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

  return <><div className="practice-layout"><section className="question-card" onTouchStart={(event) => { const touch = event.touches[0]; touchStart.current = { x: touch.clientX, y: touch.clientY }; }} onTouchEnd={handleTouchEnd}><div className="practice-head"><button className="icon-button" aria-label="暂停并返回首页" onClick={onExit}><X size={19} /></button><div className="practice-progress"><span>{index + 1} / {total} · {modeLabel}</span><i><b style={{ width: `${(index + 1) / total * 100}%` }} /></i></div><div className="practice-head-actions"><span className="type-chip">{question.type}</span><button className="icon-button overview-trigger" aria-label="打开题目总览" onClick={() => setOverviewOpen(true)}><Grid3X3 size={18} /></button></div></div>
    <div className="question-body"><div className="question-meta"><span>{question.bankName}</span><em className="difficulty-chip">难度 {attemptSummary.difficulty} · {difficultyLabel(attemptSummary.difficulty)}</em>{question.tags.map((tag) => <em key={tag}>{tag}</em>)}<button className={`favorite-question ${question.favorite ? "active" : ""}`} aria-label={question.favorite ? "取消收藏" : "收藏题目"} aria-pressed={Boolean(question.favorite)} onClick={() => void onFavorite()}><Star size={14} fill={question.favorite ? "currentColor" : "none"} />{question.favorite ? "已收藏" : "收藏"}</button><button className="edit-question-link" onClick={() => setEditing(true)}><Pencil size={13} />编辑题目</button></div><h1>{question.stem}</h1><div className="options">{displayOrder.map((originalIndex, displayIndex) => { const option = question.options[originalIndex]; const originalLetter = String.fromCharCode(65 + originalIndex); const displayLetter = String.fromCharCode(65 + displayIndex); const isAnswer = revealAnswer && question.answer.includes(originalLetter); const isWrong = submitted && selected.includes(originalLetter) && !question.answer.includes(originalLetter); return <button key={originalLetter} className={`${selected.includes(originalLetter) ? "selected" : ""} ${isAnswer ? "right" : ""} ${isWrong ? "wrong" : ""}`} onClick={() => void choose(originalLetter)}><span>{displayLetter}</span><p>{option}</p>{isAnswer && <Check size={18} />}{isWrong && <X size={18} />}</button>; })}</div>
      {submitted && <><div className={`result-box ${correct ? "success" : "error"}`}><strong>{correct ? (autoAdvancing ? "回答正确，即将进入下一题" : "回答正确") : gaveUp ? "已标记为不会，并计入错题" : "这次没有答对"}</strong>{(correct || preferences.showAnswerOnWrong) ? <p>正确答案：{displayAnswer}｜{answerText(question, displayOrder)}</p> : <p>正确答案已按配置隐藏。</p>}</div><div className="attempt-summary"><span><strong>{attemptSummary.total}</strong>总作答</span><span className="correct"><strong>{attemptSummary.correct}</strong>正确</span><span className="wrong"><strong>{attemptSummary.wrong}</strong>错误</span><span className={`difficulty difficulty-${difficultyLabel(attemptSummary.difficulty)}`}><strong>{attemptSummary.difficulty}</strong>难度 · {difficultyLabel(attemptSummary.difficulty)}</span></div></>}
      {preferences.swipeNavigation && <div className="swipe-hint"><ChevronLeft size={15} />右滑上一题 · 左滑下一题<ChevronRight size={15} /></div>}
    </div><div className="practice-actions"><button className="secondary-action" onClick={onPrevious} disabled={index === 0}><ChevronLeft size={18} />上一题</button><div>{!submitted && <button className="dont-know-action" onClick={() => void giveUp()}><CircleHelp size={17} />不会</button>}{!submitted && question.type !== "多选" && <span className="answer-action-hint">选择答案后立即判定</span>}{question.type === "多选" && !submitted && <button className="primary" disabled={!selected.length} onClick={() => void submit()}>确认答案</button>}{autoAdvancing ? <span className="answer-action-hint">正在自动前进…</span> : <button className={submitted ? "primary" : "secondary-action"} onClick={onNext}>{submitted ? "下一题" : "跳过 / 下一题"}<ChevronRight size={18} /></button>}</div></div></section>
    <aside className="note-panel"><div><NotebookPen size={18} /><strong>我的解析</strong></div><textarea value={effectiveDraft} onChange={(event) => setDraft(event.target.value)} placeholder="写下错因、口诀或区分条件…" /><button onClick={async () => { await saveNote(question.id, effectiveDraft); setDraft(effectiveDraft); }}>保存解析</button><button className="edit-question-button" onClick={() => setEditing(true)}><Pencil size={15} />编辑题目与标签</button><small>关闭练习后可从首页继续，选项和当前进度都会保留。</small></aside></div>{overviewOpen && <QuestionOverview questionIds={questionIds} questionTypes={questionTypes} answers={answers} currentIndex={index} onClose={() => setOverviewOpen(false)} onJump={(target) => { window.clearTimeout(autoNextTimer.current); onJump(target); setOverviewOpen(false); }} />}{editing && <QuestionEditor question={question} onCancel={() => setEditing(false)} onSave={async (changes) => { await onEdit(changes); setEditing(false); }} />}</>;
}

function QuestionOverview({ questionIds, questionTypes, answers, currentIndex, onClose, onJump }: { questionIds: string[]; questionTypes: Record<string, QuestionType>; answers: Record<string, PracticeAnswerState>; currentIndex: number; onClose: () => void; onJump: (index: number) => void }) {
  const answered = Object.values(answers).filter((answer) => answer.submitted).length;
  return <div className="overview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="question-overview" role="dialog" aria-modal="true" aria-label="题目总览"><header><div><span className="section-kicker">练习导航</span><h2>题目总览</h2><p>已作答 {answered} / {questionIds.length}，点击题号快速切换。</p></div><button className="icon-button" aria-label="关闭题目总览" onClick={onClose}><X size={19} /></button></header><div className="overview-legend"><span><i className="correct" />正确</span><span><i className="wrong" />错误</span><span><i className="pending" />已选择</span><span><i />未作答</span></div><div className="overview-groups">{TYPE_ORDER.map((type) => { const group = questionIds.map((id, questionIndex) => ({ id, questionIndex })).filter(({ id }) => questionTypes[id] === type); return <section className="overview-group" key={type}><div><h3>{type}</h3><span>{group.length} 题</span></div>{group.length ? <div className="overview-number-grid">{group.map(({ id, questionIndex }) => { const answer = answers[id]; const state = answer?.submitted ? answer.correct ? "correct" : "wrong" : answer?.selected.length ? "pending" : "blank"; return <button key={id} className={`${state} ${questionIndex === currentIndex ? "current" : ""}`} aria-label={`第 ${questionIndex + 1} 题，${type}`} aria-current={questionIndex === currentIndex ? "true" : undefined} onClick={() => onJump(questionIndex)}>{questionIndex + 1}</button>; })}</div> : <p className="overview-empty">本次练习没有{type}题</p>}</section>; })}</div></section></div>;
}

function SyncView({ pending, onNotice }: { pending: number; onNotice: (message: string) => void }) {
  const [settings, setSettings] = useState<GitHubSettings>(() => {
    const defaults = { owner: "", repo: "exam-study-vault", branch: "main" };
    if (typeof window === "undefined") return defaults;
    try { return JSON.parse(localStorage.getItem("github-settings") ?? "") as GitHubSettings; } catch { return defaults; }
  });
  const [token, setToken] = useState(() => typeof window === "undefined" ? "" : sessionStorage.getItem("github-token") ?? "");
  const [syncing, setSyncing] = useState(false);
  const [restoring, setRestoring] = useState(false);
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
  async function restoreFromRemote() {
    if (!ready || restoring) return;
    if (!window.confirm("这会永久丢弃当前浏览器中的题库、作答记录、解析、标签和未同步更改，然后仅用 GitHub 远程数据重建。确定继续吗？")) return;
    try {
      setRestoring(true);
      const resolved = settings.owner ? settings : { ...settings, owner: await getGitHubLogin(token) };
      const remoteFiles = await verifyGitHubVault(resolved, token);
      if (!remoteFiles) throw new Error("远程仓库中没有可恢复的同步记录，已保留本地数据。");
      setSettings(resolved);
      localStorage.setItem("github-settings", JSON.stringify(resolved));
      sessionStorage.setItem("github-token", token);
      await resetLocalDatabase();
      const result = await syncWithGitHub(resolved, token);
      localStorage.removeItem("study-current-bank");
      localStorage.removeItem("study-current-banks");
      window.alert(`恢复完成：从远程应用 ${result.pulled} 条记录。页面将重新载入。`);
      window.location.reload();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "远程恢复失败");
      setRestoring(false);
    }
  }
  return <><div className="page-heading compact"><div><p className="eyebrow">无需自建服务器</p><h1>GitHub 同步</h1><p>使用一个私有仓库保存增量记录，每台设备只写自己的目录。</p></div></div>
    <div className="settings-grid"><section className="settings-card"><div className="settings-title"><span><GitBranch /></span><div><h2>连接私有仓库</h2><p>令牌只保留在当前浏览器会话中。</p></div></div><label>仓库所有者<input value={settings.owner} onChange={(event) => setSettings({ ...settings, owner: event.target.value.trim() })} placeholder="github-username" /></label><label>仓库名称<input value={settings.repo} onChange={(event) => setSettings({ ...settings, repo: event.target.value.trim() })} placeholder="exam-study-vault" /></label><div className="field-row"><label>分支<input value={settings.branch} onChange={(event) => setSettings({ ...settings, branch: event.target.value.trim() || "main" })} /></label><label>细粒度令牌<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="github_pat_…" /></label></div><button className="primary full" disabled={!ready || syncing} onClick={sync}>{syncing ? <LoaderCircle className="spin" size={18} /> : <Cloud size={18} />}{syncing ? "正在合并…" : `立即同步${pending ? `（${pending}）` : ""}`}</button></section>
      <section className="guide-card"><span className="section-kicker">首次设置</span><h2>三步建立同步资料库</h2><ol><li><span>1</span><div><strong>新建私有仓库</strong><p>建议命名 exam-study-vault，并创建 README。</p></div></li><li><span>2</span><div><strong>创建细粒度令牌</strong><p>只授权该仓库的 Contents 读写权限。</p></div></li><li><span>3</span><div><strong>在每台设备连接</strong><p>首次拉取后，题库和学习记录会自动合并。</p></div></li></ol></section></div>
    <section className="restore-card"><div className="restore-icon"><CloudDownload /></div><div><span className="section-kicker">远程数据优先</span><h2>丢弃本地，重新从 GitHub 恢复</h2><p>适合当前设备数据异常或希望完全回到远程状态时使用。系统会先确认仓库中存在同步记录；继续后，本地未同步内容将无法找回。</p></div><button className="danger-button" disabled={!ready || syncing || restoring} onClick={restoreFromRemote}>{restoring ? <LoaderCircle className="spin" size={18} /> : <CloudDownload size={18} />}{restoring ? "正在重建本地数据…" : "丢弃本地并恢复远程"}</button></section>
  </>;
}
