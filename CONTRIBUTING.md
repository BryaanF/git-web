# Contributing to GitDock Web

Thank you for your interest in contributing to **GitDock Web**!

## Prerequisites

- **Node.js `>= 22.18.0`** (uses native erasable TypeScript execution directly — no backend build step)
- **Git** CLI available in `PATH`
- **npm**

## Local Setup

```bash
git clone https://github.com/BryaanF/git-web.git
cd git-web
npm install
npm run verify
```

`npm install` runs `scripts/install-hooks.ts`, which configures repository-local `core.hooksPath` to `.githooks` (unless running in CI or you already have a custom `core.hooksPath` configured — pass `--force` to `npm run hooks:install` to switch).

## Development Workflow

```bash
# Start watch backend + Vite HMR UI (auto port selection)
npm run dev

# Interactive service & port picker
npm run dev:pick

# Production build & local single-port serve
npm run build
npm start -- --repo /path/to/your-repo
```

### Verification Commands

Before opening a pull request, make sure every check passes:

```bash
npm run typecheck    # tsc --noEmit across src/, scripts/, tests/, vite.config.ts
npm run build        # tsc --noEmit && vite build -> dist/client
npm test             # Sequential node --test suite (tests/*.test.ts)
npm run test:perf    # Build if needed + enforce latency & bundle size SLAs
```

## Coding Conventions

- **Strict Erasable TypeScript**: `tsconfig.json` enables `erasableSyntaxOnly: true` and `NodeNext`. Never use `enum`, `namespace`, or constructor parameter properties (`private foo`), and always include `.ts`/`.tsx` extensions in relative imports.
- **Shared Module Boundaries**: Keep `src/shared/*` free of Node built-ins and DOM globals.
- **Process & Path Safety**: Always spawn binaries with `shell: false`. Route working-tree paths through `assertSafeRepoPath` and keep read-only Git calls marked `{ readOnly: true }`.
- **Client API**: Route browser API calls through `requestJson` in `src/client/api.ts` so auth and anti-CSRF headers stay consistent.

## Commit Message Standard (Required)

Every commit in this repository is checked locally by `.githooks/commit-msg` and in CI by `.github/workflows/commit-standard.yml`:

- **Format**: `<type>(<scope>): <summary>` or `<type>: <summary>`
- **Allowed `<type>` values (only 4)**:
  - `bugfix` — bug fixes, regressions
  - `features` — new user-facing features, APIs, CLI flags
  - `chores` — config, deps, build, docs, CI, hooks, tests
  - `improvement` — performance optimization, refactor, UX polish
- **Header length**: `<= 50` characters total (`MAX_COMMIT_SUBJECT_LENGTH = 50`).
- **Description body**: explain *what* changed and *why* in the commit body after a blank line.

Test a commit header locally at any time:

```bash
npm run check:commit -- --message "features(ui): add workspace root hint"
```

See [docs/commit-standard.md](docs/commit-standard.md) for full details.

## Pull Request Process

1. Keep PRs focused and split unrelated changes into separate commits.
2. Add or update unit/integration tests in `tests/` for behavioral changes.
3. Update `README.md`, `AGENTS.md`, or `docs/` if you change CLI flags, API routes, or conventions.
4. Complete the checklist in [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md).
