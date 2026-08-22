import "@/app/styles/review-scope.css";
import { useId, useMemo, useState } from "react";
import type { Bank } from "@/types/types";
import type { ReviewRound, ReviewRoundStatus } from "@/lib/db/v7-types";

export interface ReviewRoundMetrics {
  /** Current number of distinct questions in the round. */
  questionCount: number;
  /** Number of those questions completed in the round's current projection. */
  completedCount: number;
}

/** Minimal bank shape needed by the controls; full `Bank` records are accepted too. */
export type ReviewRoundBank = Pick<Bank, "id" | "name" | "questionCount"> & Partial<Pick<Bank, "displayName">>;

export type ReviewRoundMetricsMap = Readonly<Record<string, ReviewRoundMetrics>>;
export type ReviewRoundMetricsSource = ReviewRoundMetricsMap | ((round: ReviewRound) => ReviewRoundMetrics | undefined);

export interface ReviewRoundManagerProps {
  rounds: readonly ReviewRound[];
  banks: readonly ReviewRoundBank[];
  /** Metrics stay outside the component so question/progress counts can come from any projection. */
  metrics?: ReviewRoundMetricsSource;
  /** Alias useful when the caller already names its map `roundMetrics`. */
  roundMetrics?: ReviewRoundMetricsSource;
  onCreate?: (name: string, bankIds: string[]) => void | Promise<void>;
  onUpdate?: (roundId: string, name: string, bankIds: string[]) => void | Promise<void>;
  onComplete?: (roundId: string) => void | Promise<void>;
  onArchive?: (roundId: string) => void | Promise<void>;
  disabled?: boolean;
}

export interface RoundSummaryMetrics {
  questionCount: number;
  completedCount: number;
}

const statusLabel: Record<ReviewRoundStatus, string> = {
  active: "进行中",
  completed: "已完成",
  archived: "已归档",
};

export const REVIEW_ROUND_STATUS_LABELS = statusLabel;

/** Active rounds are deliberately not de-duplicated or collapsed: parallel rounds are valid. */
export function activeReviewRounds(rounds: readonly ReviewRound[]): ReviewRound[] {
  return rounds.filter((round) => round.status === "active");
}

export function visibleReviewRounds(rounds: readonly ReviewRound[]): ReviewRound[] {
  return rounds.filter((round) => round.status !== "archived");
}

export function bankQuestionCount(bankIds: readonly string[], banks: readonly Pick<Bank, "id" | "questionCount">[]): number {
  return bankIds.reduce((total, bankId) => total + Math.max(0, banks.find((bank) => bank.id === bankId)?.questionCount ?? 0), 0);
}

export function roundSummaryMetrics(
  round: ReviewRound,
  banks: readonly Pick<Bank, "id" | "questionCount">[],
  source?: ReviewRoundMetricsSource,
): RoundSummaryMetrics {
  const supplied = typeof source === "function" ? source(round) : source?.[round.id];
  const fallbackQuestionCount = round.status === "completed" && Array.isArray(round.finalQuestionIds)
    ? round.finalQuestionIds.length
    : bankQuestionCount(round.bankIds, banks);
  const questionCount = Number.isFinite(supplied?.questionCount) ? Math.max(0, Math.trunc(supplied?.questionCount ?? 0)) : fallbackQuestionCount;
  const completedCount = Number.isFinite(supplied?.completedCount) ? Math.min(questionCount, Math.max(0, Math.trunc(supplied?.completedCount ?? 0))) : 0;
  return { questionCount, completedCount };
}

function cleanIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function bankTitle(bank: Pick<Bank, "name" | "displayName">): string {
  return bank.displayName?.trim() || bank.name.trim() || "未命名题库";
}

function roundTitle(round: ReviewRound): string {
  return round.name.trim() || `未命名轮次 · ${round.id}`;
}

function formatDate(value?: string): string {
  if (!value) return "时间未记录";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "时间未记录";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric" }).format(parsed);
}

