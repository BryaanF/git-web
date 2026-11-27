# Runner, Port Selection & Remote Networking Guide

Flexible configuration details for the project runner (`scripts/dev.ts`, `src/server/ports.ts`) and remote access over local Wi-Fi LAN or Tailscale HTTPS.

---

## 1. Flexible Port Specifications (`parsePortSpec`)

Both `scripts/dev.ts` and `src/server/index.ts` accept the following port specifiers:
- **Single port**: `8080` (automatically steps forward if busy unless `--strict-port` is enabled)
- **Ordered candidate list**: `7745,8080,8888`
- **Inclusive port range**: `8000-8010` (stays strictly inside the given bounds)
- **Combined**: `7745,8000-8010`
- **OS ephemeral allocation**: `auto` or `0`
- **Service disable**: `off` / `none` / `disabled`

> [!NOTE]
> Ports `< 1024` (including `80` and `443`) are blocked by default for safety and rootless compatibility unless `--allow-privileged-port` / `GITWEB_ALLOW_PRIVILEGED_PORT=1` is explicitly enabled.

---

## 2. Runner Examples & Tailscale Preset

```bash
# Interactive terminal wizard with live port probing
npm run dev:pick

# Custom ports per service (Vite /api proxy follows the resolved server port)
npm run dev -- --server-port 8080 --client-port 3000

# Candidate list, range, or ephemeral "auto"
npm run dev -- --server-port 7745,8080 --client-port 5173-5190 --tailscale-port 9443

# Enable only the backend server, or only the Vite client pointing at a running server
npm run dev -- --services server --server-port 9000 --tailscale-port off
npm run dev -- --services client --client-port 4000 --proxy-port 9000

# Production mode via runner with strict port
npm run runner -- --mode start --port 8080 --strict-port

# Dry-run port resolution without binding sockets
npm run dev -- --dry-run --server-port 8080-8085 --client-port auto

# Simple preset for Tailscale Serve (127.0.0.1:8001 -> HTTPS :8443)
npm run start:ts
```

One-time Tailscale Serve setup on your host workstation:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:8001
```

---

## 3. Environment Variables

| Variable | Default | Consumer(s) | Notes |
| :--- | :--- | :--- | :--- |
| `GITWEB_SERVER_PORT` / `GITWEB_PORT` / `PORT` | `7745` | `scripts/runner-core.ts`, `src/server/index.ts`, `vite.config.ts` | Precedence: `GITWEB_SERVER_PORT` > `GITWEB_PORT` > `PORT` |
| `GITWEB_CLIENT_PORT` / `VITE_PORT` | `5173` | `scripts/runner-core.ts`, `vite.config.ts`, `src/server/index.ts` | Dev UI port; also reported in `/api/network` & `/api/health` |
| `GITWEB_TAILSCALE_PORT` | `8443` | `scripts/runner-core.ts`, `src/server/index.ts` | Integer `1-65535` or `off` |
| `GITWEB_PROXY_PORT` | `7745` | `scripts/runner-core.ts` | Backend target port when running `client` only |
| `GITWEB_API_TARGET` | `http://127.0.0.1:<port>` | `vite.config.ts`, `scripts/runner-core.ts` | Explicit `/api` proxy URL for Vite |
| `GITWEB_HOST` | `0.0.0.0` | Runner, server, Vite | Bind interface (`127.0.0.1` for loopback/Tailscale-only) |
| `GITWEB_WORKSPACE_ROOT` | *(unrestricted)* | Runner, server, `RepoStore`, `browse` | Optional root directory confining folder browsing & repo registration |
| `GITWEB_SERVICES` | `server,client` | `scripts/runner-core.ts` | Comma-separated: `server`, `client`, `all` |
| `GITWEB_MODE` | `dev` | `scripts/runner-core.ts` | `dev` or `start` / `prod` |
| `GITWEB_STRICT_PORT` | `0` | Runner, server, Vite | Set `1` to disable auto-stepping |
| `GITWEB_ALLOW_PRIVILEGED_PORT` | `0` | Runner, server | Set `1` to allow ports `< 1024` |
| `GITWEB_NO_AUTH` | `0` | Runner, server | Set `1` to disable LAN pairing token auth |
| `GITWEB_TOKEN` | *(auto-generated)* | `src/server/auth.ts` | Override persistent pairing token in `.gitweb-auth.json` |

---

## 4. Unattended Auto-Start with PM2

The repository includes [`ecosystem.config.cjs`](../ecosystem.config.cjs), [`scripts/pm2-entry.mjs`](../scripts/pm2-entry.mjs), and [`scripts/pm2-autostart.ts`](../scripts/pm2-autostart.ts) to run GitDock Web unattended in the background.

### Default Configuration ([`ecosystem.config.cjs`](../ecosystem.config.cjs))
- App name: `gitdock-web` (`exec_mode: 'fork'`, `instances: 1`, `watch: false`, `autorestart: true`, `windowsHide: true`).
- Default preset: `127.0.0.1:8001` (`GITWEB_STRICT_PORT=1`, `--ensure-build`, `GITWEB_TAILSCALE_PORT=8443`) to match `tailscale serve --bg --https=8443 http://127.0.0.1:8001`.
- For direct Wi-Fi LAN access instead of Tailscale-only loopback, override environment variables before starting (`GITWEB_HOST=0.0.0.0` and `GITWEB_PORT=7745`).

### Managing PM2 Auto-Start
```bash
# Start via PM2, save dump (`pm2 save`), and register Windows Startup launcher (or print `pm2 startup` hint on Linux/macOS)
npm run pm2:setup

# Daily process management
npm run pm2:restart
npm run pm2:stop
npm run pm2:logs
pm2 status

# Remove PM2 app & Windows Startup auto-launch artifacts
npm run pm2:remove
```

### Optional: Start Before Windows Login (Task Scheduler `ONSTART`)
The Windows Startup folder launcher (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\gitdock-web-pm2.vbs`) starts automatically when you sign in. If you also need the daemon running before sign-in on reboot, register the `ONSTART` task from an elevated PowerShell prompt:

```powershell
node scripts/pm2-autostart.ts setup --boot-task
```
