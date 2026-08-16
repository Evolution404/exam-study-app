"use client";
import { ListFilter, Moon, Settings2, Target } from "lucide-react";
import { archiveReviewRoundV7, completeReviewRoundV7, createReviewRoundV7, updateReviewRoundV7 } from "@/lib/db/db-v7";
import { ProgressScopeSetting } from "@/app/practice/progress-scope-setting";
import { ReviewRoundManager } from "@/app/practice/review-round-manager";
import { ShortcutSetting } from "@/app/ui/shortcut-setting";
import type { BankV7, ReviewRound } from "@/lib/db/v7-types";
import { SyncView, type PracticePreferences } from "../helpers";
import { ThemeSetting } from "./theme-setting";
import { GroupSizeSetting } from "./group-size-setting";
import { PreferenceSelect } from "./preference-select";
import { ToleranceSetting } from "./tolerance-setting";
import { GoalSetting } from "./goal-setting";
import { ImageCacheSetting } from "./image-cache-setting";
import { SyncAutomationSetting } from "./sync-automation-setting";
import { BuildVersionCard } from "./build-version-card";

export function PreferencesView({ preferences, rounds, banks, pendingSync, onNotice, onChange, onRestored }: { preferences: PracticePreferences; rounds: readonly ReviewRound[]; banks: readonly BankV7[]; pendingSync: number; onNotice: (message: string) => void; onChange: (value: PracticePreferences) => void; onRestored: (message: string) => void }) {
  const interactionItems: Array<{ key: "submitOnSelect" | "autoNextCorrect" | "showAnswerOnWrong" | "swipeNavigation" | "shuffleOptions" | "multiSelectAllAutoSubmit"; title: string; detail: string }> = [
    { key: "submitOnSelect", title: "选择后立即提交", detail: "默认开启，仅用于单选题和判断题；关闭后选择只会高亮，需要点击“确认答案”或按回车提交。" },
    { key: "autoNextCorrect", title: "答对后自动下一题", detail: "单选题和判断题选对后自动前进；多选题确认答案正确后自动前进。" },
    { key: "showAnswerOnWrong", title: "答错显示正确答案", detail: "立即标出错误选项和正确选项，方便当场纠正记忆。" },
    { key: "swipeNavigation", title: "左右滑动切换题目", detail: "向左滑进入下一题，向右滑返回上一题。" },
    { key: "shuffleOptions", title: "随机排列选项", detail: "仅随机单选题和多选题；判断题和计算题不受影响。" },
    { key: "multiSelectAllAutoSubmit", title: "多选题全选后自动确认", detail: "点击“全选”后立即提交答案；关闭后只选中全部选项，可继续取消选项再手动确认。" },
  ];
  const feedbackItems: Array<{ key: "feedbackSound" | "feedbackHaptics"; title: string; detail: string }> = [
    { key: "feedbackSound", title: "答题提示音", detail: "用轻提示音区分答对和答错；系统静音时可能不播放。" },
    { key: "feedbackHaptics", title: "答题振动反馈", detail: "vibrate" in navigator ? "支持振动的手机会在判题后给出轻触反馈。" : "iPhone/Safari 不支持振动，此选项仅在 Android 上生效。" },
  ];
  const toggleRow = (item: { key: keyof Pick<PracticePreferences, "submitOnSelect" | "autoNextCorrect" | "showAnswerOnWrong" | "swipeNavigation" | "shuffleOptions" | "multiSelectAllAutoSubmit" | "feedbackSound" | "feedbackHaptics" | "requireAllAnswered">; title: string; detail: string }) => <label aria-label={item.title} className="preference-row" key={item.key}><div><strong>{item.title}</strong><p>{item.detail}</p></div><input aria-label={item.title} type="checkbox" checked={Boolean(preferences[item.key])} onChange={(event) => onChange({ ...preferences, [item.key]: event.target.checked })} /><span className="toggle" aria-hidden="true" /></label>;
  return <><div className="page-heading compact"><div><p className="eyebrow">练习偏好</p><h1>答题配置</h1><p>设置只保存在当前浏览器，不会修改题库内容。</p></div></div><div className="preferences-view">
    <section className="preference-card"><div className="settings-title"><span><Moon /></span><div><h2>外观主题</h2><p>可以跟随手机或电脑的系统外观，也可以固定使用浅色或深色。</p></div></div>
      <ThemeSetting value={preferences.themeMode} onChange={(themeMode) => onChange({ ...preferences, themeMode })} />
    </section>
    <section className="preference-card"><div className="settings-title"><span><Settings2 /></span><div><h2>答题交互</h2><p>根据自己的背题节奏随时调整。</p></div></div>
      <div className="preference-list">
        <GroupSizeSetting value={preferences.groupSize} onChange={(groupSize) => onChange({ ...preferences, groupSize })} />
        {interactionItems.map(toggleRow)}
        <div className="mobile-question-transition"><PreferenceSelect title="切换题目方式" detail="“滑动”会像阅读页面一样平滑切入；“立即”直接显示目标题目。" value={preferences.questionTransition} onChange={(value) => onChange({ ...preferences, questionTransition: value as PracticePreferences["questionTransition"] })} options={[["instant", "立即"], ["slide", "滑动"]]} /></div>
        <PreferenceSelect title="自动下一题等待时间" detail="答对后留出查看反馈的时间；选择立即可最快连续刷题。" value={String(preferences.autoNextDelayMs)} onChange={(value) => onChange({ ...preferences, autoNextDelayMs: Number(value) as PracticePreferences["autoNextDelayMs"] })} options={[['0','立即'],['500','0.5 秒'],['1000','1 秒'],['2000','2 秒']]} />
      </div>
    </section>
    <div className="desktop-shortcut-settings"><ShortcutSetting value={preferences.keyboardShortcuts} onChange={(keyboardShortcuts) => onChange({ ...preferences, keyboardShortcuts })} /></div>
    <section className="preference-card"><div className="settings-title"><span><ListFilter /></span><div><h2>出题与复习</h2><p>控制抽题分布、默认顺序和错题复习节奏。</p></div></div><div className="preference-list">
      <ProgressScopeSetting value={preferences.progressScope} rounds={rounds} onChange={(progressScope) => onChange({ ...preferences, progressScope })} />
      <PreferenceSelect title="随机组题型分布" detail="均衡抽取会尽量平均包含单选、多选、判断、计算；不足的题型由其他题型补足。" value={preferences.randomTypeBalance} onChange={(value) => onChange({ ...preferences, randomTypeBalance: value as PracticePreferences["randomTypeBalance"] })} options={[['balanced','尽量均衡'],['natural','按题库自然比例']]} />
      <PreferenceSelect title="默认题目顺序" detail="进入练习中心和高级筛选时默认使用的题目顺序。" value={preferences.defaultOrder} onChange={(value) => onChange({ ...preferences, defaultOrder: value as PracticePreferences["defaultOrder"] })} options={[['sequential','题库顺序'],['random','随机打乱'],['difficulty','难题优先']]} />
      <PreferenceSelect title="答错后的复习方式" detail="立即重答会在当前题显示按钮；本组结束可在成绩页集中重练；留到下次进入错题练习。" value={preferences.wrongReappearance} onChange={(value) => onChange({ ...preferences, wrongReappearance: value as PracticePreferences["wrongReappearance"] })} options={[['immediate','立即重答'],['end','本组结束集中重练'],['next','留到下次错题练习']]} />
      <PreferenceSelect title="连续答对后移出错题" detail="题目答错或选择“不会”后进入错题；达到连续正确次数后自动移除。" value={String(preferences.wrongRemovalStreak)} onChange={(value) => onChange({ ...preferences, wrongRemovalStreak: Number(value) })} options={[['1','1 次'],['2','2 次'],['3','3 次'],['5','5 次']]} />
      <ToleranceSetting value={preferences.calculationTolerancePercent} onChange={(calculationTolerancePercent) => onChange({ ...preferences, calculationTolerancePercent })} />
      {toggleRow({ key: "requireAllAnswered", title: "必须答完才能结束", detail: "打开后点击查看结果会自动定位到第一道未答题，不允许带着空题结束。" })}
    </div></section>
    <ReviewRoundManager
      rounds={rounds}
      banks={banks}
      onCreate={async (name, bankIds) => { await createReviewRoundV7({ name, bankIds }); onNotice(`已创建复习轮次「${name}」`); }}
      onUpdate={async (roundId, name, bankIds) => { await updateReviewRoundV7(roundId, { name, bankIds }); onNotice("复习轮次已更新"); }}
      onComplete={async (roundId) => { await completeReviewRoundV7(roundId); onNotice("复习轮次已完成并保存最终快照"); }}
      onArchive={async (roundId) => { await archiveReviewRoundV7(roundId); onNotice("复习轮次已归档"); }}
    />
    <ImageCacheSetting onNotice={onNotice} />
    <section className="preference-card"><div className="settings-title"><span><Target /></span><div><h2>阅读、反馈与目标</h2><p>调整显示密度，设置每天的练习目标。</p></div></div><div className="preference-list">
      <PreferenceSelect title="答题字号" detail="只调整题干与选项的阅读字号，不影响题目内容。" value={preferences.fontSize} onChange={(value) => onChange({ ...preferences, fontSize: value as PracticePreferences["fontSize"] })} options={[['small','较小'],['standard','标准'],['large','较大'],['xlarge','特大']]} />
      <GoalSetting count={preferences.dailyGoalCount} accuracy={preferences.dailyGoalAccuracy} onChange={(dailyGoalCount, dailyGoalAccuracy) => onChange({ ...preferences, dailyGoalCount, dailyGoalAccuracy })} />
      {feedbackItems.map(toggleRow)}
    </div></section>
    <SyncAutomationSetting preferences={preferences} onChange={onChange} />
    <BuildVersionCard />
    <div className="mobile-sync-settings"><SyncView pending={pendingSync} onNotice={onNotice} onRestored={onRestored} /></div>
  </div></>;
}