export function ReviewRoundManager({
  rounds,
  banks,
  metrics,
  roundMetrics,
  onCreate,
  onUpdate,
  onComplete,
  onArchive,
  disabled = false,
}: ReviewRoundManagerProps) {
  const id = useId();
  const source = metrics ?? roundMetrics;
  const visibleRounds = useMemo(() => visibleReviewRounds(rounds), [rounds]);
  const [editor, setEditor] = useState<"create" | string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftBankIds, setDraftBankIds] = useState<string[]>([]);
  const [editorError, setEditorError] = useState("");
  const [confirmingRoundId, setConfirmingRoundId] = useState<string | null>(null);

  function openCreate() {
    if (disabled) return;
    setEditor("create");
    setDraftName("");
    setDraftBankIds([]);
    setEditorError("");
  }

  function openEdit(round: ReviewRound) {
    if (disabled || round.status !== "active") return;
    setEditor(round.id);
    setDraftName(round.name);
    setDraftBankIds(cleanIds(round.bankIds));
    setEditorError("");
  }

  function closeEditor() {
    setEditor(null);
    setEditorError("");
  }

  function toggleBank(bankId: string) {
    setDraftBankIds((current) => current.includes(bankId) ? current.filter((idValue) => idValue !== bankId) : [...current, bankId]);
  }

  function saveEditor() {
    const name = draftName.trim();
    const bankIds = cleanIds(draftBankIds);
    if (!name) {
      setEditorError("请填写轮次名称。");
      return;
    }
    if (!bankIds.length) {
      setEditorError("至少选择一个题库，轮次才有题目范围。");
      return;
    }
    if (editor === "create") {
      void onCreate?.(name, bankIds);
    } else if (editor) {
      void onUpdate?.(editor, name, bankIds);
    }
    closeEditor();
  }

  function completeRound(roundId: string) {
    if (disabled) return;
    if (confirmingRoundId !== roundId) {
      setConfirmingRoundId(roundId);
      return;
    }
    setConfirmingRoundId(null);
    void onComplete?.(roundId);
  }

  function archiveRound(roundId: string) {
    if (disabled) return;
    void onArchive?.(roundId);
  }

  return <section className="review-round-manager" aria-labelledby={`${id}-title`}>
    <header className="review-round-manager-heading">
      <div>
        <span className="review-scope-kicker">复习轮次</span>
        <h2 id={`${id}-title`}>命名并追踪复习轮次</h2>
        <p>每个轮次独立记录题库范围和完成度，可同时保留多个进行中的轮次。</p>
      </div>
      <button type="button" className="review-round-primary" disabled={disabled} onClick={openCreate}>新建轮次</button>
    </header>

    {visibleRounds.length === 0 && <div className="review-round-empty"><strong>还没有复习轮次</strong><p>先命名一个目标，再从题库中勾选本轮要复习的范围。</p></div>}

    <div className="review-round-list">
      {visibleRounds.map((round) => {
        const summary = roundSummaryMetrics(round, banks, source);
        const finalSnapshot = round.status === "completed"
          ? (Array.isArray(round.finalQuestionIds) ? round.finalQuestionIds.length : summary.questionCount)
          : null;
        const isConfirming = confirmingRoundId === round.id;
        return <article className={`review-round-card ${round.status}`} key={round.id}>
          <header>
            <div>
              <span className={`review-round-status ${round.status}`}>{statusLabel[round.status]}</span>
              <h3>{roundTitle(round)}</h3>
              <p>开始于 {formatDate(round.startedAt)}{round.completedAt ? ` · 结束于 ${formatDate(round.completedAt)}` : ""}</p>
            </div>
            <div className="review-round-card-actions">
              {round.status === "active" && <button type="button" disabled={disabled} onClick={() => openEdit(round)}>编辑范围</button>}
              {round.status !== "archived" && <button type="button" className="review-round-archive" disabled={disabled} onClick={() => archiveRound(round.id)}>归档</button>}
            </div>
          </header>

          <div className="review-round-metrics" aria-label={`${roundTitle(round)}统计`}>
            <span><strong>{summary.questionCount.toLocaleString()}</strong><small>{finalSnapshot === null ? "当前题目" : "动态题目"}</small></span>
            <span><strong>{summary.completedCount.toLocaleString()}</strong><small>已完成</small></span>
            <span><strong>{summary.questionCount ? Math.round(summary.completedCount / summary.questionCount * 100) : 0}%</strong><small>完成度</small></span>
          </div>

          <div className="review-round-banks">
            <strong>题库范围</strong>
            <div>{round.bankIds.map((bankId) => {
              const bank = banks.find((candidate) => candidate.id === bankId);
              return <span key={bankId}>{bank ? bankTitle(bank) : `题库 ${bankId}`}</span>;
            })}</div>
          </div>

          {finalSnapshot !== null && <p className="review-round-snapshot">已完成轮次会保留最终快照：结束时共 {finalSnapshot.toLocaleString()} 道题，之后题库变化不会改写这份记录。</p>}

          {round.status === "active" && <div className="review-round-complete-action">
            {isConfirming ? <>
              <span>提前结束后将固定本轮最终题目快照。</span>
              <button type="button" className="review-round-danger" disabled={disabled} onClick={() => completeRound(round.id)}>再次确认结束</button>
              <button type="button" disabled={disabled} onClick={() => setConfirmingRoundId(null)}>取消</button>
            </> : <button type="button" className="review-round-end" disabled={disabled} onClick={() => completeRound(round.id)}>提前结束轮次</button>}
          </div>}
        </article>;
      })}
    </div>

    {editor && <div className="review-round-editor" role="dialog" aria-modal="false" aria-labelledby={`${id}-editor-title`}>
      <header>
        <div><span className="review-scope-kicker">{editor === "create" ? "新建" : "编辑"}</span><h3 id={`${id}-editor-title`}>{editor === "create" ? "命名复习轮次" : "调整轮次范围"}</h3></div>
        <button type="button" onClick={closeEditor}>取消</button>
      </header>
      <label className="review-round-name-field" htmlFor={`${id}-round-name`}>轮次名称<input id={`${id}-round-name`} value={draftName} maxLength={80} onChange={(event) => setDraftName(event.currentTarget.value)} placeholder="例如：2026 春季考试第一轮" /></label>
      <fieldset className="review-round-bank-picker">
        <legend>选择题库</legend>
        <div>
          {banks.map((bank) => <label key={bank.id} htmlFor={`${id}-bank-${bank.id}`} aria-label={`选择题库 ${bankTitle(bank)}`}><input id={`${id}-bank-${bank.id}`} type="checkbox" checked={draftBankIds.includes(bank.id)} onChange={() => toggleBank(bank.id)} /><span><strong>{bankTitle(bank)}</strong><small>{Math.max(0, bank.questionCount).toLocaleString()} 题</small></span></label>)}
        </div>
        {banks.length === 0 && <p>还没有可选题库。</p>}
      </fieldset>
      {editorError && <p className="review-round-editor-error" role="alert">{editorError}</p>}
      <footer><button type="button" onClick={closeEditor}>取消</button><button type="button" className="review-round-primary" onClick={saveEditor}>保存轮次</button></footer>
    </div>}
  </section>;
}

