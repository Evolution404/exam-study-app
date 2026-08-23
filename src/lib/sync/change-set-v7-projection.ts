/**
 * Public barrel for the pure v7 projection reducer. The implementation is
 * split into layered modules; this facade exposes only the surface consumed by
 * application/runtime code.
 */
export type {
  ChangeSetProjectionV7,
} from "./change-set-v7-projection-core";
export {
  recomputeChangeSetProjectionV7,
  assertChangeSetProjectionV7,
} from "./change-set-v7-derived";
export {
  applyChangeSetToOwnedProjectionV7,
  finalizeRebasedProjectionV7,
  reduceChangeSetV7,
  replayChangeSetBatchV7,
  reduceChangeSetsV7,
} from "./change-set-v7-reducer";
