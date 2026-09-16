import { Gauge, ListOrdered, RotateCcw, Shuffle, Star, Tags } from "lucide-react";
import type { PracticeCombo } from "@/lib/practice/practice-setup-model";

export type PresetCard =
  | { id: string; title: string; detail: string; icon: typeof Shuffle; kind: "start"; combo: PracticeCombo }
  | { id: string; title: string; detail: string; icon: typeof Shuffle; kind: "configure" };

export const presetCards: PresetCard[] = [
  { id: "random30", title: "随机一组", detail: "从已选题库随机抽取", icon: Shuffle, kind: "start", combo: { status: "all", order: "random", amount: "default" } },
  { id: "randomCustom", title: "随机指定题数", detail: "本次输入题数，不修改全局配置", icon: Shuffle, kind: "configure" },
  { id: "sequential", title: "全量顺序练习", detail: "按题库顺序练完全部题目", icon: ListOrdered, kind: "start", combo: { status: "all", order: "sequential", amount: "all" } },
  { id: "randomAll", title: "全量随机练习", detail: "全部题目随机排列", icon: Shuffle, kind: "start", combo: { status: "all", order: "random", amount: "all" } },
  { id: "wrong", title: "练习错题", detail: "集中练习当前口径下的错题", icon: RotateCcw, kind: "start", combo: { status: "wrong", order: "sequential", amount: "all" } },
  { id: "favorite", title: "练习收藏题", detail: "只练习自己收藏的题目", icon: Star, kind: "start", combo: { status: "favorite", order: "sequential", amount: "all" } },
  { id: "difficult", title: "优先复习", detail: "综合个人难度与距上次作答时间排序", icon: Gauge, kind: "start", combo: { status: "all", order: "difficulty", amount: "all" } },
  { id: "tag", title: "标签模式", detail: "按知识标签练习", icon: Tags, kind: "configure" },
];
