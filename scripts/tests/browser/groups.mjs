import { runDesktop } from "./specs/desktop.mjs";
import { runTopbarMobile, runMobile } from "./specs/mobile.mjs";
import { runManagementQA } from "./specs/management.mjs";
import { runReviewRounds } from "./specs/review.mjs";
import { runSearchBatch } from "./specs/search.mjs";
import { runSearchPinMobile } from "./specs/search-pin.mjs";
import { runSelectToggleMobile } from "./specs/select-toggle.mjs";
import { runHistoryResult } from "./specs/history.mjs";
import { runPracticeSetupComboQA } from "./specs/practice.mjs";
import { runInFlightDeletionQA } from "./specs/inflight.mjs";
import { runSyncRefreshQA } from "./specs/sync-refresh.mjs";
import { runDarkModeAudit } from "./specs/dark.mjs";
import { runDarkEditorSelectionQA } from "./specs/dark-editor-selection.mjs";

export const GROUPS = [
  { key: "desktop", run: runDesktop, viewport: { width: 1440, height: 960 }, minScreenshots: 12 },
  { key: "topbar-mobile", run: runTopbarMobile, viewport: { width: 390, height: 844 }, isMobile: true, minScreenshots: 1 },
  { key: "select-toggle-mobile", run: runSelectToggleMobile, viewport: { width: 390, height: 844 }, isMobile: true, minScreenshots: 1 },
  { key: "mobile", run: runMobile, viewport: { width: 390, height: 844 }, isMobile: true, requires: ["desktop"], minScreenshots: 6 },
  { key: "management", run: runManagementQA, viewport: { width: 1440, height: 960 }, minScreenshots: 8 },
  { key: "review", run: runReviewRounds, viewport: { width: 1440, height: 960 }, minScreenshots: 3 },
  { key: "search", run: runSearchBatch, viewport: { width: 1440, height: 960 }, minScreenshots: 4 },
  { key: "search-pin", run: runSearchPinMobile, viewport: { width: 390, height: 844 }, isMobile: true, minScreenshots: 1 },
  { key: "history", run: runHistoryResult, viewport: { width: 1440, height: 960 }, minScreenshots: 3 },
  { key: "practice-combo", run: runPracticeSetupComboQA, viewport: { width: 1440, height: 960 }, minScreenshots: 2 },
  { key: "inflight", run: runInFlightDeletionQA, viewport: { width: 1440, height: 960 }, minScreenshots: 3 },
  { key: "sync-refresh", run: runSyncRefreshQA, viewport: { width: 1440, height: 960 }, minScreenshots: 3 },
  { key: "dark", run: runDarkModeAudit, viewport: { width: 1440, height: 960 }, minScreenshots: 1 },
  { key: "dark-editor-selection", run: runDarkEditorSelectionQA, viewport: { width: 1440, height: 960 }, minScreenshots: 1 },
];
