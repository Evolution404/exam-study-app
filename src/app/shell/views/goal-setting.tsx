"use client";

export function GoalSetting({ count, accuracy, onChange }: { count: number; accuracy: number; onChange: (count: number, accuracy: number) => void }) {
  return <div className="preference-row goal-preference"><div><strong>每日练习目标</strong><p>首页按当天实际作答次数与正确率显示完成进度。</p></div><span><label>题数<input aria-label="每日目标题数" type="number" min="1" max="1000" value={count} onChange={(event) => onChange(Math.min(1000, Math.max(1, Number(event.target.value) || 1)), accuracy)} /></label><label>正确率<input aria-label="每日目标正确率" type="number" min="1" max="100" value={accuracy} onChange={(event) => onChange(count, Math.min(100, Math.max(1, Number(event.target.value) || 1)))} /><em>%</em></label></span></div>;
}
