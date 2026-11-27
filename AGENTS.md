# AGENTS.md — GitDock Web Engineering & Agent Guide

> Concise repository map, invariants, and agent rules for **GitDock Web** (`gitdock-web`). Detailed operational guides live in [`docs/`](docs/):
> - [Commit Standard & GitHub Workflow](docs/commit-standard.md)
> - [Runner, Ports & Networking Guide](docs/runner-and-networking.md)
> - [Testing & Performance SLAs](docs/testing-and-performance.md)

---

## 1. Project Identity & Core Goals

**GitDock Web** is a mobile-first web companion for GitHub Desktop–style workflows: inspecting **unstaged**, **untracked**, **staged**, **conflicted**, and **verified pushed vs. unpushed** diffs over LAN or Tailscale without touching privileged web ports (`80` / `443`).

- **Zero-Build Native TypeScript Backend**: Node.js `>= 22.18` / `26.x` runs `.ts` directly (`node src/server/index.ts`, `node scripts/dev.ts`, `node --test`).
- **Single-Port Production & Coordinated Dev Runner**: Production (`npm start`) serves `/api/*` and `dist/client` from one unprivileged port (`7745` default). Dev (`npm run dev`) coordinates `--watch` backend and Vite HMR (`5173` default) with dynamic conflict-free port resolution.
- **Native Git CLI Engine**: Shells out via `execFile('git', ..., { shell: false })` with `-c core.quotepath=false` and bounded per-repo concurrency (`MAX_CONCURRENT_PER_REPO = 4`).
- **Mobile-First Diff UI**: React 19 + Tailwind CSS v4 + `@git-diff-view/react` defaulting to `Unified` + word-wrap on mobile (`Split` available on desktop).

---

## 2. Mandatory Agent & GitHub Commit Standard

Whenever asked to **commit** changes or prepare commits/PRs in this repository, **always** enforce the 4-type standard (full guide in [docs/commit-standard.md](docs/commit-standard.md)):

- **Format**: `<type>(<scope>): <summary>` or `<type>: <summary>`.
- **Summary & Description Rule**:
  - Header line (`summary`) must be a concise high-level outline capped at **`<= 50` characters** (`MAX_COMMIT_SUBJECT_LENGTH = 50`) so commit titles never truncate.
  - Always include a detailed commit **description (body)** separated by a blank line (`git commit -m "<summary>" -m "<detailed body>"`) explaining what changed and why.
- **Only 4 canonical `<type>` values are allowed**:
  - `bugfix` — bug fixes, error fixes, regressions (replaces `fix`/`hotfix`)
  - `features` — new user-facing features, APIs, CLI flags (replaces `feat`)
  - `chores` — config, deps, build, docs, CI, Git hooks, tests (replaces `chore`/`docs`/`ci`)
  - `improvement` — performance optimization, refactor, UX polish (replaces `perf`/`refactor`)
- **Required workflow when executing any commit request**:
  1. Inspect `git status` and diffs first; split unrelated types into logical commits unless asked to combine.
  2. Never use aliases like `feat:`, `fix:`, `chore:`, `refactor:` or bypass validation with `--no-verify`.
  3. Keep summary header `<= 50` chars and place full implementation details in the commit description body.
  4. Validate header if needed with `npm run check:commit -- --message "<header>"` (`scripts/validate-commit-msg.ts`).
  5. Automatic enforcement runs via `.githooks/commit-msg` (auto-installed on `npm install` via `prepare` / `npm run hooks:install`), GitDock Web's Commit Composer (`ChangesTab.tsx`), and GitHub Actions ([`.github/workflows/commit-standard.yml`](.github/workflows/commit-standard.yml)).

---

## 3. Core Commands

