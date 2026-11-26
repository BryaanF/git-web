# AGENTS.md — GitDock Web Engineering & Agent Guide

> Authoritative repository map, architecture guide, invariants, and operational playbook for AI coding agents and human contributors working on **GitDock Web** (`gitdock-web`).

---

## 1. Project Identity & Core Goals

**GitDock Web** is a mobile-first web companion for GitHub Desktop–style workflows. It lets users inspect **unstaged**, **untracked**, **staged**, **conflicted**, and **verified pushed vs. unpushed** diffs from a smartphone over LAN or Tailscale without touching privileged web ports (`80` / `443`).

### Key Technical Pillars
- **Zero-Build Native TypeScript Backend**: Targets **Node.js `>= 22.18` / `26.x`** running `.ts` files directly (`node src/server/index.ts`, `node scripts/dev.ts`, `node --test`). No backend transpilation step exists.
- **Single-Port Production & Coordinated Dev Runner**:
  - Production (`npm start`): Hono + `@hono/node-server` serves `/api/*` and the built Vite SPA (`dist/client`) from one unprivileged port (`7745` by default).
  - Development (`npm run dev`): [scripts/dev.ts](scripts/dev.ts) orchestrates the backend API server and Vite HMR dev server (`5173` by default), dynamically resolving conflict-free ports per service and wiring Vite's `/api` proxy target to the active backend port.
- **Native Git CLI Engine**: Shells out via `execFile('git', ..., { shell: false })` with `-c core.quotepath=false` and bounded per-repo concurrency to avoid Windows process thrashing and shell injection.
- **Mobile-First Diff UI**: React 19 + Tailwind CSS v4 + `@git-diff-view/react` defaulting to `Unified` single-column mode with word-wrap enabled on small screens and `Split` mode available on desktop.

---

## 2. Commands & Flexible Runner Reference

### NPM Scripts ([package.json](package.json))
| Command | Underlying Entrypoint | Purpose |
| :--- | :--- | :--- |
| `npm run dev` | `node scripts/dev.ts` | Flexible dev runner (backend `--watch` + Vite HMR with synchronized proxy) |
| `npm run dev:pick` | `node scripts/dev.ts --interactive` | Interactive dev wizard with live port scanning and service selection |
| `npm run runner` | `node scripts/dev.ts` | Alias for the flexible project runner (supports `--mode dev\|start`) |
| `npm run dev:server` | `node --watch src/server/index.ts` | Backend server only in watch mode |
| `npm run dev:client` | `vite` | Vite client dev server only |
| `npm run build` | `tsc --noEmit && vite build` | Type-check all TS + build production client bundle into `dist/client` |
| `npm start` | `node src/server/index.ts` | Run server directly (serves API + built `dist/client` if present) |
| `npm run start:pick` | `node src/server/index.ts --interactive` | Interactive port picker for standalone server mode |
| `npm run start:ts` / `start:tailscale` | `node src/server/index.ts --host 127.0.0.1 --port 8001 --strict-port --tailscale-port 8443 --ensure-build` | Simple Tailscale localhost preset (auto-builds `dist/client` if missing) |
| `npm test` | `node --test tests/*.test.ts` | Run full Node native test suite |
| `npm run typecheck` | `tsc --noEmit` | Static TypeScript verification across `src/`, `scripts/`, `tests/`, `vite.config.ts` |

### Flexible Port & Service Selection
Both `scripts/dev.ts` and `src/server/index.ts` accept flexible port specifications parsed by `parsePortSpec` in [src/server/ports.ts](src/server/ports.ts):
- **Single port**: `8080` (auto-steps forward if busy, unless `--strict-port` is set)
- **Ordered candidate list**: `7745,8080,8888`
- **Inclusive port range**: `8000-8010` (stays strictly inside the range)
- **Combined**: `7745,8000-8010`
- **OS ephemeral allocation**: `auto` or `0`
- **Service disable**: `off` / `none` / `disabled`

#### Common Runner Examples
```bash
# Interactive terminal port scanner & service picker
npm run dev:pick

# Custom ports per service (Vite /api proxy follows resolved server port automatically)
npm run dev -- --server-port 8080 --client-port 3000

# Candidate list, range, or ephemeral "auto" ports
npm run dev -- --server-port 7745,8080 --client-port 5173-5190 --tailscale-port 9443

# Run only backend server, or only Vite client proxying to an existing backend
npm run dev -- --services server --server-port 9000 --tailscale-port off
npm run dev -- --services client --client-port 4000 --proxy-port 9000

# Production mode via runner with strict port enforcement
npm run runner -- --mode start --port 8080 --strict-port

# Inspect resolved port plan and availability without starting processes
npm run dev -- --dry-run --server-port 8080-8085 --client-port auto
```

