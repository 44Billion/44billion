# AGENTS.md

This document is the primary brief for AI assistants working on this repository. Read it in full before making changes.

## Project Overview

44billion is a Nostr app (napp) launcher. UI components are built with the sibling
[`thenameisf`](../f) framework — custom elements with signals-based reactivity,
light DOM, and no per-component build step (esbuild only bundles the app). Follow
the framework's component conventions: `f('tag', ...)` declarations, signal props,
`useStore`/`useTask`, and light-DOM slots.

## Styling Rules

- **Colors come from [`src/assets/styles/theme.js`](src/assets/styles/theme.js).**
  It is the single source of authored UI colors. Each token is a
  `light-dark(<light>, <dark>)` pair resolved natively from `prefers-color-scheme`
  (via `color-scheme: light dark` in `global.css`), or a relative color expression
  derived from another token (`oklch(from var(--token) l c h / NN)`). Do not author
  color literals (`oklch(...)`, `#hex`, `rgb(...)`, `light-dark(...)`) outside
  `theme.js` (or the `inverted-colors` accessibility rule in `reset.css`); consume
  tokens via `cssVars.colors.*` (which expand to `var(--token)`). UGC media (avatar
  photos, images, video) must never receive theme inversion filters.
- **Component styles are global — always scope them.** thenameisf renders a
  component's `<style>` tag into the light DOM, so every rule applies
  document-wide. Never write top-level class selectors inside a component's
  `<style>` block; nest every rule under the component's host tag or a
  component-specific root id (e.g. `#confirmation-dialog-card { .title { ... } }`).
  An unscoped `.title` in one view leaks into every other component that happens
  to use that class.
- The CSS reset sets `html { font-size: 0.0625em }`, so `1rem ≈ 1px`: use `rem`
  for `font-size` only and `px` for everything else.

## Testing

- Run `npm test` (Node built-in test runner) and keep the theme test
  (`tests/helpers/theme.test.js`) green — it enforces token format, WCAG contrast
  pairs, and the absence of authored color literals outside `theme.js`.

## Persisted state

- Every localStorage/sessionStorage key or IndexedDB store must be documented in
  [`docs/storage-model.md`](docs/storage-model.md) and registered in
  [`src/constants/storage-schema.js`](src/constants/storage-schema.js) in the
  same change that introduces it.
- When changing storage or lifecycle behavior, check all three in the same
  change: `docs/storage-model.md`, `src/constants/storage-schema.js`, and
  `src/services/storage-audit/audit.js` (plus `repair.js` if cleanup changes).
  Update them whenever a persisted key/template, an IndexedDB store, or an
  audit invariant changes. In-memory registry keys are not persisted and do
  not need registration.
- The launcher runs a two-phase storage audit on load: the post-render pass
  detects inconsistent workspace/app/account state and schedules a repair
  reload; the pre-render pass applies the pending repair plan. Keep the audit
  pure, prefer existing cleanup routines, and preserve unknown keys.
