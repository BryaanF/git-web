# Testing & Performance Standards

Panduan verifikasi, benchmark performa backend & frontend, dan budget ukuran bundle standar untuk **GitDock Web**.

---

## 1. Daftar Suite Pengujian

| File Test | Cakupan |
| :--- | :--- |
| [`tests/commit-standard.test.ts`](../tests/commit-standard.test.ts) | Parser, formatter, validasi 4 tipe commit, hook `--range`, dan CLI validator |
| [`tests/diff-view.test.ts`](../tests/diff-view.test.ts) | Diff working tree, header patch untuk `@git-diff-view/file`, dan empty-state `ChangesTab` |
| [`tests/fs-browse.test.ts`](../tests/fs-browse.test.ts) | Service browser folder host, deteksi `.git`, auth 401/200 `GET /api/fs/browse` |
| [`tests/git-engine.test.ts`](../tests/git-engine.test.ts) | Parser porcelain-v2, proteksi path traversal, dan integrasi `git init --bare` + `push` |
| [`tests/network.test.ts`](../tests/network.test.ts) | Parser port spec, resolver aman non-privileged, dan discovery LAN/Tailscale |
| [`tests/performance.test.ts`](../tests/performance.test.ts) | SLA latensi parser, HTTP/Git E2E, render DiffFile/React SSR, dan budget bundle |
| [`tests/runner.test.ts`](../tests/runner.test.ts) | CLI runner, anti-tabrakan port antar-service, dan proxy Vite |

### Menjalankan Pemeriksaan
```bash
npm run typecheck
npm run build
npm run test:perf
npm run verify
```

---

## 2. Performance Budgets (SLA Standar di `tests/performance.test.ts`)

Suite dijalankan sekuensial (`suite(..., { concurrency: 1 })` & `--test-concurrency=1` lewat `npm run test:perf`) dengan sampel `>= 20` untuk metrik ber-persentil agar `p50` dan `p95` akurat tanpa kontensi event-loop:

- **Backend parsers**:
  - `parseStatusPorcelainV2Z` (500 entries): `p95 <= 20 ms`
  - `parseUnifiedPatch` (60 hunks): `p95 <= 20 ms`
- **Backend HTTP + Git endpoints** (repo 80 file, file termodifikasi 1.000 baris):
  - `GET /api/health`: `p95 <= 30 ms`
  - `GET /api/repos/:id/status`: `p50 <= 320 ms` / `p95 <= 450 ms`
  - `GET /api/repos/:id/diff` (unstaged/staged): `p50 <= 420 ms` / `p95 <= 1200 ms`
  - `GET /api/repos/:id/diff` (untracked `?hint=untracked`): `p95 <= 50 ms`
  - `GET /api/repos/:id/commits`: `p50 <= 450 ms` / `p95 <= 1200 ms`
  - 8-endpoint concurrent burst: total `<= 2000 ms`
- **Frontend diff & React SSR render**:
  - `DiffFile` unified parse + highlight: 400 baris `p95 <= 120 ms`, 2.500 baris `p95 <= 500 ms`
  - `MobileDiffViewer` (400 baris): `p50 <= 80 ms` / `p95 <= 320 ms`
  - `ChangesTab` (100 file): `p50 <= 160 ms` / `p95 <= 320 ms`
  - `HistoryTab` shell: `p95 <= 80 ms`
- **Frontend production bundle (`dist/client`)**:
  - Entry JS `<= 100 KB` raw (`<= 35 KB` gzip)
  - Max single JS chunk `<= 500 KB`
  - Total CSS `<= 120 KB`
  - HTML `<= 10 KB`

---

## 3. Catatan Lingkungan Pengujian

- **`tests/git-engine.test.ts` pada sandbox Windows terbatas**: Subtest integrasi Git memanggil `git push -u origin main` ke bare repo lokal. Pada sandbox Windows yang terkunci, MSYS `sh.exe` bawaan Git dapat gagal dengan `NtCreateDirectoryObject ... 0xC0000022` walaupun kodenya sehat; verifikasi `tests/git-engine.test.ts` pada terminal lokal standar setiap kali menyentuh `src/server/git/*`.
- **Testing runner dengan aman**: Gunakan `--dry-run` untuk memverifikasi parsing CLI & resolusi port tanpa bind server, atau jalankan `scripts/dev.ts` di port uji non-default lalu hentikan setelah selesai.