### Environment Variables
| Variable | Default | Consumer(s) | Notes |
| :--- | :--- | :--- | :--- |
| `GITWEB_SERVER_PORT` / `GITWEB_PORT` / `PORT` | `7745` | `scripts/runner-core.ts`, `src/server/index.ts`, `vite.config.ts` | Priority order: `GITWEB_SERVER_PORT` > `GITWEB_PORT` > `PORT` |
| `GITWEB_CLIENT_PORT` / `VITE_PORT` | `5173` | `scripts/runner-core.ts`, `vite.config.ts`, `src/server/index.ts` | Dev UI port; also reported in `/api/network` & `/api/health` |
| `GITWEB_TAILSCALE_PORT` | `8443` | `scripts/runner-core.ts`, `src/server/index.ts` | Integer `1-65535` or `off` |
| `GITWEB_PROXY_PORT` | `7745` | `scripts/runner-core.ts` | Backend target port when running `client` service alone |
| `GITWEB_API_TARGET` | `http://127.0.0.1:<port>` | `vite.config.ts`, `scripts/runner-core.ts` | Explicit `/api` proxy URL for Vite |
| `GITWEB_HOST` | `0.0.0.0` | Runner, server, Vite | Bind interface (`127.0.0.1` for loopback/Tailscale-only) |
| `GITWEB_SERVICES` | `server,client` | `scripts/runner-core.ts` | Comma-separated: `server`, `client`, `all` |
| `GITWEB_MODE` | `dev` | `scripts/runner-core.ts` | `dev` or `start` / `prod` |
| `GITWEB_STRICT_PORT` | `0` | Runner, server, Vite | Set `1` to disable auto-stepping |
| `GITWEB_ALLOW_PRIVILEGED_PORT` | `0` | Runner, server | Set `1` to allow ports `< 1024` (including `80`/`443`) |
| `GITWEB_NO_AUTH` | `0` | Runner, server | Set `1` to disable LAN pairing auth |
| `GITWEB_TOKEN` | *(auto-generated)* | `src/server/auth.ts` | Override persistent pairing token in `.gitweb-auth.json` |

---

## 3. Repository Structure & Module Inventory

```text
git-web/
├── AGENTS.md                        # This architectural & agent guide
├── README.md                        # User-facing quick start & CLI reference
├── package.json                     # Scripts, ESM config ("type": "module"), dependencies
├── tsconfig.json                    # Strict NodeNext + erasableSyntaxOnly TS settings
├── vite.config.ts                   # Dynamic client port & /api proxy target from env
├── index.html                       # Dark-theme mobile PWA entry HTML
├── public/
│   ├── icon.svg                     # App/PWA vector icon
│   └── manifest.webmanifest         # PWA manifest
├── scripts/
│   ├── dev.ts                       # Executable flexible project runner + interactive wizard
│   └── runner-core.ts               # Pure CLI parsing, port plan resolution & formatting
├── src/
│   ├── shared/
│   │   └── types.ts                 # Shared API & domain DTOs (client <-> server)
│   ├── server/
│   │   ├── index.ts                 # Hono app, HTTP/SSE routes, static SPA, CLI entrypoint
│   │   ├── auth.ts                  # Pairing token persistence, loopback bypass, cookie/header auth
│   │   ├── ports.ts                 # Flexible port spec parser, TCP prober & safe port resolver
│   │   ├── interactive-ports.ts     # Buffered TTY/pipe readline session & port prompt wizard
│   │   ├── network.ts               # LAN IPv4 discovery, Tailscale detection, QR SVG/terminal gen
│   │   ├── repos/
│   │   │   └── store.ts             # RepoStore (.gitweb-repos.json persistence + nearby auto-discovery)
│   │   └── git/
│   │       ├── runner.ts            # Safe `git` / system command execFile + per-repo queue (max 2)
│   │       ├── parsers.ts           # Porcelain v2 `-z`, unified patch, numstat/name-status, lang map
│   │       └── service.ts           # Git domain operations (status, diffs, stage, commit, ls-remote)
│   └── client/
│       ├── main.tsx                 # React 19 root mount
│       ├── index.css                # Tailwind v4 + @git-diff-view styling + mobile safe-area helpers
│       ├── api.ts                   # Fetch wrapper, token URL bootstrap, typed API client
│       ├── App.tsx                  # Top bar, repo switcher, SSE listener, tab router, pairing gate
│       └── components/
│           ├── ChangesTab.tsx       # Unstaged/untracked/staged/conflicted files, staging, commit box
│           ├── HistoryTab.tsx       # Commit history, pushed/unpushed badges, live `ls-remote` verify
│           ├── BranchesTab.tsx      # Local/remote branches list, checkout, create branch
│           ├── MobileDiffViewer.tsx # Unified/split/raw diff viewer using `@git-diff-view/react`
│           ├── ConnectModal.tsx     # QR code, LAN URLs, and Tailscale HTTPS instructions modal
│           ├── RepoModal.tsx        # Add/switch/remove local Git repositories modal
│           └── StatusBadge.tsx      # `FileStatusBadge` & `PushStateBadge` visual badges
├── tests/
│   ├── git-engine.test.ts           # Parser, path traversal guard, and live Git integration tests
│   ├── network.test.ts              # Port spec parser, safe resolver, and network info tests
│   └── runner.test.ts               # Runner CLI parser, collision avoidance, and Vite proxy wiring tests
└── dist/client/                     # Built Vite production assets (gitignored)
```

