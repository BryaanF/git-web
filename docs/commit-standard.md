# Commit Message Standard & GitHub Workflow

**GitDock Web** enforces a **4-type canonical commit convention** with a concise header summary capped at **50 characters** and full implementation details in the **commit description (body)** so commit lists stay readable on GitHub, GitHub Desktop, and the mobile History UI.

---

## 1. Commit Message Structure

```text
<type>(<scope>): <high-level summary max 50 chars>

<detailed description / body:
- What changed and why
- Affected modules or endpoints
- Verification notes if relevant>
```

Or without a scope when changes span multiple modules:

```text
<type>: <high-level summary max 50 chars>

<detailed change description>
```

### Header & Description Rules
- **`<type>`** (required, lowercase): only one of these 4 canonical values:
  - `bugfix`
  - `features`
  - `chores`
  - `improvement`
- **`<scope>`** (optional, lowercase, short): `[a-z0-9][a-z0-9._/-]*` (e.g. `ui`, `git`, `repo`, `perf`, `ci`, `docs`, `api`, `security`).
- **`: <summary>`** (required colon + space): **concise high-level summary only**; the **entire first line (`<type>(<scope>): <summary>`) must be `<= 50` characters** so it never truncates in commit lists.
- **Description / Body** (separated by one blank line after the header): place all **implementation details** here (context, technical rationale, affected files, verification notes). There is no 50-character limit on the body.

---

## 2. Selecting One of the 4 Types

| Type | When to Use | Disallowed Aliases to Map | Example Header (`<= 50` chars) |
| :--- | :--- | :--- | :--- |
| **`bugfix`** | Runtime bugs, UI glitches, race conditions, crashes, security fixes, regressions | `fix`, `hotfix`, `bug` | `bugfix(ui): clear diff spinner on clean tree` |
| **`features`** | New user-facing features, API endpoints, or CLI flags | `feat`, `feature`, `add` | `features(repo): add host folder browser` |
| **`chores`** | Config, dependencies, build scripts, Git hooks, CI, docs, or tests/tooling | `chore`, `docs`, `ci`, `build`, `test`, `style` | `chores(ci): add hook and workflow checks` |
| **`improvement`** | Performance optimizations, refactors, UX polish, or cleanup | `perf`, `refactor`, `enhance`, `polish` | `improvement(git): batch staged diff blobs` |

> [!IMPORTANT]
> Any type outside this list (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `perf:`, uppercase types), missing types, or headers longer than **50 characters** are **automatically rejected** by both the local Git hook and GitHub Actions CI. Auto-generated Git commits (`Merge ...`, `Revert "..."`, `fixup! ...`, `squash! ...`) remain allowed.

---

## 3. Mandatory Workflow for AI Agents & Contributors

Whenever creating commits in this repository:

1. **Inspect changes first**: review `git status` and diffs (`git diff --staged` / `git diff`) to categorize every modified file.
2. **Write the Summary as a concise outline (`<= 50` chars)** using one of the 4 types (`bugfix`, `features`, `chores`, `improvement`) + an optional short scope.
3. **Put Details in the Description (body)**: always include a detailed commit description (via multiple `-m` flags, `git commit -m "<summary>" -m "<detailed description>"`, or your editor).
4. **Split unrelated work**: separate distinct change types (e.g. `bugfix` vs `features` vs `chores`) into logical commits unless explicitly asked to combine.
5. **Validate cleanly**:
   - Check messages beforehand via `npm run check:commit -- --message "<summary>"`.
   - Never bypass `.githooks/commit-msg` with `--no-verify`.
6. **Single Source of Truth**: validation rules live in [`src/shared/commit-standard.ts`](../src/shared/commit-standard.ts) (`MAX_COMMIT_SUBJECT_LENGTH = 50`).

---

## 4. Automation Layers (Local, Web UI, and GitHub)

1. **Local Git Hook ([`.githooks/commit-msg`](../.githooks/commit-msg))**
   - Installed automatically during `npm install` (`prepare` -> [`scripts/install-hooks.ts`](../scripts/install-hooks.ts)) unless skipped by `CI` or an existing custom `core.hooksPath`, or manually via `npm run hooks:install`.
   - Executes `node scripts/validate-commit-msg.ts "$1"` on every `git commit`.
2. **CLI Validator ([`scripts/validate-commit-msg.ts`](../scripts/validate-commit-msg.ts))**
   - Validate a single header:
     ```bash
     npm run check:commit -- --message "features(ui): add browse picker"
     ```
   - Validate a Git commit range:
     ```bash
     npm run check:commit -- --range main HEAD
     ```
3. **GitDock Web Commit Composer ([`ChangesTab.tsx`](../src/client/components/ChangesTab.tsx) & [`StatusBadge.tsx`](../src/client/components/StatusBadge.tsx))**
   - Provides quick selectors for `bugfix`, `features`, `chores`, `improvement` (plus `custom` for external repositories), optional `Scope`, live `n/50` header counter, and a **Description** field.
4. **GitHub Actions CI ([`.github/workflows/commit-standard.yml`](../.github/workflows/commit-standard.yml))**
   - Validates all commits on every `push` and `pull_request` against the 4-type format and 50-character header cap.
