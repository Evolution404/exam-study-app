/**
 * Public barrel for the projection reducer. The implementation is
 * split into layered modules; this facade exposes only the surface consumed by
 * application/runtime code.
 */
export type {
  ChangeSetProjection,
} from "./change-set-projection-core";
export {
  recomputeChangeSetProjection,
  assertChangeSetProjection,
} from "./change-set-derived";
export {
  applyChangeSetToOwnedProjection,
  finalizeRebasedProjection,
  reduceChangeSet,
  replayChangeSetBatch,
  reduceChangeSets,
} from "./change-set-reducer";