### Runtime-Generated State Files (Gitignored)
- `.gitweb-repos.json`: Persisted list of registered repositories managed by `RepoStore`.
- `.gitweb-auth.json`: Auto-generated 18-byte `base64url` pairing token managed by `createAuthManager`.

---

## 4. Architecture & Core Flows

### A. Project Runner & Port Coordination (`scripts/dev.ts` + `scripts/runner-core.ts`)
1. `parseRunnerArgs` reads CLI flags and `GITWEB_*` env variables, validating all port specs up front via `parsePortSpec`.
2. `resolveRunnerPlan` resolves ports sequentially:
   - Resolves `server` port first (default `7745`) if `server` is enabled.
   - Adds the chosen `server` port to `allocatedPorts` (`excludePorts`) before resolving `client` port (default `5173`), preventing collisions when ranges or `auto` overlap.
   - Computes `apiTarget` (`http://${formatHostForUrl(host)}:${proxyTargetPort}`) and injects `GITWEB_API_TARGET`, `GITWEB_CLIENT_PORT`, `GITWEB_SERVER_PORT`, and `GITWEB_STRICT_PORT=1` into Vite's environment.
   - Passes `GITWEB_CLIENT_PORT` and `GITWEB_TAILSCALE_PORT` into the server environment so `/api/network`, `/api/health`, and the pairing QR code reflect the active dev UI and Tailscale port.
3. `scripts/dev.ts` spawns `server` first, polls TCP readiness on the resolved server port (up to 10s), then spawns Vite directly via `node <repo>/node_modules/vite/bin/vite.js` (`shell: false`), shutting down all children together on exit or signal.

### B. Authentication & Remote Access (`src/server/auth.ts`, `src/server/network.ts`)
- **Exempt routes**: `/api/health` and `/api/auth/pair` bypass token enforcement.
- **Desktop loopback bypass**: Requests from `127.0.0.1`, `::1`, or `::ffff:127.0.0.1` are trusted automatically **unless** `x-forwarded-for` or `tailscale-user-login` headers are present (preventing reverse proxies or `tailscale serve` from impersonating local desktop access).
- **Pairing mechanisms**: Accepts `X-GitWeb-Token` header, `Authorization: Bearer <token>`, `?token=<token>` query param (which also sets an `HttpOnly`, `SameSite=Lax` `gitdock_token` cookie for 30 days and gets stripped from the browser URL by `bootstrapTokenFromUrl()`), or the `gitdock_token` cookie.
- **LAN & Tailscale discovery**: `getLanIpv4Addresses()` deprioritizes virtual adapters (`vethernet`, `wsl`, `docker`, `vmware`, `virtualbox`), prioritizes Wi-Fi/WLAN, skips link-local (`169.254.*`) and Tailscale CGNAT (`100.*`), and generates QR SVGs + terminal QR.

