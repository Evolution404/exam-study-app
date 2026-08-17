/**
 * Public barrel for the pure v7 projection reducer.  The implementation is
 * split into layered modules:
 * - change-set-v7-projection-core: types, tools, base operations
 * - change-set-v7-cascade: cascade delete helpers
 * - change-set-v7-derived: derived statistics and validation
 * - change-set-v7-reducer: event reducer and batch replay
 *
 * The exported surface below is identical to the previous single-file module.
 */
export type {
  ChangeSetProjectionV7,
  ChangeSetProjectionInputV7,
  ProjectionValidationIssueV7,
} from "./change-set-v7-projection-core";
export {
  recomputeChangeSetProjectionV7,
  projectionValidationIssuesV7,
  validateChangeSetProjectionV7,
  assertChangeSetProjectionV7,
} from "./change-set-v7-derived";
export {
  applyChangeSetToOwnedProjectionV7,
  finalizeRebasedProjectionV7,
  reduceChangeSetV7,
  replayChangeSetBatchV7,
  applyChangeSetV7,
  applyV7ChangeSet,
  reduceChangeSetsV7,
  replayChangeSetsV7,
} from "./change-set-v7-reducer";
