# CSS Architecture

This document defines the ownership rules for application CSS. The goal is to reduce cascade ambiguity without changing the product's visual contract during migration.

## Entrypoints

- `src/main.tsx` imports `src/app/globals.css`.
- `src/app/globals.css` is an import-only entrypoint and may only import `./styles/components.css`.
- `src/app/styles/components.css` is the global cascade manifest. It owns import order only and must not contain declarations.
- The manifest may import CSS from `src/app/styles` or a feature directory when that file is intentionally part of the global cascade. Feature token files are loaded immediately after the core token layer.
- Feature-local styles may be imported directly by the owning React feature when they are intentionally scoped to that feature's loading boundary. `sync-events.css` is the current example.
- Responsive migration files may live beside their owning feature and remain imported from `responsive.css` while cascade-compatible extraction is in progress. `search/search-responsive.css`, `bank/bank-responsive.css`, `practice/practice-responsive.css`, and `shell/shell-responsive.css` are current examples.

## Ownership

Put a rule in the narrowest file that owns the rendered UI:

- cross-feature theme values, geometry, motion, and shared semantic colors: `styles/theme-tokens.css`
- feature-owned theme values: `<feature>/<feature>-tokens.css` (currently `shell/shell-tokens.css` and `practice/practice-tokens.css`)
- reset/base document rules: `base.css`
- reusable low-level surfaces/layout primitives: `primitives.css`
- shared form/button controls: `controls.css`
- shell/navigation: `shell.css`
- feature UI: the corresponding `dashboard.css`, `search.css`, `bank*.css`, `practice*.css`, `preferences.css`, etc.
- reusable image presentation: `asset-image.css`

`globals.css` is never a place for a late override.

## Theme rules

New or refactored UI must use semantic tokens. Do not add page-level `html[data-theme="dark"]` patches for new work. `dark-overrides.css` is migration debt and should only shrink.

Token ownership follows the same narrowest-owner rule as selectors:

- `styles/theme-tokens.css` is the core layer for values shared across features.
- A feature with a meaningful palette may own `<feature>-tokens.css`; it must be registered in the global cascade before any consumer stylesheet. Shell and Practice are the first migrated owners.
- Light and dark values for the same feature stay together in that feature token file.
- Every registered token file has an independent 16 KiB ceiling. Splitting tokens is for ownership, not for rebuilding a new monolith.
- Hard-coded color literals are allowed inside registered token files only on custom-property declarations. Token files must not use `!important`.
- Business CSS outside registered token files remains subject to the hard-coded color ratchet.

## Responsive rules

New responsive rules belong with their owning feature. `responsive.css` is migration debt and should only shrink as rules move back to feature files. Preserve selector specificity and cascade order during mechanical moves before changing layout behavior.

During migration, a feature-specific responsive file may be imported by `responsive.css` to keep it in the responsive cascade stage. Once `responsive.css` no longer contains cross-feature rules, those files can move to their final feature loading boundary as a separate, testable change.

## Shared stylesheet rule

`shared.css` is also migration debt. A selector that belongs to one feature should move to that feature stylesheet. New cross-feature primitives should prefer `primitives.css` or `controls.css` rather than expanding `shared.css`.

## Governance

`scripts/tools/check-css-architecture.mjs` enforces:

- import-only `globals.css` and `components.css`;
- deterministic global cascade order, including registered feature token files;
- no unregistered root stylesheets in `src/app/styles`;
- no new legacy token aliases or CSS Module `:global()` escapes;
- each registered token file stays within 16 KiB and keeps hard-coded colors inside custom-property declarations;
- no increase in hard-coded colors, dark-theme patches, or `!important` in business CSS;
- structural entrypoint bytes (`globals.css` and `components.css`) are excluded from the business-style debt score because their content is governed separately by exact entrypoint checks;
- new non-token stylesheets must stay small and token-based;
- `shared.css`, `responsive.css`, and `dark-overrides.css` may only shrink;
- total CSS debt and maximum single-file size remain ratcheted by `css-architecture-baseline.json`.

## Migration order

1. Keep `globals.css` declaration-free.
2. Move responsive blocks from `responsive.css` to their owning feature without visual changes.
3. Replace dark overrides with semantic tokens feature by feature, placing feature-owned values in feature token files.
4. Move single-feature selectors out of `shared.css`.
5. Delete migration-only aggregate files when they reach zero.
