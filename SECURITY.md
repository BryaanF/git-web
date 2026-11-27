# Security Policy

## Threat Model & Intended Deployment

**GitDock Web** is designed as a **single-user personal developer companion** for inspecting diffs, staging files, creating commits, and managing branches on your own workstation from a smartphone over:

1. **Loopback (`127.0.0.1` / `localhost`)** on your local machine,
2. **Trusted Local Wi-Fi LAN** protected by a pairing token (`.gitweb-auth.json`), or
3. **Tailscale Serve HTTPS** (`127.0.0.1` + `tailscale serve --bg --https=8443`).

> [!IMPORTANT]
> GitDock Web is **not** intended for unauthenticated public internet hosting or multi-tenant isolation. Anyone with a valid pairing token (or local loopback access without proxy headers) can browse directories on the host, register Git repositories, discard unstaged changes, commit, and push using the host user's Git credentials.

### Built-in Guardrails

- **No shell interpolation**: Git and system commands execute via `execFile`/`spawn` with `shell: false` and `GIT_TERMINAL_PROMPT=0`.
- **Path traversal & symlink guards**: Working-tree operations validate paths via `assertSafeRepoPath` and `fs.realpath` containment checks, and block `.git/` metadata edits.
- **Branch argument injection guard**: Branch checkout validates names via `git check-ref-format --branch` and rejects leading `-` flags.
- **Privileged port block**: Ports `< 1024` (including `80` and `443`) are refused unless `--allow-privileged-port` is explicitly passed.
- **Loopback DNS-rebinding & reverse-proxy checks**: Direct loopback auth bypass requires both a loopback socket address and a loopback `Host` header, and never triggers when `x-forwarded-for` or `tailscale-user-login` is present.
- **CSRF protection**: Mutating `/api/*` requests reject `Sec-Fetch-Site: cross-site`, untrusted `Origin` headers, and browser requests lacking `X-GitDock-Request`, token headers, or `application/json`.
- **Pairing rate limiting & file permissions**: `POST /api/auth/pair` rate-limits repeated failed attempts (`429`), and `.gitweb-auth.json` is written with `0600` permissions on POSIX systems.
- **Optional workspace confinement**: Pass `--workspace-root <dir>` (or `GITWEB_WORKSPACE_ROOT`) to restrict host folder browsing and repository registration to a single directory tree.

### Operator Best Practices

- Never run `--no-auth` together with `--host 0.0.0.0` on untrusted or shared networks.
- Prefer `--host 127.0.0.1` behind **Tailscale Serve** for mobile access outside your home Wi-Fi.
- Treat terminal startup output and PM2 logs (`npm run pm2:logs`) as sensitive because the pairing URL is displayed on startup.
- Use `--workspace-root` whenever running GitDock Web on a shared host or container.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report vulnerabilities privately through **GitHub Security Advisories** (`Security` tab -> `Report a vulnerability`) on the repository. Include:

- A clear description of the issue and affected component/endpoint
- Steps or a minimal proof of concept to reproduce
- Potential impact and any suggested remediation

We aim to acknowledge reports within **72 hours** and coordinate a fix before public disclosure.