### C. Live Filesystem Watch & SSE (`GET /api/repos/:id/events`)
- Watches `repo.path` (recursive), `.git/refs` (recursive), and `.git` (non-recursive).
- Ignores `node_modules`, `.git/objects`, and `*.lock` files to avoid feedback loops during Git operations.
- Debounces `repo-changed` SSE events by `350ms` and emits `ping` keep-alives every `20s`.
- Frontend `App.tsx` maintains an `EventSource` connection per active repository (displaying a green/grey dot indicator) and triggers status/tab refreshes on `repo-changed`.

### D. Git Engine & Push Verification (`src/server/git/*`)
- **Status parsing**: Uses `git status --porcelain=v2 --branch -z` (`NUL`-delimited) via `parseStatusPorcelainV2Z` so filenames with spaces, quotes, renames (`2 R... path\0origPath`), and untracked files parse reliably across Windows/POSIX.
- **Diff rendering**: Fetches unified patches (`--unified=${ctx}`) plus `oldContent`/`newContent` blobs for `@git-diff-view/file` intra-line diffs. Synthesizes unified patches for untracked files via `buildUntrackedUnifiedPatch`. Enforces binary detection (`\0` bytes in first 8192 bytes) and size guards (`MAX_READ_BYTES = 512 KB`, `MAX_CONTENT_BYTES = 180 KB`, `isTooLarge` when `lineCount > 4500`).
- **Live remote sync check**: `verifyRemoteSync` runs `git ls-remote --heads <remote> refs/heads/<branch>` and compares `HEAD`, local tracking ref (`upstream`), and live remote SHA to return deterministic verdicts: `synced`, `ahead_unpushed`, `behind_remote`, `diverged`, `stale_local_cache`, `no_remote_branch`, `no_upstream`, or `error`.

---

## 5. HTTP API Reference (`src/server/index.ts`)

| Method | Path | Query / JSON Body | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | — | Health check returning `port`, `clientPort`, `tailscalePort`, `authEnabled`, `avoidsPrivilegedPorts` |
| `GET` | `/api/auth/session` | — | Auth check (`authenticated`, `authEnabled`) |
| `POST` | `/api/auth/pair` | `{ token }` | Exchanges pairing token for `gitdock_token` cookie |
| `GET` | `/api/network` | — | Returns `ServerNetworkInfo` (URLs, QR SVGs, Tailscale info) |
| `GET` | `/api/repos` | — | Lists registered `RepoEntry[]` |
| `POST` | `/api/repos` | `{ path }` | Validates and registers a local Git repo |
| `DELETE` | `/api/repos/:id` | — | Unregisters a repo from `.gitweb-repos.json` |
| `GET` | `/api/repos/:id/status` | — | Returns `RepoStatusSummary` (`branch`, `ahead`, `behind`, `unstaged`, `staged`, `conflicted`) |
| `GET` | `/api/repos/:id/diff` | `?path=...&section=unstaged\|staged\|conflicted&context=3` | Returns `DiffPayload` for working tree or staged file |
| `POST` | `/api/repos/:id/stage` | `{ paths?: string[] }` | Stages selected files or all (`git add -A`) and returns updated status |
| `POST` | `/api/repos/:id/unstage` | `{ paths?: string[] }` | Unstages selected files or all and returns updated status |
| `POST` | `/api/repos/:id/discard` | `{ path }` | Discards unstaged changes or removes untracked file |
| `POST` | `/api/repos/:id/commit` | `{ summary, description? }` | Creates a commit and returns `{ sha, status }` |
| `GET` | `/api/repos/:id/commits` | `?limit=40&offset=0` | Paginated `CommitHistoryResponse` with `pushed` / `unpushed` / `remote_only` classification |
| `GET` | `/api/repos/:id/commits/:sha` | — | `CommitDetail` metadata and changed files list |
| `GET` | `/api/repos/:id/commits/:sha/diff` | `?path=...&context=3` | `DiffPayload` for a single file inside a commit |
| `GET` | `/api/repos/:id/remote/verify` | — | Live `git ls-remote` check (`RemoteVerifyResult`) |
| `POST` | `/api/repos/:id/remote/fetch` | — | Runs `git fetch --all --prune` and returns updated status |
| `POST` | `/api/repos/:id/remote/pull` | — | Runs `git pull --ff-only` and returns updated status |
| `POST` | `/api/repos/:id/remote/push` | `{ setUpstream?: boolean }` | Pushes commits (`git push` or `git push -u <remote> <branch>`) |
| `GET` | `/api/repos/:id/branches` | — | Lists local and remote tracking branches (`BranchItem[]`) |
| `POST` | `/api/repos/:id/branches/checkout` | `{ branch, create?: boolean }` | Switches to or creates a branch and returns updated status |
| `GET` | `/api/repos/:id/events` | — | SSE stream emitting `connected`, `repo-changed`, and `ping` |

