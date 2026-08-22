import "@/app/styles/review-scope.css";
import { useId, useState } from "react";
import type { ProgressScope } from "@/lib/practice/progress-scope";
import { normalizeProgressScope } from "@/lib/practice/progress-scope";
import type { ReviewRound } from "@/lib/db/v7-types";

export const PROGRESS_SCOPE_MIN_DAYS = 1;
export const PROGRESS_SCOPE_MAX_DAYS = 36_500;
export const PROGRESS_SCOPE_PRESET_DAYS = [30, 90, 180] as const;

export const PROGRESS_SCOPE_EXPLANATION = "这个范围统一用于首页和题库的进度、作答次数、正确率与难度；收藏、标签和个人解析不随时间变化。";

export interface ProgressScopePreset {
  key: string;
  label: string;
  scope: ProgressScope;
}

export const PROGRESS_SCOPE_PRESETS: readonly ProgressScopePreset[] = PROGRESS_SCOPE_PRESET_DAYS.map((days) => ({
  key: `rolling:${days}`,
  label: `近 ${days} 天`,
  scope: { type: "rolling", days },
}));

/** Keep a user-entered rolling window inside the persisted domain's safe range. */
export function clampProgressScopeDays(value: number | string, fallback = 90): number {
  const fallbackValue = Number.isFinite(fallback) ? Math.trunc(fallback) : 90;
  const safeFallback = Math.min(PROGRESS_SCOPE_MAX_DAYS, Math.max(PROGRESS_SCOPE_MIN_DAYS, fallbackValue || 90));
  const numeric = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isFinite(numeric)) return safeFallback;
  return Math.min(PROGRESS_SCOPE_MAX_DAYS, Math.max(PROGRESS_SCOPE_MIN_DAYS, Math.trunc(numeric)));
}

/** Stable choice key used by the component and by callers that persist UI state. */
export function progressScopeChoiceKey(scope: ProgressScope): string {
  const normalized = normalizeProgressScope(scope);
  if (normalized.type === "lifetime") return "lifetime";
  if (normalized.type === "round") return `round:${normalized.roundId}`;
  return PROGRESS_SCOPE_PRESET_DAYS.includes(normalized.days as typeof PROGRESS_SCOPE_PRESET_DAYS[number])
    ? `rolling:${normalized.days}`
    : "custom";
}

export function selectableProgressRounds(rounds: readonly ReviewRound[] = []): ReviewRound[] {
  return rounds.filter((round) => round.status === "active" || round.status === "completed");
}

function roundTitle(round: ReviewRound): string {
  return round.name.trim() || `未命名轮次 · ${round.id}`;
}

export interface ProgressScopeSettingProps {
  value: ProgressScope;
  onChange: (scope: ProgressScope) => void;
  rounds?: readonly ReviewRound[];
  disabled?: boolean;
  /** Optional id prefix so multiple settings can be rendered on one page. */
  id?: string;
}

/**
 * A controlled progress-scope selector.  It intentionally only reports a
 * scope change; it does not read or write IndexedDB/localStorage.
 */
