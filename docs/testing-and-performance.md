# Testing & Performance Standards

Verification guide, backend/frontend performance benchmarks, and production bundle budgets for **GitDock Web**.

---

## 1. Test Suite Inventory

| Test File | Coverage |
| :--- | :--- |
| [`tests/commit-standard.test.ts`](../tests/commit-standard.test.ts) | Parser, formatter, 4-type commit validation, `--range` checks, and CLI validator |
| [`tests/diff-view.test.ts`](../tests/diff-view.test.ts) | Working-tree diff payloads, `@git-diff-view/file` patch headers, and `ChangesTab` empty state |
| [`tests/fs-browse.test.ts`](../tests/fs-browse.test.ts) | Host folder browser, `.git` detection, auth `401`/`200`, CSRF/origin checks, DNS-rebinding guard, rate limit, and `--workspace-root` confinement |
| [`tests/git-engine.test.ts`](../tests/git-engine.test.ts) | Porcelain-v2 parser, path traversal & branch-flag injection guards, and `git init --bare` + `push` integration |
| [`tests/network.test.ts`](../tests/network.test.ts) | Port spec parser, safe non-privileged port resolver, and LAN/Tailscale network discovery |
| [`tests/performance.test.ts`](../tests/performance.test.ts) | Parser, HTTP/Git E2E, `DiffFile`/React SSR render SLAs, and Vite bundle budgets |
| [`tests/pm2-autostart.test.ts`](../tests/pm2-autostart.test.ts) | PM2 ecosystem preset, silent Windows Startup VBS generator, and Task Scheduler args |
| [`tests/runner.test.ts`](../tests/runner.test.ts) | CLI runner parsing, cross-service port de-confliction, and Vite proxy wiring |

### Running Checks
```bash
npm run typecheck
npm run build
npm test
npm run test:perf
npm run verify
```

---

## 2. Performance Budgets (SLAs in `tests/performance.test.ts`)

Performance tests run sequentially (`suite(..., { concurrency: 1 })` and `--test-concurrency=1` via `npm run test:perf` / `npm test`) with `>= 20` samples for percentile metrics so `p50` and `p95` stay free of worker contention:

- **Backend parsers**:
  - `parseStatusPorcelainV2Z` (500 entries): `p95 <= 20 ms`
  - `parseUnifiedPatch` (60 hunks): `p95 <= 20 ms`
- **Backend HTTP + Git endpoints** (80-file repo, 1,000-line modified file):
  - `GET /api/health`: `p95 <= 30 ms`
  - `GET /api/repos/:id/status`: `p50 <= 320 ms` / `p95 <= 450 ms`
  - `GET /api/repos/:id/diff` (unstaged/staged): `p50 <= 420 ms` / `p95 <= 1200 ms`
  - `GET /api/repos/:id/diff` (untracked `?hint=untracked`): `p95 <= 50 ms`
  - `GET /api/repos/:id/commits`: `p50 <= 450 ms` / `p95 <= 1200 ms`
  - 8-endpoint concurrent burst: total `<= 2000 ms`
- **Frontend diff & React SSR render**:
  - `DiffFile` unified parse + highlight: 400 lines `p95 <= 120 ms`, 2,500 lines `p95 <= 500 ms`
  - `MobileDiffViewer` (400 lines): `p50 <= 80 ms` / `p95 <= 320 ms`
  - `ChangesTab` (100 files): `p50 <= 160 ms` / `p95 <= 320 ms`
  - `HistoryTab` shell: `p95 <= 80 ms`
- **Frontend production bundle (`dist/client`)**:
  - Entry JS `<= 100 KB` raw (`<= 35 KB` gzip)
  - Max single JS chunk `<= 500 KB`
  - Total CSS `<= 120 KB`
  - HTML `<= 10 KB`

---

## 3. Environment Notes

- **`tests/git-engine.test.ts` inside restricted Windows sandboxes**: The Git integration subtest executes `git push -u origin main` against a local bare repository. Inside restricted Windows sandboxes, MSYS `sh.exe` bundled with Git for Windows can fail with `NtCreateDirectoryObject ... 0xC0000022`. Run `tests/git-engine.test.ts` in a standard local terminal whenever modifying `src/server/git/*`.
- **Safe runner smoke checks**: Use `--dry-run` to validate CLI parsing and live port resolution without binding ports, or run `scripts/dev.ts` on non-default test ports and stop it immediately after testing.
