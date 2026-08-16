"use client";
import { useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import { ModalPortal } from "@/app/ui/modal-portal";
import { questionOverviewProgress } from "@/lib/question/question-overview";
import { TYPE_ORDER, type PracticeAnswerState, type QuestionType } from "../helpers";

export function QuestionOverview({ questionIds, questionTypes, answers, currentIndex, onClose, onJump }: { questionIds: string[]; questionTypes: Record<string, QuestionType>; answers: Record<string, PracticeAnswerState>; currentIndex: number; onClose: () => void; onJump: (index: number) => void }) {
  const groupsRef = useRef<HTMLDivElement>(null);
  const focusButtonRef = useRef<HTMLButtonElement>(null);
  const answered = questionIds.filter((id) => answers[id]?.submitted).length;
  const correct = questionIds.filter((id) => answers[id]?.submitted && answers[id]?.correct).length;
  const wrong = answered - correct;
  const accuracy = answered ? Math.round(correct / answered * 100) : 0;
  const progress = questionOverviewProgress(answered, questionIds.length);

  // Bring the current question into the middle of the grid. The scroll formula
  // centres the focused button; when the current question is near either end it
  // cannot be centred, so the browser clamps scrollTop to the top/bottom limit
  // and the row rests against that edge instead.
  useLayoutEffect(() => {
    const groups = groupsRef.current;
    const button = focusButtonRef.current;
    if (!groups || !button) return;
    const groupsBox = groups.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    groups.scrollTop += buttonBox.top + buttonBox.height / 2 - groupsBox.top - groupsBox.height / 2;
  }, [currentIndex]);

  return <ModalPortal><div className="overview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="question-overview" role="dialog" aria-modal="true" aria-label="题目总览"><header><div><span className="section-kicker">练习导航</span><h2>题目总览</h2><p>已作答 {answered} / {questionIds.length}，点击题号快速切换。</p></div><button className="icon-button" aria-label="关闭题目总览" onClick={onClose}><X size={19} /></button></header><div className="overview-score"><span><strong>{correct}</strong>正确</span><span><strong>{wrong}</strong>错误</span><span><strong>{accuracy}%</strong>正确率</span><span><strong>{progress}</strong>进度</span></div><div className="overview-legend"><span><i className="correct" />正确</span><span><i className="wrong" />错误</span><span><i className="pending" />已选择</span><span><i />未作答</span></div><div className="overview-groups" ref={groupsRef}>{TYPE_ORDER.map((type) => { const group = questionIds.map((id, questionIndex) => ({ id, questionIndex })).filter(({ id }) => questionTypes[id] === type); return <section className="overview-group" key={type}><div><h3>{type}</h3><span>{group.length} 题</span></div>{group.length ? <div className="overview-number-grid">{group.map(({ id, questionIndex }) => { const answer = answers[id]; const state = answer?.submitted ? answer.correct ? "correct" : "wrong" : answer?.selected.length ? "pending" : "blank"; return <button ref={questionIndex === currentIndex ? focusButtonRef : undefined} data-overview-focus={questionIndex === currentIndex ? "true" : undefined} key={`${id}-${questionIndex}`} className={`${state} ${questionIndex === currentIndex ? "current" : ""}`} aria-label={`第 ${questionIndex + 1} 题，${type}`} aria-current={questionIndex === currentIndex ? "true" : undefined} onClick={() => onJump(questionIndex)}>{questionIndex + 1}</button>; })}</div> : <p className="overview-empty">本次练习没有{type}题</p>}</section>; })}</div></section></div></ModalPortal>;
}
