import type { PracticeAnswerState, PracticePreferences, Question, QuestionType } from "../helpers";

export interface PracticeProps {
  runId: string;
  question: Question;
  initialState?: PracticeAnswerState;
  optionOrder?: number[];
  questionIds: string[];
  questionTypes: Record<string, QuestionType>;
  answers: Record<string, PracticeAnswerState>;
  index: number;
  total: number;
  modeLabel: string;
  preferences: PracticePreferences;
  transitionPending?: boolean;
  onStateChange: (state: PracticeAnswerState) => void;
  onJump: (index: number) => void;
  onFavorite: () => Promise<void>;
  onPrevious: () => void;
  onNext: () => void;
  onFinish: () => void;
  onExit: () => void;
}