| Command | Purpose |
| :--- | :--- |
| `npm run dev` / `dev:pick` | Dev runner (backend watch + Vite HMR + auto proxy) / interactive port picker |
| `npm run start` / `start:ts` | Serve `/api/*` + `dist/client` (`start:ts` binds `127.0.0.1:8001` for Tailscale `:8443`) |
| `npm run build` | `tsc --noEmit && vite build` into `dist/client` |
| `npm run typecheck` | Static TS verification across `src/`, `scripts/`, `tests/`, `vite.config.ts` |
| `npm test` / `npm run test:perf` | Native `node --test` suite / sequential SLA + bundle budget check |
| `npm run verify` | Full verification (`typecheck` + `build` + `test`) |
| `npm run check:commit` / `hooks:install` | Validate commit messages/ranges or configure local `core.hooksPath` -> `.githooks` |
| `npm run pm2:setup` / `pm2:remove` | Run unattended via global PM2 + install/remove Windows Startup auto-launch |

> See [docs/runner-and-networking.md](docs/runner-and-networking.md) for all CLI flags, port specs (`list`, `range`, `auto`, `off`), env variables, Tailscale setup, and PM2 unattended daemon management.

---

## 4. Repository Structure

```text
git-web/
├── AGENTS.md                         # Concise agent guide & critical invariants
├── CODE_OF_CONDUCT.md                # Contributor Covenant v2.1
├── CONTRIBUTING.md                   # Contributor setup, coding rules & PR workflow
├── LICENSE                           # MIT License
├── README.md                         # User quick start & overview
├── SECURITY.md                       # Threat model, built-in guardrails & vulnerability reporting
├── ecosystem.config.cjs              # PM2 daemon configuration (single fork, port 8001 preset)
├── docs/
│   ├── commit-standard.md            # Detailed 4-type commit guide & agent commit playbook
│   ├── runner-and-networking.md      # CLI flags, port specs, env vars, LAN/Tailscale setup
│   └── testing-and-performance.md    # Test inventory, Windows sandbox note, perf SLAs
├── .github/
│   ├── ISSUE_TEMPLATE/               # Bug report & feature request forms + security link
│   ├── PULL_REQUEST_TEMPLATE.md      # PR checklist referencing 4-type commit standard
│   └── workflows/commit-standard.yml # CI enforcement on push & PR + cross-platform verification
├── .githooks/
│   └── commit-msg                    # Local Git hook calling scripts/validate-commit-msg.ts
├── scripts/
│   ├── dev.ts                        # Flexible project runner + interactive wizard
│   ├── install-hooks.ts              # Configures repo-local `core.hooksPath` -> `.githooks`
│   ├── perf.ts                       # Sequential performance & bundle SLA runner
│   ├── pm2-autostart.ts              # Registers PM2 dump + silent Windows Startup launcher
│   ├── pm2-entry.mjs                 # ESM bridge launching `startServer()` cleanly under PM2
│   ├── runner-core.ts                # Pure CLI parsing & port plan resolution
│   └── validate-commit-msg.ts        # Commit header & `--range` validator CLI
├── src/
│   ├── shared/
│   │   ├── commit-standard.ts        # Pure 4-type commit parser, formatter & validator
│   │   └── types.ts                  # Shared client/server DTOs
│   ├── server/
│   │   ├── index.ts                  # Hono app factory (`createGitDockApp`) & CLI server
│   │   ├── auth.ts                   # Pairing token, loopback bypass, cookie/header auth
│   │   ├── ports.ts                  # Port spec parser, TCP prober & safe port resolver
│   │   ├── interactive-ports.ts      # Buffered TTY/pipe interactive port wizard
│   │   ├── network.ts                # LAN IPv4 discovery, Tailscale detect, QR SVG
│   │   ├── fs/browse.ts              # Host directory browser & `.git` repo detector
│   │   ├── repos/store.ts            # RepoStore (`.gitweb-repos.json` + nearby discovery)
│   │   └── git/
│   │       ├── runner.ts             # Safe `git` `execFile`/`spawn`, per-repo queue (max 4)
│   │       ├── parsers.ts            # Porcelain v2 `-z`, unified patch, numstat parsers
│   │       └── service.ts            # Status, batched diffs, stage, commit, ls-remote
│   └── client/
│       ├── main.tsx / index.css / api.ts / App.tsx
│       └── components/
│           ├── ChangesTab.tsx        # File staging, 4-type commit composer, diff host
│           ├── HistoryTab.tsx        # Commit history, commit-type badges, `ls-remote` verify
│           ├── BranchesTab.tsx       # Local/remote branch management
│           ├── MobileDiffViewer.tsx  # `@git-diff-view/react` unified/split/raw viewer
│           ├── FolderBrowser.tsx     # Interactive host folder & `.git` picker widget
│           ├── RepoModal.tsx         # Add/switch/remove repositories modal
│           ├── ConnectModal.tsx      # QR pairing, LAN & Tailscale HTTPS modal
│           └── StatusBadge.tsx       # `FileStatusBadge`, `PushStateBadge`, `CommitTypeBadge`
└── tests/                            # Native `node --test` unit, HTTP, diff, and SLA suites
```

