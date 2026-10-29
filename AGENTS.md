# AGENTS.md

## Local development

- Daily startup is `pnpm dev` from the repository root; use `http://localhost:5176/`.
- It resumes the existing PostgreSQL workspace in `.runtime/review-postgres.json`, starts all four services, and serves Web with Vite hot reload. Restart the same command after backend or shared-contract edits.
- Do not introduce another daily launcher, parallel memory workspace, or separate service commands. `check:*` scripts remain isolated verification tools.
- Preserve existing development data and upstream opt-in settings. Do not delete the state file/schema to resolve startup failures.

## UI work is contract-first

Before changing anything under `apps/web`, read:

1. [组件选型与样式契约](docs/product/ui-component-contract-v1.md) — mandatory. It defines which component to use, its anatomy, states and anti-patterns.
2. [Signal Atlas 日光界面说明](docs/product/signal-atlas-v2-signal-desk.md) — current shell, layouts and verification status.
3. [UI 与 AI Coding 约束](docs/product/token-operations-ui-coding-guidelines-v0.1.md) — product-wide interaction rules.

Current review build: [Signal Atlas 信标版审核界面](docs/product/signal-atlas-v5-beacon-review.md) (`data-ui="beacon"`, switchable from the top-right 界面 control). Work in progress there — treat it as the design target for new UI work, and do not regress the four existing shells (`azure` / `sidebar` / `next` / `classic`). The previous review build, [Signal Atlas 蓝灰版审核界面](docs/product/signal-atlas-v3-azure-review.md) (`data-ui="azure"`), stays selectable and remains the source of the v4 shell (`apps/web/src/v4.tsx`, `design-v4.css`) that Beacon reuses.

Non-negotiable:

- Multi-select form fields use `Field type="multiple"` → `MultiSelect` (chips + search + select-all/clear). Never `<select multiple>`, never a horizontal checkbox wall, never a page-local replacement.
- Every date and date-time field uses `DateField` (`Field type="date"` / `type="datetime"` in forms, the component directly in filter bars). Never `<input type="date">`, `<input type="datetime-local">`, three year/month/day selects, or a page-local calendar.
- Every password, passphrase and one-time secret uses `PasswordInput` — masked by default with an eye toggle that reveals the value. Never a bare `<input type="password">`, never a password field without a way to check what was typed, never plaintext by default.
- Reuse `Field`, `DateField`, `PasswordInput`, `MultiSelect`, `Modal`, `EditorDialog`, `Table`, `Status`, `DetailGroup`, the person-list pattern, the filter-bar pattern, the stat-strip pattern, the task-hero pattern and the quota-ribbon pattern. Do not invent a one-off visual component.
- A new visual language is a theme layer, not a rewrite: add a `design-vN.css` scoped to `html[data-ui="..."]` and switch the shell through `ui-mode.ts`. Do not restructure pages, and do not import anything from `docs/design-reference/**` (read-only reference, never in the bundle).
- `design-v4.css` is shared by two shells (`azure`, `beacon`), so its rules must not be left unscoped when they override an active-state child: `.v4-tab.active .v4-tab-select` (three classes) silently outranks a theme's `html[data-ui="beacon"] .v4-tab-select` (two classes plus an attribute). Scope such shared rules to `html[data-ui="azure"]` and give the theme its own equivalent — do not settle it with a specificity guess.
- Component theme CSS must not set `display` on bare `label` selectors: row components (`.person-row`, `.plan-choice`, `.key-check`) are `<label>` elements that need their own layout.
- One `.primary` per task area. Dangerous actions use `.danger-button` plus impact/confirmation.
- Implement empty, loading, error, denied, disabled and busy states before visual polish.
- No page-specific visual CSS for a shared pattern. Extend the contract and tokens instead.
- Verify with `pnpm --filter @ai-gateway/web typecheck`, `pnpm --filter @ai-gateway/web build`, 1440/390 screenshots, keyboard paths and no page-level horizontal overflow.
