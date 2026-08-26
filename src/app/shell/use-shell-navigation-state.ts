import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SearchContentScope } from "@/app/search/search-matching";
import { SCROLL_RESTORABLE_VIEWS, type View } from "./helpers";
import { mergeSearchHistory } from "./shell-controller-model";

export function useShellNavigationState() {
  const [view, setView] = useState<View>("home");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchContentScope, setSearchContentScope] = useState<SearchContentScope>("all");
  const [searchQuestionId, setSearchQuestionId] = useState<string>();
  const [searchRevision, setSearchRevision] = useState(0);
  const [groupQuestionIds, setGroupQuestionIds] = useState<string[]>([]);
  const [practiceHubTab, setPracticeHubTab] = useState<"start" | "history">("start");
  const [resultRunId, setResultRunId] = useState<string>();
  const workspaceRef = useRef<HTMLElement>(null);
  const viewScrollPositions = useRef<Partial<Record<View, number>>>({});

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const positions = viewScrollPositions.current;
    workspace.scrollTop = SCROLL_RESTORABLE_VIEWS.includes(view) ? positions[view] ?? 0 : 0;
  }, [view]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || !SCROLL_RESTORABLE_VIEWS.includes(view)) return;
    const positions = viewScrollPositions.current;
    const rememberPosition = () => { positions[view] = workspace.scrollTop; };
    workspace.addEventListener("scroll", rememberPosition, { passive: true });
    return () => workspace.removeEventListener("scroll", rememberPosition);
  }, [view]);

  const openSearch = useCallback((questionId?: string, keyword?: string, contentScope: SearchContentScope = "all") => {
    const nextKeyword = (keyword ?? query).trim();
    if (nextKeyword) {
      try {
        const previous = JSON.parse(localStorage.getItem("study-search-history") ?? "[]") as unknown;
        const history = Array.isArray(previous) ? previous.filter((item): item is string => typeof item === "string") : [];
        localStorage.setItem("study-search-history", JSON.stringify(mergeSearchHistory(history, nextKeyword)));
      } catch {
        localStorage.setItem("study-search-history", JSON.stringify([nextKeyword]));
      }
    }
    setSearchQuestionId(questionId);
    setSearchContentScope(contentScope);
    setSearchRevision((revision) => revision + 1);
    setView("search");
  }, [query]);

  const openMainView = useCallback((nextView: View) => {
    if (nextView === "relations") setGroupQuestionIds([]);
    if (nextView === "practiceSetup") setPracticeHubTab("start");
    if (nextView === view) workspaceRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    else {
      if (SCROLL_RESTORABLE_VIEWS.includes(view) && workspaceRef.current) {
        viewScrollPositions.current[view] = workspaceRef.current.scrollTop;
      }
      setView(nextView);
    }
    setSidebarOpen(false);
  }, [view]);

  const resetAfterRestore = useCallback(() => {
    setView("home");
    setSidebarOpen(false);
    setQuery("");
    setSearchContentScope("all");
    setSearchQuestionId(undefined);
    setSearchRevision((revision) => revision + 1);
    setGroupQuestionIds([]);
    setPracticeHubTab("start");
    setResultRunId(undefined);
    viewScrollPositions.current = {};
    workspaceRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  return {
    view,
    setView,
    sidebarOpen,
    setSidebarOpen,
    query,
    setQuery,
    searchContentScope,
    setSearchContentScope,
    searchQuestionId,
    setSearchQuestionId,
    searchRevision,
    groupQuestionIds,
    setGroupQuestionIds,
    practiceHubTab,
    setPracticeHubTab,
    resultRunId,
    setResultRunId,
    workspaceRef,
    openSearch,
    openMainView,
    resetAfterRestore,
  };
}
