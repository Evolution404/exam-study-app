# CSS Architecture

This document defines the ownership rules for application CSS. The goal is to reduce cascade ambiguity without changing the product's visual contract during migration.

## Entrypoints

- `src/main.tsx` imports `src/app/globals.css`.
- `src/app/globals.css` is an import-only entrypoint and may only import `./styles/components.css`.
- `src/app/styles/components.css` is the global cascade manifest. It owns import order only and must not contain declarations.
- Feature-local styles may be imported directly by the owning React feature when they are intentionally scoped to that feature's loading boundary. `sync-events.css` is the current example.

## Ownership

Put a rule in the narrowest file that owns the rendered UI:

- theme values and semantic colors: `theme-tokens.css`
- reset/base document rules: `base.css`
- reusable low-level surfaces/layout primitives: `primitives.css`
- shared form/button controls: `controls.css`
- shell/navigation: `shell.css`
- feature UI: the corresponding `dashboard.css`, `search.css`, `bank*.css`, `practice*.css`, `preferences.css`, etc.
- reusable image presentation: `asset-image.css`

`globals.css` is never a place for a late override.

## Theme rules

New or refactored UI must use semantic `--color-*` tokens. Do not add page-level `html[data-theme="dark"]` patches for new work. `dark-overrides.css` is migration debt and should only shrink.

## Responsive rules

New responsive rules belong with their owning feature. `responsive.css` is migration debt and should only shrink as rules move back to feature files. Preserve selector specificity and cascade order during mechanical moves before changing layout behavior.

## Shared stylesheet rule

`shared.css` is also migration debt. A selector that belongs to one feature should move to that feature stylesheet. New cross-feature primitives should prefer `primitives.css` or `controls.css` rather than expanding `shared.css`.

## Governance

`scripts/tools/check-css-architecture.mjs` enforces:

- import-only `globals.css` and `components.css`;
- deterministic global cascade order;
- no unregistered stylesheets in `src/app/styles`;
- no new legacy token aliases or CSS Module `:global()` escapes;
- no increase in hard-coded colors, dark-theme patches, or `!important`;
- new stylesheets must stay small and token-based;
- `shared.css`, `responsive.css`, and `dark-overrides.css` may only shrink;
- total CSS and maximum single-file size remain ratcheted by `css-architecture-baseline.json`.

## Migration order

1. Keep `globals.css` declaration-free.
2. Move responsive blocks from `responsive.css` to their owning feature without visual changes.
3. Replace dark overrides with semantic tokens feature by feature.
4. Move single-feature selectors out of `shared.css`.
5. Delete migration-only aggregate files when they reach zero.
