# Commit Message Standard & GitHub Workflow

Repository **GitDock Web** menggunakan **4 tipe commit canonical** dengan format **summary garis besar maksimal 50 karakter** dan **detail di description (body)** agar tampilan di GitHub, GitHub Desktop, dan UI History mobile tidak pernah terpotong.

---

## 1. Struktur Commit Message

```text
<type>(<scope>): <summary garis besar max 50 char>

<description / body detail:
- Apa yang diubah dan mengapa
- Modul atau endpoint terkait
- Catatan verifikasi / dampak jika relevan>
```

Atau tanpa scope jika bersifat lintas modul/global:

```text
<type>: <summary garis besar max 50 char>

<description detail perubahan>
```

### Aturan Header & Description
- **`<type>`** (wajib, lowercase): hanya salah satu dari 4 tipe berikut:
  - `bugfix`
  - `features`
  - `chores`
  - `improvement`
- **`<scope>`** (opsional, lowercase, ringkas agar menghemat ruang): `[a-z0-9][a-z0-9._/-]*` (contoh: `ui`, `git`, `repo`, `perf`, `ci`, `docs`, `api`).
- **`: <summary>`** (wajib titik dua diikuti spasi): **garis besar singkat** saja; **total baris pertama (`<type>(<scope>): <summary>`) maksimal 50 karakter** agar tidak terpotong di daftar commit.
- **Description / Body** (pisahkan 1 baris kosong setelah header): jelaskan seluruh **detail perubahan** di sini (konteks, alasan teknis, file/komponen terdampak, atau poin verifikasi). Tidak dibatasi 50 karakter.

---

## 2. Panduan Pemilihan 4 Tipe Commit

| Tipe | Kapan Digunakan | Tipe Non-Standar yang Harus Dipetakan | Contoh Header (`<= 50` char) |
| :--- | :--- | :--- | :--- |
| **`bugfix`** | Memperbaiki bug runtime, UI glitch, race condition, crash, atau regresi | `fix`, `hotfix`, `bug` | `bugfix(ui): clear diff spinner on clean tree` |
| **`features`** | Menambah fitur baru yang terlihat user, endpoint API baru, atau opsi CLI baru | `feat`, `feature`, `add` | `features(repo): add host folder browser` |
| **`chores`** | Konfigurasi, dependencies, script build, Git hooks, CI, docs, atau tooling/tests | `chore`, `docs`, `ci`, `build`, `test`, `style` | `chores(ci): add hook and workflow checks` |
| **`improvement`** | Optimasi performa, refactor internal, penyempurnaan UX, atau pembersihan kode | `perf`, `refactor`, `enhance`, `polish` | `improvement(git): batch staged diff blobs` |

> [!IMPORTANT]
> Tipe di luar daftar (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `perf:`, huruf kapital), header tanpa tipe, atau header melebihi **50 karakter** **otomatis ditolak** oleh hook Git lokal maupun GitHub Actions CI. Commit auto-generated Git seperti `Merge ...`, `Revert "..."`, `fixup! ...`, `squash! ...` tetap diizinkan.

---

## 3. Aturan Wajib Agen AI & Kontributor Saat Ada Perintah Commit

Setiap kali ada instruksi atau tugas untuk membuat commit (mis. *"commit"*, *"commit perubahan ini"*, *"commit ke github"*):

1. **Inspeksi perubahan terlebih dahulu**: periksa `git status` dan diff (`git diff --staged` / `git diff`) untuk memahami kategori setiap file yang diubah.
2. **Tulis Summary sebagai garis besar (`<= 50` karakter)** dengan salah satu dari 4 tipe (`bugfix`, `features`, `chores`, `improvement`) + scope ringkas. Hitung panjang total baris summary agar tidak lebih dari 50 karakter!
3. **Tulis Detail di Description (body)**: selalu sertakan commit description (via multiple `-m` di `git commit -m "<summary>" -m "<detail description>"` atau editor) yang menjelaskan rincian perubahan secara jelas.
4. **Pisahkan jika perlu**: jika ada perubahan berbeda jenis (mis. bugfix + fitur + chores), pecah menjadi beberapa commit terpisah kecuali user meminta digabung.
5. **Validasi otomatis**:
   - Bisa uji terlebih dahulu via `npm run check:commit -- --message "<summary>"`.
   - Jangan pernah melewati hook `.githooks/commit-msg` menggunakan `--no-verify`.
6. **Single Source of Truth**: seluruh aturan validasi berada di [`src/shared/commit-standard.ts`](../src/shared/commit-standard.ts) (`MAX_COMMIT_SUBJECT_LENGTH = 50`).

---

## 4. Lapisan Otomatisasi (Lokal, Aplikasi Web, dan GitHub)

1. **Hook Git Lokal ([`.githooks/commit-msg`](../.githooks/commit-msg))**
   - Otomatis terpasang saat `npm install` (via script `prepare` -> [`scripts/install-hooks.ts`](../scripts/install-hooks.ts)), atau jalankan manual `npm run hooks:install`.
   - Menjalankan `node scripts/validate-commit-msg.ts "$1"` pada setiap `git commit`.
2. **CLI Validator ([`scripts/validate-commit-msg.ts`](../scripts/validate-commit-msg.ts))**
   - Cek pesan tunggal:
     ```bash
     npm run check:commit -- --message "features(ui): add browse picker"
     ```
   - Cek rentang commit Git:
     ```bash
     npm run check:commit -- --range main HEAD
     ```
3. **GitDock Web Commit Composer ([`ChangesTab.tsx`](../src/client/components/ChangesTab.tsx) & [`StatusBadge.tsx`](../src/client/components/StatusBadge.tsx))**
   - Menyediakan pilihan tipe `bugfix`, `features`, `chores`, `improvement` (+ `custom`), `Scope (opsional)`, preview header dengan penghitung **`n/50`** (memblokir submit jika > 50 karakter pada standar 4 tipe), serta kolom **Description** untuk detail perubahan.
4. **GitHub Actions CI ([`.github/workflows/commit-standard.yml`](../.github/workflows/commit-standard.yml))**
   - Memvalidasi otomatis seluruh commit pada setiap `push` dan `pull_request` terhadap format 4 tipe & batas 50 karakter header.
