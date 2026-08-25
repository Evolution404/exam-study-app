# CSS Architecture

This document defines the ownership rules for application CSS. PR #26 completed the migration from aggregate stylesheets to feature-owned layers while preserving the product's cascade and visual contract.

## Entrypoints

- `src/main.tsx` imports `src/app/globals.css`.
- `src/app/globals.css` is an import-only entrypoint and may only import `./styles/components.css`.
- `src/app/styles/components.css` is the global cascade manifest. It owns import order only and must not contain declarations.
- The manifest may import CSS from `src/app/styles` or a feature directory when that file is intentionally part of the global cascade. Feature token files are loaded immediately after the core token layer.
- Feature-local styles may be imported directly by the owning React feature when they are intentionally scoped to that feature's loading boundary. The split Sync event styles are loaded in their original order rather than rebuilt into a monolith.
- Responsive feature files may live beside their owning feature. `responsive.css` is now an import manifest; truly cross-feature responsive compatibility remains in an explicit shared layer.

## Ownership

Put a rule in the narrowest file that owns the rendered UI:

- cross-feature theme values, geometry, motion, and shared semantic colors: `styles/theme-tokens.css`
- exact legacy palette values that cannot yet be expressed semantically without changing computed values: `styles/palette-tokens.css`
- feature-owned theme values: `<feature>/<feature>-tokens.css`
- reset/base document rules: `base.css`
- reusable low-level surfaces/layout primitives: `primitives.css`
- shared form/button controls: `controls.css`
- shell/navigation: `shell.css`
- feature UI: the corresponding Dashboard, Search, Bank, Practice, Sync, Preferences, and Knowledge stylesheets
- reusable image presentation: `asset-image.css`

`globals.css` is never a place for a late override. A feature selector must not be moved back into an aggregate stylesheet merely to satisfy a source-shape test; tests must read the final ownership graph.

## Theme rules

New or refactored UI must use tokens. Do not add page-level `html[data-theme="dark"]` patches for feature work. `dark-overrides.css` is a compatibility layer and remains ratcheted so it can only shrink.

Token ownership follows the same narrowest-owner rule as selectors:

- `styles/theme-tokens.css` is the core layer for values shared across features.
- A feature with a meaningful palette may own `<feature>-tokens.css`; it must be registered in the global cascade before any consumer stylesheet.
- Light and dark values for the same feature stay together in that feature token file.
- Every registered token file has an independent 16 KiB ceiling. Splitting tokens is for ownership, not for rebuilding a new monolith.
- Hard-coded color literals are allowed inside registered token files only on custom-property declarations. Token files must not use `!important`.
- Business CSS outside registered token files must contain zero hard-coded hex colors.
- Generic compatibility rules that require `!important` must expose an inheritable custom property when a feature legitimately needs a different value. Search dark inputs use this pattern rather than a centralized Search-specific dark patch.

## Responsive rules

Responsive rules belong with their owning feature. `responsive.css` is an import manifest, not a dumping ground for new feature selectors. Preserve selector specificity and cascade order when moving an existing rule; behavior changes require their own regression coverage.

Cross-feature responsive compatibility must be explicit and independently reviewable. Do not move feature rules back into the shared responsive layer to avoid feature ownership.

## Shared rules

The former monolithic `shared.css` has been removed. Remaining shared-core slices contain genuinely cross-feature presentation primitives and retain their original cascade order. A selector that belongs to one feature must live with that feature. New cross-feature primitives should prefer `primitives.css` or `controls.css` rather than creating another aggregate stylesheet.

Large business stylesheets are split only at top-level CSS rule boundaries. Never split inside a selector, media block, or keyframes rule, and never use splitting to reorder cascade semantics.

## Governance

`scripts/tools/check-css-architecture.mjs` enforces:

- import-only `globals.css` and `components.css`;
- deterministic global cascade order, including registered feature token files;
- no unregistered root stylesheets in `src/app/styles`;
- no new legacy token aliases or CSS Module `:global()` escapes;
- each registered token file stays within 16 KiB and keeps hard-coded colors inside custom-property declarations;
- **zero non-token hard-coded hex colors**;
- **every CSS file stays below the 16 KiB hard ceiling**;
- no increase in dark-theme compatibility selectors or `!important` debt;
- structural entrypoint bytes (`globals.css` and `components.css`) are excluded from the business-style debt score because their content is governed separately by exact entrypoint checks;
- new non-token stylesheets must stay small and token-based;
- total CSS debt and maximum single-file size remain ratcheted by `css-architecture-baseline.json`.

The PR #26 final baseline is 44 CSS files, zero non-token hard-coded hex colors, a 13,874-byte largest stylesheet, zero `:global()` escapes, zero legacy token aliases, and six registered token files. The debt ratchet must improve or stay flat; feature work is not allowed to raise the baseline to pay for new CSS.

## Regression-test contract

Source-shape tests must follow the final ownership graph rather than assuming every stylesheet lives in `src/app/styles`. Tests that validate cross-feature presentation should recursively read `src/app/**/*.css`; a test for an intentionally split feature may read the ordered feature slices directly.

Question-type UI must expose every supported production type. In particular, Bank management must retain `填空` and `简答` alongside the choice, judgment, and calculation types. Short-answer practice owns its textarea, reference-answer card, self-grading actions, and submitted-result presentation; regression tests prevent these controls from falling back to browser-default layout or duplicating the full reference answer in the result summary.

## Maintenance order

1. Add or change feature styles in the owning feature layer.
2. Reuse semantic tokens before introducing an exact palette token.
3. Remove equivalent transitional declarations when new feature CSS would otherwise increase debt.
4. Run Fast checks and CSS architecture governance before browser smoke tests.
5. Treat Chromium/WebKit geometry and PWA preview checks as required merge gates for CSS-affecting changes.
