/**
 * Domain change-set reducer over CanonicalState only.
 * Device-local projections are rebuilt/updated only after IndexedDB install.
 */
import type { CanonicalState } from "../db/types";
import type { ChangeSetMutation, ChangeSet } from "./change-set-types";
import { assertChangeSet } from "./change-set-codec";
import { normalizeCanonicalState, shallowCanonicalEnvelope } from "./change-set-projection-core";
import { assertCanonicalState, normalizeCanonicalStateForReplay } from "./change-set-derived";
import { applyEntityMutation, type MutationContext } from "./change-set-mutation-entities";
import { applyLearningMutation } from "./change-set-mutation-learning";

function applyMutation(state: CanonicalState, mutation: ChangeSetMutation, context: MutationContext): void {
  if (applyEntityMutation(state, mutation, context)) return;
  if (applyLearningMutation(state, mutation, context)) return;
  throw new Error(`unsupported canonical mutation: ${JSON.stringify(mutation)}`);
}

export function applyChangeSetToOwnedState(state: CanonicalState, changeSet: ChangeSet): CanonicalState {
  assertChangeSet(changeSet);
  const envelope = shallowCanonicalEnvelope(state);
  const context: MutationContext = {
    createdAt: changeSet.createdAt,
    deviceId: changeSet.deviceId,
    eventId: changeSet.id,
    localSequence: changeSet.localSequence,
  };
  for (const mutation of changeSet.mutations) applyMutation(envelope.state, mutation, context);
  return envelope.commit();
}

export function finalizeRebasedState(state: CanonicalState): CanonicalState {
  const normalized = normalizeCanonicalStateForReplay(state);
  assertCanonicalState(normalized);
  return normalized;
}

export function reduceChangeSet(input: CanonicalState, changeSet: ChangeSet): CanonicalState {
  return finalizeRebasedState(applyChangeSetToOwnedState(normalizeCanonicalState(input), changeSet));
}

export function replayChangeSetBatch(
  input: CanonicalState,
  changes: readonly ChangeSet[],
  onStep?: (done: number, total: number) => void,
  options?: { onConflict?: "skip" | "throw" },
): { state: CanonicalState; skipped: string[] } {
  const skip = options?.onConflict !== "throw";
  let good = normalizeCanonicalState(input);
  const skipped: string[] = [];
  const every = Math.max(1, Math.floor(changes.length / 24));
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    try {
      good = applyChangeSetToOwnedState(good, change);
    } catch (error) {
      if (!skip) throw error;
      skipped.push(change.id);
    }
    if (onStep && ((index + 1) % every === 0 || index + 1 === changes.length)) {
      onStep(index + 1, changes.length);
    }
  }
  return { state: finalizeRebasedState(good), skipped };
}

export function reduceChangeSets(input: CanonicalState, changeSets: readonly ChangeSet[]): CanonicalState {
  return replayChangeSetBatch(input, changeSets, undefined, { onConflict: "throw" }).state;
}
