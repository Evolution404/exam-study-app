/** Canonical change-set reducer facade. */
export { assertCanonicalState, canonicalStateValidationIssues, normalizeCanonicalStateForReplay } from "./change-set-derived";
export {
  applyChangeSetToOwnedState,
  finalizeRebasedState,
  reduceChangeSet,
  replayChangeSetBatch,
  reduceChangeSets,
} from "./change-set-reducer";
