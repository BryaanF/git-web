# GitDock Web

Mobile-first web companion for GitHub Desktop workflows — inspect **unstaged**, **untracked**, **staged**, and **verified pushed** code diffs comfortably on your smartphone without touching local ports **80** or **443**.

## Prerequisites

- **Node.js `>= 22.18.0`** (runs native erasable TypeScript directly — zero backend build step required)
- **Git** CLI available in `PATH`
- Optional: **[Tailscale](https://tailscale.com/)** for trusted HTTPS (`tailscale serve`) over mobile data / PWA install
- Optional: **[PM2](https://pm2.keymetrics.io/)** (`npm install -g pm2`) for unattended background daemon auto-start

## Stack & Compatibility Rationale

- **Runtime**: Node.js `>= 22.18` / `26.x` executing `.ts` files directly.
- **Server**: [Hono](https://hono.dev/) + `@hono/node-server` serving both `/api/*` and the built React SPA from a **single unprivileged port** (`7745` by default).
- **Git Engine**: Native `git` CLI (`execFile`, `shell: false`, `-c core.quotepath=false`, bounded concurrency per repo) — handles Windows `CRLF`, Git Credential Manager, SSH keys, renames, untracked files, and live `git ls-remote` verification.
- **UI & Diff Engine**: React 19 + Tailwind CSS v4 + `@git-diff-view/react` (`Unified` single-column mode + `Word Wrap` enabled by default on smartphones, intra-line word diffs, syntax highlighting, and desktop `Split` mode).
- **Remote / Mobile Connectivity**:
  - **Same Wi-Fi LAN**: Binds `0.0.0.0:7745`, auto-steps if busy, blocks ports `< 1024` by default, and generates an instant QR code with a pairing token.
  - **Tailscale (Optional HTTPS)**: Run `tailscale serve --bg --https=8443 http://127.0.0.1:7745` (or `:8001` with `npm run start:ts`) for trusted HTTPS (`https://<machine>.ts.net:8443`) over mobile data and PWA installation without colliding with ports `80` or `443`.

## Quick Start

```bash
npm install
npm run build
npm start -- --repo "/path/to/your-project"
```

Simple start preset for Tailscale Serve (`https://<machine>.ts.net:8443 -> http://127.0.0.1:8001`, auto-builds `dist/client` if missing):

```bash
npm run start:ts
# or: npm run start:tailscale
```

Unattended background daemon + auto-start on boot via global `pm2`:

```bash
npm run pm2:setup
```

Standard performance & verification suite (backend parsers, live HTTP/Git endpoints, React/diff rendering, and Vite bundle budgets):

```bash
npm run test:perf
npm run verify
```

Development mode (backend watch + Vite HMR):

```bash
npm run dev -- --repo "/path/to/your-project"
```

Interactive service & port picker (probes free ports live before starting):

```bash
npm run dev:pick
```

Flexible per-service port & service selection examples:

```bash
# Custom ports for backend API and Vite UI (Vite /api proxy automatically follows server port)
npm run dev -- --server-port 8080 --client-port 3000

# Candidate list, range, or OS-assigned "auto" ports
npm run dev -- --server-port 7745,8080,8888 --client-port 5173-5190

# Activate only one service, or run production server mode via runner
npm run dev -- --services server --server-port 9000 --tailscale-port 9443
npm run dev -- --services client --client-port 4000 --proxy-port 9000
npm run runner -- --mode start --port 8080 --strict-port

# Confine folder browsing & repository registration to a specific parent directory
npm start -- --workspace-root "/path/to/projects"
```

## CLI Flags & Environment Variables

| Option | Env Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `--server-port <spec>` / `--port <spec>` | `GITWEB_SERVER_PORT` / `GITWEB_PORT` | `7745` | Server port, list (`7745,8080`), range (`8000-8010`), `auto`, or `off` |
| `--client-port <spec>` | `GITWEB_CLIENT_PORT` / `VITE_PORT` | `5173` | Vite UI port, list, range, `auto`, or `off` |
| `--tailscale-port <n\|off>` | `GITWEB_TAILSCALE_PORT` | `8443` | Tailscale HTTPS serve port shown in QR/instructions |
| `--services <list>` | `GITWEB_SERVICES` | `server,client` | Services to activate (`server`, `client`, `all`) |
| `--proxy-port <n>` | `GITWEB_PROXY_PORT` | `7745` | Backend port for Vite `/api` proxy when running `client` only |
| `--strict-port` | `GITWEB_STRICT_PORT=1` | `false` | Fail instead of auto-stepping when chosen port is busy |
| `--allow-privileged-port` | `GITWEB_ALLOW_PRIVILEGED_PORT=1` | `false` | Allow ports `< 1024` (including `80`/`443`) |
| `--ensure-build` / `--build` | — | `false` | Auto-build `dist/client` if missing (`--ensure-build`) or force rebuild (`--build`) |
| `--interactive` / `-i` | — | `false` | Interactive live port scanner & service picker |
| `--dry-run` | — | `false` | Print resolved service & port plan without starting |
| `--host <ip>` | `GITWEB_HOST` | `0.0.0.0` | Bind interface (`127.0.0.1` for Tailscale-only) |
| `--repo <path>` | — | CWD | Register one or more local Git repositories on startup |
| `--workspace-root <dir>` | `GITWEB_WORKSPACE_ROOT` | *(unrestricted)* | Restrict folder browsing and repo registration inside `<dir>` |
| `--no-auth` | `GITWEB_NO_AUTH=1` | `false` | Disable LAN pairing token requirement (unsafe on untrusted networks) |

## Security Model

GitDock Web is designed for **single-user personal workstations** over loopback, trusted Wi-Fi LAN, or Tailscale Serve HTTPS. It includes shell-free `git` execution, path-traversal and symlink-containment guards, branch flag-injection prevention, DNS-rebinding and CSRF protections on loopback/cookie sessions, pairing brute-force throttling, and optional `--workspace-root` confinement. See [SECURITY.md](SECURITY.md) before deploying or exposing to shared networks.

## Commit Standard

All commits in this repository follow a 4-type structured convention with a concise summary (`<= 50` chars) and details in the commit description body:

`<type>(<scope>): <summary>` (or `<type>: <summary>`, max **50 characters**)

| Type | Purpose | Example (`<= 50` chars) |
| :--- | :--- | :--- |
| `bugfix` | Bug fixes, error fixes, and regressions | `bugfix(ui): clear diff spinner on clean tree` |
| `features` | New user-facing features or capabilities | `features(repo): add host folder browser` |
| `chores` | Maintenance, build, docs, dependencies, or test/tooling setup | `chores(ci): add hook and workflow checks` |
| `improvement` | Performance optimizations, refactors, or UX/quality polish | `improvement(git): batch staged diff blobs` |

The local `commit-msg` hook installs automatically via `npm install` (`prepare`) or manually:

```bash
npm run hooks:install
npm run check:commit -- --message "features(ui): add browse picker"
```

Every `push` and `pull_request` on GitHub is also checked automatically by [`.github/workflows/commit-standard.yml`](.github/workflows/commit-standard.yml).

## Detailed Documentation (`docs/`)

- [Commit Standard & GitHub Workflow](docs/commit-standard.md)
- [Runner, Port Selection & Networking](docs/runner-and-networking.md)
- [Testing & Performance Budgets](docs/testing-and-performance.md)

## Contributing & License

- Contributions are welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md).
- Released under the [MIT License](LICENSE).