export interface PracticeRoundPickerProps {
  rounds: readonly ReviewRound[];
  value?: string | null;
  onChange: (roundId: string | null) => void;
  disabled?: boolean;
  id?: string;
}

/**
 * Controlled one-round association for a single practice.  Completed and
 * archived rounds never appear here; selecting the first option leaves the
 * practice outside of all review rounds.
 */
export function PracticeRoundPicker({ rounds, value = null, onChange, disabled = false, id }: PracticeRoundPickerProps) {
  const generatedId = useId();
  const name = id ?? `practice-round-${generatedId}`;
  const activeRounds = activeReviewRounds(rounds);
  const selectedValue = activeRounds.some((round) => round.id === value) ? value : null;
  return <fieldset className="practice-round-picker" disabled={disabled}>
    <legend>计入复习轮次</legend>
    <p>一次练习最多归入一个进行中的轮次，也可以选择不计入轮次。</p>
    <div className="practice-round-options">
      <label className={selectedValue === null ? "selected" : ""} htmlFor={`${name}-none`} aria-label="不计入轮次">
        <input id={`${name}-none`} type="radio" name={name} value="" checked={selectedValue === null} onChange={() => onChange(null)} />
        <span><strong>不计入轮次</strong><small>只保留普通练习记录</small></span>
      </label>
      {activeRounds.map((round) => <label className={selectedValue === round.id ? "selected" : ""} key={round.id} htmlFor={`${name}-${round.id}`} aria-label={`计入轮次 ${roundTitle(round)}`}>
        <input id={`${name}-${round.id}`} type="radio" name={name} value={round.id} checked={selectedValue === round.id} onChange={() => onChange(round.id)} />
        <span><strong>{roundTitle(round)}</strong><small>{round.bankIds.length} 个题库 · 进行中</small></span>
      </label>)}
    </div>
    {activeRounds.length === 0 && <small className="practice-round-empty">暂无进行中的轮次，可先在上方创建。</small>}
  </fieldset>;
}
