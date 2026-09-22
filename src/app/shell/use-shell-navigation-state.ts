import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SearchContentScope } from "@/app/search/search-matching";
import { SCROLL_RESTORABLE_VIEWS, type View } from "./helpers";
import { mergeSearchHistory } from "./shell-controller-model";

const REFRESH_NAVIGATION_KEY = "study-refresh-navigation";
const REFRESH_NAVIGATION_MAX_AGE_MS = 30_000;
const VALID_VIEWS: readonly View[] = ["home", "banks", "relations", "practiceSetup", "preferences", "settings", "search", "practice", "practiceResult"];
const VALID_SEARCH_SCOPES: readonly SearchContentScope[] = ["all", "stem", "options", "explanation"];

type PracticeHubTab = "start" | "history";

interface RefreshNavigationSnapshot {
  createdAt: number;
  view: View;
  query: string;
  searchContentScope: SearchContentScope;
  searchQuestionId?: string;
  groupQuestionIds: string[];
  practiceHubTab: PracticeHubTab;
  resultRunId?: string;
  scrollTop: number;
}

function readRefreshNavigationSnapshot(): RefreshNavigationSnapshot | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(REFRESH_NAVIGATION_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<RefreshNavigationSnapshot>;
    const createdAt = Number(value.createdAt);
    if (!Number.isFinite(createdAt) || Math.abs(Date.now() - createdAt) > REFRESH_NAVIGATION_MAX_AGE_MS || !VALID_VIEWS.includes(value.view as View)) {
      window.sessionStorage.removeItem(REFRESH_NAVIGATION_KEY);
      return undefined;
    }
    const view = value.view as View;
    if (view === "practice") return undefined;
    if (view === "practiceResult" && typeof value.resultRunId !== "string") {
      window.sessionStorage.removeItem(REFRESH_NAVIGATION_KEY);
      return undefined;
    }
    return {
      createdAt,
      view,
      query: typeof value.query === "string" ? value.query : "",
      searchContentScope: VALID_SEARCH_SCOPES.includes(value.searchContentScope as SearchContentScope) ? value.searchContentScope as SearchContentScope : "all",
      searchQuestionId: typeof value.searchQuestionId === "string" ? value.searchQuestionId : undefined,
      groupQuestionIds: Array.isArray(value.groupQuestionIds) ? value.groupQuestionIds.filter((id): id is string => typeof id === "string") : [],
      practiceHubTab: value.practiceHubTab === "history" ? "history" : "start",
      resultRunId: typeof value.resultRunId === "string" ? value.resultRunId : undefined,
      scrollTop: Number.isFinite(Number(value.scrollTop)) ? Math.max(0, Number(value.scrollTop)) : 0,
    };
  } catch {
    window.sessionStorage.removeItem(REFRESH_NAVIGATION_KEY);
    return undefined;
  }
}

export function useShellNavigationState() {
  const [refreshSnapshot] = useState<RefreshNavigationSnapshot | undefined>(readRefreshNavigationSnapshot);
  const [view, setView] = useState<View>(refreshSnapshot?.view ?? "home");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState(refreshSnapshot?.query ?? "");
  const [searchContentScope, setSearchContentScope] = useState<SearchContentScope>(refreshSnapshot?.searchContentScope ?? "all");
  const [searchQuestionId, setSearchQuestionId] = useState<string | undefined>(refreshSnapshot?.searchQuestionId);
  const [searchRevision, setSearchRevision] = useState(0);
  const [groupQuestionIds, setGroupQuestionIds] = useState<string[]>(refreshSnapshot?.groupQuestionIds ?? []);
  const [practiceHubTab, setPracticeHubTab] = useState<PracticeHubTab>(refreshSnapshot?.practiceHubTab ?? "start");
  const [resultRunId, setResultRunId] = useState<string | undefined>(refreshSnapshot?.resultRunId);
  const workspaceRef = useRef<HTMLElement>(null);
  const viewScrollPositions = useRef<Partial<Record<View, number>>>(refreshSnapshot ? { [refreshSnapshot.view]: refreshSnapshot.scrollTop } : {});

  useEffect(() => {
    if (!refreshSnapshot) return;
    window.sessionStorage.removeItem(REFRESH_NAVIGATION_KEY);
  }, [refreshSnapshot]);

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

  const prepareForReload = useCallback(() => {
    try {
      if (view === "practice") {
        window.sessionStorage.removeItem(REFRESH_NAVIGATION_KEY);
        return;
      }
      const snapshot: RefreshNavigationSnapshot = {
        createdAt: Date.now(),
        view,
        query,
        searchContentScope,
        searchQuestionId,
        groupQuestionIds,
        practiceHubTab,
        resultRunId,
        scrollTop: workspaceRef.current?.scrollTop ?? 0,
      };
      window.sessionStorage.setItem(REFRESH_NAVIGATION_KEY, JSON.stringify(snapshot));
    } catch {
      // Refresh must still proceed when sessionStorage is blocked.
    }
  }, [groupQuestionIds, practiceHubTab, query, resultRunId, searchContentScope, searchQuestionId, view]);

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
    prepareForReload,
    resetAfterRestore,
  };
}
