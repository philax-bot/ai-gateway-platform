# AGENTS.md

## UI work is contract-first

Before changing anything under `apps/web`, read:

1. [组件选型与样式契约](docs/product/ui-component-contract-v1.md) — mandatory. It defines which component to use, its anatomy, states and anti-patterns.
2. [Signal Atlas 日光界面说明](docs/product/signal-atlas-v2-signal-desk.md) — current shell, layouts and verification status.
3. [UI 与 AI Coding 约束](docs/product/token-operations-ui-coding-guidelines-v0.1.md) — product-wide interaction rules.

Current review build: [Signal Atlas 蓝灰版审核界面](docs/product/signal-atlas-v3-azure-review.md) (`data-ui="azure"`, switchable from the top-right 界面 control). Work in progress there — treat it as the design target for new UI work, and do not regress the three existing shells.

Non-negotiable:

- Multi-select form fields use `Field type="multiple"` → `MultiSelect` (chips + search + select-all/clear). Never `<select multiple>`, never a horizontal checkbox wall, never a page-local replacement.
- Every date and date-time field uses `DateField` (`Field type="date"` / `type="datetime"` in forms, the component directly in filter bars). Never `<input type="date">`, `<input type="datetime-local">`, three year/month/day selects, or a page-local calendar.
- Every password, passphrase and one-time secret uses `PasswordInput` — masked by default with an eye toggle that reveals the value. Never a bare `<input type="password">`, never a password field without a way to check what was typed, never plaintext by default.
- Reuse `Field`, `DateField`, `PasswordInput`, `MultiSelect`, `Modal`, `EditorDialog`, `Table`, `Status`, `DetailGroup`, the person-list pattern, the filter-bar pattern and the stat-strip pattern. Do not invent a one-off visual component.
- Component theme CSS must not set `display` on bare `label` selectors: row components (`.person-row`, `.plan-choice`, `.key-check`) are `<label>` elements that need their own layout.
- One `.primary` per task area. Dangerous actions use `.danger-button` plus impact/confirmation.
- Implement empty, loading, error, denied, disabled and busy states before visual polish.
- No page-specific visual CSS for a shared pattern. Extend the contract and tokens instead.
- Verify with `pnpm --filter @ai-gateway/web typecheck`, `pnpm --filter @ai-gateway/web build`, 1440/390 screenshots, keyboard paths and no page-level horizontal overflow.
