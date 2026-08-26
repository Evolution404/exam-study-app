# Current-format cleanup audit — 2026-08-26

## Result

The application now treats the latest persisted and Sync v9 shapes as the only supported data contract. Historical aliases, shape normalization, repair/backfill paths, and question-answer projections are not used to read or reconstruct older data.

## Current-only question contract

- `QuestionV7.solution` is required and is the single canonical persisted/synchronized answer representation.
- Persisted `Question.answer`, `legacyAnswerForSolution`, and answer-to-solution reconstruction paths are removed.
- JSON/bundle export writes structured `solution`; spreadsheet answer cells remain an explicit current import/export boundary representation rather than stored question state.
- Fingerprints, sync mutations, practice grading, copy, editor, and display paths consume the canonical solution.
- Choice solutions are integrity-checked at import and checkpoint boundaries: the answer set must be non-empty and unique, and every `correctOptionId` must reference a real current option id. Invalid textual answers that resolve to no option are rejected at import instead of creating a locally-invalid question.

## Current-only checkpoint and projection contract

- Checkpoint validation accepts the current v9 shape directly; historical shape normalizers and aliases are removed.
- Projection membership state uses the canonical `memberships` key; there is no projection alias for the local `bankQuestionMemberships` table name.
- Practice-run statistics are not repaired by adding missing historical keys.
- Review-round progress rows are created with complete attempt/evidence fields on the first attempt; no zero-attempt or missing-field repair skeleton is used.
- Current practice metrics reject missing, non-finite, or negative elapsed time and missing submitted/status timestamps instead of reconstructing them from older fields.
- Valid timing outliers remain valid evidence: sub-second and over-20-minute correct attempts do not throw merely because they are excluded from the personal speed baseline.

## Stable local sync identity

The published local keys `shijuan-study-v7-device-id` and `shijuan-study-v7-sequence*` are intentionally retained. They are stable identifiers for the current device identity and sequence allocator, not historical-schema fallbacks. Renaming them would make an existing current installation appear as a new sync device and could unnecessarily retain the prior device watermark in tombstone-GC decisions.

The architecture guard therefore continues to reject actual old database namespaces and migration APIs while allowing these exact stable identity keys.

## Descriptor size contract

- `SyncV7Descriptor.storedSize` is required.
- Descriptor reads consume the recorded wire size directly; `readBlobWireSize` and descriptor size backfill are removed.
- Offloaded payload references intentionally use a separate logical-content expectation (`size` + digest), because they are content references rather than wire descriptors. This keeps the descriptor contract strict without inventing a stored size for payload refs.

## Removed retired surfaces

- Pure re-export sync facades and zero-call aliases were removed; callers import canonical owners directly.
- Retired endpoint conversion and historical rebuild paths were removed.
- Obsolete type aliases and misleading historical naming were removed where they no longer describe current behavior.
- Temporary `tmp-latest-only-*` / side-effect-verifier workflows are not part of the final tree.

## Intentionally retained current-environment resilience

Only behavior needed by current supported environments remains, including Safari/IndexedDB lifecycle handling, WebCrypto-independent digest execution when the native primitive is unavailable, Worker-to-main-thread execution paths, CompressionStream/plain-JSON current wire support, and browser capability handling such as clipboard/image rendering. These paths do not migrate or reinterpret historical persisted data.

## Verification

The three post-review side-effect fixes were verified together before commit by:

- the full Sync suite, including DB/import, checkpoint validation, multi-device, CAS, coalescing, restore, compression, replay, install fingerprint, and tombstone GC;
- fast checks, including explicit regression assertions for valid sub-second/long timing outliers;
- production build;
- dead-code, architecture, export-surface, and workflow-hygiene gates;
- `git diff --check`.

The resulting verified code commit is `71ae4f3ebaf566616355285c2959477c69aeb322` (`fix: remove cleanup side effects [latest-only-verified]`). A normal user-authored documentation commit follows it so the final exact head is independently validated by the repository's normal PR workflows. Exact-head run identifiers are recorded in PR #32 after those workflows complete.