---

## 6. Critical Coding Conventions & Invariants

### TypeScript & Node.js Execution Rules ([tsconfig.json](tsconfig.json))
- **`erasableSyntaxOnly: true` is enforced**: Because Node executes `.ts` directly by stripping types, **never** use `enum`, `namespace`, or constructor parameter properties (`constructor(private foo: string)`). Use union string types (`type Foo = 'a' | 'b'`) and explicit class fields instead.
- **`allowImportingTsExtensions: true` + `NodeNext`**: Always include `.ts` / `.tsx` file extensions in relative ESM imports (e.g., `import { runGit } from './git/runner.ts'`).
- **Keep `src/shared/types.ts` pure types**: Do not import Node built-ins or browser globals into `src/shared/`.

### Security & Process Safety
- **No shell interpolation**: Always spawn Git and system binaries via `execFile` (`shell: false`). Never pass user inputs into `exec` or shell strings.
- **Path containment**: Every working-tree file access (`readWorktreeText`, `getWorkingFileDiff`, `stageFiles`, `unstageFiles`, `discardUnstagedFile`) **must** pass through `assertSafeRepoPath(repoRoot, filePath)` to block `..` traversal, absolute paths, and `.git` metadata edits.
- **Preserve port safety**: Ports `80`, `443`, and `< 1024` must remain blocked by default unless `allowPrivileged` (`--allow-privileged-port`) is explicitly requested.

### Runner & Socket Gotchas
- **Do not call `.unref()` on probe sockets in `isPortAvailable` / `getEphemeralPort`**: These helpers close their temporary TCP server before resolving. Calling `.unref()` causes Node.js to exit early with code `0` mid-Promise when stdin reaches EOF in piped interactive mode.
- **Do not use `import.meta.resolve('vite/bin/vite.js')`**: Vite's `package.json` `exports` field does not expose `./bin/vite.js`. Resolve `node_modules/vite/bin/vite.js` via `path.resolve` + `fs.existsSync` and spawn with `process.execPath` (`shell: false`) so Windows never triggers `DEP0190` or leaves orphaned `cmd.exe` children.
- **Preserve `serveHttpsPort8443Url` alongside `serveHttpsUrl`** in `ServerNetworkInfo.tailscale` for backwards compatibility with existing clients.

### Frontend & Styling Rules
- Keep dark GitHub-style palette tokens (`#0d1117` canvas, `#161b22` surfaces, `#30363d` borders) and mobile touch/safe-area spacing (`.safe-top`, `.safe-bottom`).
- Client API calls should go through `requestJson` in [src/client/api.ts](src/client/api.ts) so `X-GitWeb-Token`, `credentials: 'include'`, and `ApiAuthError` (401 pairing gate redirect) behave uniformly.

---

## 7. Testing & Verification Checklist

### Running Checks
```bash
npm run typecheck
npm run build
node --test tests/network.test.ts tests/runner.test.ts
npm test
```

### Environment Notes
- **`tests/git-engine.test.ts` in restricted Windows sandboxes**: The Git integration test runs `git init --bare` and `git push -u origin main` to a local temporary repo. In locked-down Windows sandbox environments, MSYS `sh.exe` invoked by `git push` may fail with `NtCreateDirectoryObject ... 0xC0000022` even when the code is healthy; verify `tests/git-engine.test.ts` in an unrestricted local shell when touching `src/server/git/*`.
- **Testing the runner safely**: Use `--dry-run` to test CLI parsing and port conflict resolution without binding servers, or run `scripts/dev.ts` against non-default test ports (`--host 127.0.0.1 --no-watch --no-auth`) and terminate cleanly when done.

### Pre-Handoff Verification for Agents
After any non-trivial change:
1. Run `npm run typecheck` (must pass with zero errors).
2. Run `npm run build` if client files, `src/shared/types.ts`, or `vite.config.ts` changed.
3. Run relevant `node --test` suites (`tests/network.test.ts`, `tests/runner.test.ts`, and `tests/git-engine.test.ts` when applicable).
4. Update [AGENTS.md](AGENTS.md) and [README.md](README.md) whenever CLI flags, env variables, routes, or directory layout change.
