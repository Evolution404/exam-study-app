# Current-format cleanup audit — 2026-08-26

## Result

The application now treats the latest persisted and Sync v9 shapes as the only supported data contract. Historical aliases, shape normalization, repair/backfill paths, and question-answer projections are not used to read or reconstruct older data.

## Current-only question contract

- `QuestionV7.solution` is required and is the single canonical persisted/synchronized answer representation.
- Persisted `Question.answer`, `legacyAnswerForSolution`, and answer-to-solution reconstruction paths are removed.
- JSON/bundle export writes structured `solution`; spreadsheet answer cells remain an explicit current import/export boundary representation rather than stored question state.
- Fingerprints, sync mutations, practice grading, copy, editor, and display paths consume the canonical solution.

## Current-only checkpoint and projection contract

- Checkpoint validation accepts the current v9 shape directly; historical shape normalizers and aliases are removed.
- Projection membership state uses the canonical `memberships` key; there is no projection alias for the local `bankQuestionMemberships` table name.
- Practice-run statistics are not repaired by adding missing historical keys.
- Review-round progress rows are created with complete attempt/evidence fields on the first attempt; no zero-attempt or missing-field repair skeleton is used.
- Current practice metrics reject missing or invalid elapsed time and missing submitted/status timestamps instead of reconstructing them from older fields.

## Descriptor size contract

- `SyncV7Descriptor.storedSize` is required.
- Descriptor reads consume the recorded wire size directly; `readBlobWireSize` and descriptor size backfill are removed.
- Offloaded payload references intentionally use a separate logical-content expectation (`size` + digest), because they are content references rather than wire descriptors. This keeps the descriptor contract strict without inventing a stored size for payload refs.

## Removed retired surfaces

- Pure re-export sync facades and zero-call aliases were removed; callers import canonical owners directly.
- Retired endpoint conversion and historical rebuild paths were removed.
- Obsolete type aliases and misleading historical naming were removed where they no longer describe current behavior.
- Temporary `tmp-latest-only-*` scripts/workflows are not part of the final tree.

## Intentionally retained current-environment resilience

Only behavior needed by current supported environments remains, including Safari/IndexedDB lifecycle handling, WebCrypto-independent digest execution when the native primitive is unavailable, Worker-to-main-thread execution paths, CompressionStream/plain-JSON current wire support, and browser capability handling such as clipboard/image rendering. These paths do not migrate or reinterpret historical persisted data.

## Verification

The current-only cleanup is verified by the full Sync suite, fast checks, production build, structural dead-code gate, architecture check, export-surface ratchet, workflow hygiene, Sync storage CI, governance audit, PR preview, and Chromium/WebKit browser smoke gates. The pre-head verifier must pass the full local-equivalent suite before producing its cleanup commit; the final user-authored head is then validated independently by the repository's normal PR workflows. Exact-head run identifiers are recorded in PR #32 after the final head completes.