export function ProgressScopeSetting({ value, onChange, rounds = [], disabled = false, id }: ProgressScopeSettingProps) {
  const generatedId = useId();
  const idPrefix = id ?? `progress-scope-${generatedId}`;
  const normalized = normalizeProgressScope(value);
  const choice = progressScopeChoiceKey(normalized);
  const [customDraft, setCustomDraft] = useState<string | null>(null);
  const customInput = choice === "custom" && customDraft !== null
    ? customDraft
    : normalized.type === "rolling" ? String(normalized.days) : "90";
  const availableRounds = selectableProgressRounds(rounds);

  function select(scope: ProgressScope, preserveCustomDraft = false) {
    if (!disabled) {
      if (!preserveCustomDraft) setCustomDraft(null);
      onChange(scope);
    }
  }

  function chooseCustom() {
    const days = clampProgressScopeDays(customInput, normalized.type === "rolling" ? normalized.days : 90);
    setCustomDraft(String(days));
    select({ type: "rolling", days }, true);
  }

  function onCustomInput(raw: string) {
    if (!raw.trim()) {
      setCustomDraft("");
      return;
    }
    const days = clampProgressScopeDays(raw);
    setCustomDraft(String(days));
    select({ type: "rolling", days }, true);
  }

  return <section className="review-scope-control" aria-labelledby={`${idPrefix}-title`}>
    <header className="review-scope-heading">
      <div>
        <span className="review-scope-kicker">进度统计口径</span>
        <h2 id={`${idPrefix}-title`}>已做与完成度按什么计算？</h2>
        <p>{PROGRESS_SCOPE_EXPLANATION}</p>
      </div>
      <span className="review-scope-current" aria-live="polite">当前：{scopeLabel(normalized, availableRounds)}</span>
    </header>

    <div className="review-scope-choice-grid" role="radiogroup" aria-label="进度统计口径">
      {PROGRESS_SCOPE_PRESETS.map((preset) => <button
        key={preset.key}
        type="button"
        role="radio"
        aria-checked={choice === preset.key}
        className={choice === preset.key ? "selected" : ""}
        disabled={disabled}
        onClick={() => select(preset.scope)}
      >
        <strong>{preset.label}</strong>
        <small>按最近作答时间</small>
      </button>)}
      <button
        type="button"
        role="radio"
        aria-checked={choice === "lifetime"}
        className={choice === "lifetime" ? "selected" : ""}
        disabled={disabled}
        onClick={() => select({ type: "lifetime" })}
      >
        <strong>永久</strong>
        <small>显示全部历史作答</small>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={choice === "custom"}
        className={choice === "custom" ? "selected" : ""}
        disabled={disabled}
        onClick={chooseCustom}
      >
        <strong>自定义天数</strong>
        <small>适合特殊复习周期</small>
      </button>
    </div>

    <div className={`review-scope-custom ${choice === "custom" ? "active" : ""}`}>
      <label htmlFor={`${idPrefix}-days`}>自定义时间范围</label>
      <div>
        <input
          id={`${idPrefix}-days`}
          type="number"
          min={PROGRESS_SCOPE_MIN_DAYS}
          max={PROGRESS_SCOPE_MAX_DAYS}
          step="1"
          inputMode="numeric"
          value={customInput}
          disabled={disabled}
          aria-describedby={`${idPrefix}-days-hint`}
          onChange={(event) => onCustomInput(event.currentTarget.value)}
          onFocus={() => { if (choice !== "custom") chooseCustom(); }}
          onBlur={() => {
            const days = clampProgressScopeDays(customInput, normalized.type === "rolling" ? normalized.days : 90);
            setCustomDraft(String(days));
            if (choice === "custom") select({ type: "rolling", days }, true);
          }}
        />
        <span>天</span>
      </div>
      <small id={`${idPrefix}-days-hint`}>请输入 {PROGRESS_SCOPE_MIN_DAYS}–{PROGRESS_SCOPE_MAX_DAYS} 天，超出范围会自动收敛。</small>
    </div>

    {availableRounds.length > 0 && <div className="review-scope-rounds">
      <div className="review-scope-subheading">
        <strong>临时按复习轮次</strong>
        <small>只统计该轮次内的已做题，轮次结束后仍可查看最终快照。</small>
      </div>
      <div className="review-scope-round-list" role="radiogroup" aria-label="复习轮次进度口径">
        {availableRounds.map((round) => {
          const key = `round:${round.id}`;
          return <button
            key={round.id}
            type="button"
            role="radio"
            aria-checked={choice === key}
            className={choice === key ? "selected" : ""}
            disabled={disabled}
            onClick={() => select({ type: "round", roundId: round.id })}
          >
            <span><strong>{roundTitle(round)}</strong><small>{round.status === "active" ? "进行中" : "已完成"}</small></span>
            <em>{round.bankIds.length} 个题库</em>
          </button>;
        })}
      </div>
    </div>}
  </section>;
}

function scopeLabel(scope: ProgressScope, rounds: readonly ReviewRound[]): string {
  if (scope.type === "lifetime") return "全部时间";
  if (scope.type === "rolling") return scope.days >= PROGRESS_SCOPE_MIN_DAYS ? `近 ${scope.days} 天` : "近 90 天";
  return rounds.find((round) => round.id === scope.roundId)?.name || `复习轮次 ${scope.roundId}`;
}
