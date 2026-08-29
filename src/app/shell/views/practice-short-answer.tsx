"use client";

export function PracticeShortAnswer({ value, disabled, showReference, referenceText, onChange }: { value: string; disabled: boolean; showReference: boolean; referenceText?: string; onChange: (value: string) => void }) {
  return <div className="short-answer-card">
    <label>
      <span>我的回答</span>
      <textarea aria-label="简答题回答" value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} placeholder="先回忆要点，再查看参考答案自评。" rows={6} />
    </label>
    {showReference && referenceText && <div className="short-reference"><strong>参考答案</strong><p>{referenceText}</p></div>}
  </div>;
}
