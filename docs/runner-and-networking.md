# Runner, Port Selection & Remote Networking Guide

Detail konfigurasi fleksibel untuk project runner (`scripts/dev.ts`, `src/server/ports.ts`) dan akses jarak jauh via LAN Wi-Fi maupun Tailscale HTTPS.

---

## 1. Spesifikasi Port Fleksibel (`parsePortSpec`)

Baik `scripts/dev.ts` maupun `src/server/index.ts` menerima spesifikasi port berikut:
- **Single port**: `8080` (otomatis auto-step maju jika port sedang terpakai, kecuali `--strict-port` aktif)
- **Ordered candidate list**: `7745,8080,8888`
- **Inclusive port range**: `8000-8010` (selalu tetap di dalam rentang tersebut)
- **Combined**: `7745,8000-8010`
- **OS ephemeral allocation**: `auto` atau `0`
- **Service disable**: `off` / `none` / `disabled`

> [!NOTE]
> Port `< 1024` (termasuk `80` dan `443`) diblokir secara default demi keamanan dan kompatibilitas tanpa hak admin, kecuali `--allow-privileged-port` / `GITWEB_ALLOW_PRIVILEGED_PORT=1` diaktifkan eksplisit.

---

## 2. Contoh Perintah Runner & Preset Tailscale

```bash
# Wizard terminal interaktif dengan scanning port live
npm run dev:pick

# Port kustom per service (proxy /api Vite otomatis mengikuti port server)
npm run dev -- --server-port 8080 --client-port 3000

# Candidate list, range, atau ephemeral "auto"
npm run dev -- --server-port 7745,8080 --client-port 5173-5190 --tailscale-port 9443

# Aktifkan hanya backend server, atau hanya Vite client ke backend yang sudah berjalan
npm run dev -- --services server --server-port 9000 --tailscale-port off
npm run dev -- --services client --client-port 4000 --proxy-port 9000

# Mode produksi via runner dengan strict port
npm run runner -- --mode start --port 8080 --strict-port

# Cek rencana port & ketersediaan tanpa menjalankan proses
npm run dev -- --dry-run --server-port 8080-8085 --client-port auto

# Preset sederhana untuk Tailscale Serve (127.0.0.1:8001 -> HTTPS :8443)
npm run start:ts
```

Setup Tailscale Serve di PC host (cukup sekali):

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:8001
```

---

## 3. Environment Variables

| Variable | Default | Consumer(s) | Notes |
| :--- | :--- | :--- | :--- |
| `GITWEB_SERVER_PORT` / `GITWEB_PORT` / `PORT` | `7745` | `scripts/runner-core.ts`, `src/server/index.ts`, `vite.config.ts` | Prioritas: `GITWEB_SERVER_PORT` > `GITWEB_PORT` > `PORT` |
| `GITWEB_CLIENT_PORT` / `VITE_PORT` | `5173` | `scripts/runner-core.ts`, `vite.config.ts`, `src/server/index.ts` | Dev UI port; juga dilaporkan di `/api/network` & `/api/health` |
| `GITWEB_TAILSCALE_PORT` | `8443` | `scripts/runner-core.ts`, `src/server/index.ts` | Integer `1-65535` atau `off` |
| `GITWEB_PROXY_PORT` | `7745` | `scripts/runner-core.ts` | Target port backend saat menjalankan `client` saja |
| `GITWEB_API_TARGET` | `http://127.0.0.1:<port>` | `vite.config.ts`, `scripts/runner-core.ts` | Proxy URL `/api` eksplisit untuk Vite |
| `GITWEB_HOST` | `0.0.0.0` | Runner, server, Vite | Bind interface (`127.0.0.1` untuk loopback/Tailscale-only) |
| `GITWEB_SERVICES` | `server,client` | `scripts/runner-core.ts` | Dipisah koma: `server`, `client`, `all` |
| `GITWEB_MODE` | `dev` | `scripts/runner-core.ts` | `dev` atau `start` / `prod` |
| `GITWEB_STRICT_PORT` | `0` | Runner, server, Vite | Set `1` untuk menonaktifkan auto-stepping |
| `GITWEB_ALLOW_PRIVILEGED_PORT` | `0` | Runner, server | Set `1` untuk mengizinkan port `< 1024` |
| `GITWEB_NO_AUTH` | `0` | Runner, server | Set `1` untuk menonaktifkan auth token LAN |
| `GITWEB_TOKEN` | *(auto-generated)* | `src/server/auth.ts` | Override pairing token persisten di `.gitweb-auth.json` |