---

## 5. HTTP API Summary (`src/server/index.ts`)

- **Auth & System**: `GET /api/health`, `GET /api/auth/session`, `POST /api/auth/pair`, `GET /api/network`, `GET /api/fs/browse` (`?path=&nearest=1&hidden=1`)
- **Repositories**: `GET /api/repos`, `POST /api/repos`, `DELETE /api/repos/:id`
- **Working Tree & Commits**: `GET /api/repos/:id/status`, `GET /api/repos/:id/diff` (`?path=&section=&context=&hint=untracked`), `POST /api/repos/:id/stage|unstage|discard|commit`, `GET /api/repos/:id/commits`, `GET /api/repos/:id/commits/:sha`, `GET /api/repos/:id/commits/:sha/diff`
- **Remote & Branches**: `GET /api/repos/:id/remote/verify`, `POST /api/repos/:id/remote/fetch|pull|push`, `GET /api/repos/:id/branches`, `POST /api/repos/:id/branches/checkout`, `GET /api/repos/:id/events` (SSE `connected` / `repo-changed` / `ping`)

---

## 6. Critical Coding Conventions & Gotchas

- **TypeScript (`tsconfig.json`)**: `erasableSyntaxOnly: true` is strict — **never** use `enum`, `namespace`, or constructor parameter properties (`private foo`). Always include `.ts`/`.tsx` extensions in relative imports (`NodeNext`). Keep `src/shared/*` free of Node built-ins and DOM globals.
- **Security & Process Safety**: Always spawn binaries via `execFile`/`spawn` with `shell: false`. Pass every working-tree file path through `assertSafeRepoPath` (and `assertSafeWorktreeTarget` for disk reads/deletes), validate branch names before `checkoutBranch`, keep ports `< 1024` blocked unless `allowPrivileged` is set, enforce `Host` + CSRF origin/header checks and reverse-proxy spoofing guards in `src/server/auth.ts`, and honor optional `--workspace-root` confinement when configured.
- **Architecture & Socket Gotchas**:
  - Do not call `.unref()` on probe sockets in `isPortAvailable` / `getEphemeralPort`.
  - Resolve Vite via `path.resolve(root, 'node_modules/vite/bin/vite.js')` + `process.execPath` (`shell: false`), not `import.meta.resolve('vite/bin/vite.js')`.
  - Preserve `serveHttpsPort8443Url` alongside `serveHttpsUrl` in `ServerNetworkInfo.tailscale`.
  - Read-only `git` commands pass `{ readOnly: true }` (`GIT_OPTIONAL_LOCKS=0`) so polling never triggers SSE refresh loops; `diff` blobs use `readGitBlobsBatch` (`cat-file --batch`) and `getRepoStatus` reads `.git/config` before falling back to `git remote`.
  - UI components reset `diffLoading` / `diffError` cleanly whenever `!selected` / `FlatFiles` empties, and client calls flow through `requestJson` in `src/client/api.ts` (which sends `X-GitDock-Request: 1` for anti-CSRF).

---

## 7. Pre-Handoff Verification

After any non-trivial change (full details & SLAs in [docs/testing-and-performance.md](docs/testing-and-performance.md)):
1. Run `npm run typecheck` (must exit 0).
2. Run `npm run build` if client files, `src/shared/*`, or `vite.config.ts` changed.
3. Run relevant `node --test` suites and `npm run test:perf` (must meet all latency & bundle budgets).
4. Update [AGENTS.md](AGENTS.md), [README.md](README.md), and relevant files in [`docs/`](docs/) whenever conventions, CLI flags, routes, or directory structure change.
