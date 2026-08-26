# Compatibility cleanup audit — 2026-08-26

## Result

This cleanup removes compatibility-only source surfaces introduced to bridge old module ownership. It deliberately does **not** remove compatibility that still protects persisted user data or the current Sync v9 protocol.

## Removed

- `src/lib/sync/change-set-v7.ts` — pure re-export facade; callers now import `change-set-v7-types`, `change-set-v7-codec`, or `change-set-v7-planning` directly.
- `src/lib/sync/sync-v7-head.ts` — pure re-export facade; callers now import the v9 head `types`, `validation`, or `operations` owner directly.
- `src/lib/sync/sync-v7-checkpoint.ts` — pure re-export facade; callers now import checkpoint `types`, `validation`, or `store` directly.
- Zero-call checkpoint aliases: `decodeSyncCheckpointV7`, `validateV7Checkpoint`, `prepareSyncCheckpointV7`, `restoreSyncCheckpointV7`, `applyPreparedSyncCheckpointV7`.
- Zero-call head aliases: `compareV7SegmentOrder`, `isSyncV7Head`, `validateSyncV7Head`.

The repository-wide audit measured every removed alias at zero call sites outside its definition before removal.

## Intentionally retained

The following are active compatibility or migration mechanisms and are not obsolete:

- `sync-v8-history.ts`: current history archive implementation despite its historical internal name.
- Exact v7/v8 `migratedFrom` source pins used only as migration diagnostics.
- Legacy plain-JSON sync decoding required to read existing remote data.
- Asset Pack / per-image one-shot migration logic required for existing vaults.
- Old local database cleanup performed only after a successful v9 install.
- IndexedDB/Safari compatibility paths and persisted elapsed-time fallbacks.
- Legacy question answer projection used for stored/exported question compatibility.
- SideStore compatibility fields required by older installed builds.

PAT/CSP credential policy remains outside this PR by scope.

## Safety criteria

A compatibility path was removed only if it had no runtime behavior, all callers could target an existing canonical owner, no persisted-data migration depended on it, and Sync/Fast/build/governance gates remained intact.

## Protocol red lines

Sync v9 wire format, fixed head/CAS, content addressing, checkpoint/history/tombstone/GC/replay semantics, Asset Pack layout, IndexedDB v7 schema, full-history restore semantics, six official question types, DB transaction atomicity, Practice behavior, strict search-pin geometry, and existing governance ratchets are unchanged.
