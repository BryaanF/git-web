import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Minus,
  Plus,
  RotateCcw,
  Send,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  COMMIT_TYPES,
  COMMIT_TYPE_META,
  MAX_COMMIT_SUBJECT_LENGTH,
  formatCommitSubject,
  parseCommitSubject,
  type CommitType,
} from '../../shared/commit-standard.ts';
import type { ChangedFile, DiffPayload, RepoStatusSummary } from '../../shared/types.ts';
import { api } from '../api.ts';
import { MobileDiffViewer } from './MobileDiffViewer.tsx';
import { FileStatusBadge } from './StatusBadge.tsx';

interface ChangesTabProps {
  repoId: string;
  status: RepoStatusSummary;
  refreshTick: number;
  onStatusUpdated: (status: RepoStatusSummary) => void;
  onCommitted: () => void;
}

type SelectedTarget = {
  path: string;
  section: 'unstaged' | 'staged' | 'conflicted';
};

export function ChangesTab({
  repoId,
  status,
  refreshTick,
  onStatusUpdated,
  onCommitted,
}: ChangesTabProps) {
  const [filter, setFilter] = useState<'all' | 'unstaged' | 'staged'>('all');
  const [selected, setSelected] = useState<SelectedTarget | null>(null);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [contextLines, setContextLines] = useState(3);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [commitType, setCommitType] = useState<CommitType | 'custom' | null>(null);
  const [commitScope, setCommitScope] = useState('');
  const [commitSummary, setCommitSummary] = useState('');
  const [commitDesc, setCommitDesc] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState<ChangedFile | null>(null);

  const diffCacheRef = useRef<Map<string, DiffPayload>>(new Map());
  const loadedTargetKeyRef = useRef<string | null>(null);
  const prevRefreshTickRef = useRef<number>(refreshTick);

  const flatFiles = useMemo(() => {
    const items: ChangedFile[] = [];
    if (filter !== 'unstaged') items.push(...status.staged);
    if (filter !== 'staged') items.push(...status.unstaged);
    items.push(...status.conflicted);
    return items;
  }, [filter, status.conflicted, status.staged, status.unstaged]);

  // Clear cache and selection state when repository switches
  useEffect(() => {
    diffCacheRef.current.clear();
    loadedTargetKeyRef.current = null;
    setSelected(null);
    setDiff(null);
    setDiffError(null);
    setDiffLoading(false);
  }, [repoId]);

  // Clear or preserve valid selection when status/filter refreshes, and auto-select on desktop
  useEffect(() => {
    if (selected) {
      const stillExists = flatFiles.some(
        (f) => f.path === selected.path && f.section === selected.section,
      );
      if (!stillExists) {
        setSelected(null);
        setDiff(null);
        setDiffError(null);
        setDiffLoading(false);
        loadedTargetKeyRef.current = null;
      }
      return;
    }

    if (
      typeof window !== 'undefined' &&
      window.innerWidth >= 1024 &&
      flatFiles.length > 0
    ) {
      setSelected({ path: flatFiles[0].path, section: flatFiles[0].section });
    }
  }, [flatFiles, selected]);

  const selectedFileMeta = useMemo(() => {
    if (!selected) return undefined;
    return flatFiles.find((f) => f.path === selected.path && f.section === selected.section);
  }, [flatFiles, selected]);

  const selectedIndex = useMemo(() => {
    if (!selected) return -1;
    return flatFiles.findIndex(
      (f) => f.path === selected.path && f.section === selected.section,
    );
  }, [flatFiles, selected]);

  const flatFilesRef = useRef<ChangedFile[]>(flatFiles);
  flatFilesRef.current = flatFiles;
  const selectedIndexRef = useRef<number>(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  useEffect(() => {
    const tickChanged = prevRefreshTickRef.current !== refreshTick;
    prevRefreshTickRef.current = refreshTick;

    if (tickChanged) {
      diffCacheRef.current.clear();
    }

    if (!selected) {
      setDiff(null);
      setDiffError(null);
      setDiffLoading(false);
      loadedTargetKeyRef.current = null;
      return;
    }

    let cancelled = false;
    const targetKey = `${repoId}:${selected.section}:${selected.path}:${contextLines}`;

    const isSameTargetBackgroundRefresh =
      tickChanged && loadedTargetKeyRef.current === targetKey;

    const cached = !tickChanged ? diffCacheRef.current.get(targetKey) : undefined;
    if (cached) {
      loadedTargetKeyRef.current = targetKey;
      setDiff(cached);
      setDiffError(null);
      setDiffLoading(false);
    } else {
      if (!isSameTargetBackgroundRefresh) {
        setDiff(null);
        setDiffLoading(true);
      }
      setDiffError(null);

      const hint = selectedFileMeta?.isUntracked ? 'untracked' : undefined;
      api
        .getWorkingDiff(repoId, selected.path, selected.section, contextLines, hint)
        .then((res) => {
          if (cancelled) return;
          if (diffCacheRef.current.size > 40) {
            const firstKey = diffCacheRef.current.keys().next().value;
            if (firstKey) diffCacheRef.current.delete(firstKey);
          }
          diffCacheRef.current.set(targetKey, res);
          loadedTargetKeyRef.current = targetKey;
          setDiff((prev) => {
            if (
              prev &&
              prev.path === res.path &&
              prev.patch === res.patch &&
              prev.status === res.status &&
              prev.additions === res.additions &&
              prev.deletions === res.deletions
            ) {
              return prev;
            }
            return res;
          });

          // Prefetch next adjacent file quietly for instant Next-file navigation
          const currentIdx = selectedIndexRef.current;
          const nextFile = currentIdx >= 0 ? flatFilesRef.current[currentIdx + 1] : undefined;
          if (nextFile) {
            const nextKey = `${repoId}:${nextFile.section}:${nextFile.path}:${contextLines}`;
            if (!diffCacheRef.current.has(nextKey)) {
              const nextHint = nextFile.isUntracked ? 'untracked' : undefined;
              void api
                .getWorkingDiff(repoId, nextFile.path, nextFile.section, contextLines, nextHint)
                .then((nextDiff) => {
                  if (!cancelled) {
                    diffCacheRef.current.set(nextKey, nextDiff);
                  }
                })
                .catch(() => {});
            }
          }
        })
        .catch((err) => {
          if (!cancelled && !isSameTargetBackgroundRefresh) {
            setDiffError(err instanceof Error ? err.message : 'Failed to load diff');
          }
        })
        .finally(() => {
          if (!cancelled) setDiffLoading(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [repoId, selected, selectedFileMeta?.isUntracked, contextLines, refreshTick]);

  const runAction = async (key: string, fn: () => Promise<RepoStatusSummary>) => {
    setBusyAction(key);
    setActionError(null);
    try {
      const next = await fn();
      onStatusUpdated(next);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusyAction(null);
    }
  };

  const detectedCommitMeta = useMemo(() => parseCommitSubject(commitSummary), [commitSummary]);
  const formattedCommitSummary = useMemo(
    () =>
      formatCommitSubject({
        type: commitType,
        scope: commitScope,
        summary: commitSummary,
      }),
    [commitType, commitScope, commitSummary],
  );
  const commitHasValidType =
    commitType === 'custom' || Boolean(commitType) || Boolean(detectedCommitMeta);
  const commitTooLong =
    commitType !== 'custom' && formattedCommitSummary.length > MAX_COMMIT_SUBJECT_LENGTH;
  const isCommitDisabled =
    busyAction !== null ||
    status.staged.length === 0 ||
    !commitSummary.trim() ||
    !commitHasValidType ||
    commitTooLong;

  const handleCommit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !formattedCommitSummary.trim() ||
      status.staged.length === 0 ||
      !commitHasValidType ||
      commitTooLong
    ) {
      return;
    }
    setBusyAction('commit');
    setActionError(null);
    try {
      const res = await api.commit(repoId, formattedCommitSummary, commitDesc);
      onStatusUpdated(res.status);
      setCommitType(null);
      setCommitScope('');
      setCommitSummary('');
      setCommitDesc('');
      onCommitted();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Commit failed');
    } finally {
      setBusyAction(null);
    }
  };

  const renderFileRow = (file: ChangedFile) => {
    const isSelected = selected?.path === file.path && selected?.section === file.section;
    const isStaged = file.section === 'staged';

    return (
      <div
        key={`${file.section}:${file.path}`}
        className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 transition ${
          isSelected
            ? 'border-sky-500/60 bg-sky-500/10'
            : 'border-[#30363d]/80 bg-[#0d1117] hover:border-[#484f58]'
        }`}
      >
        <button
          type="button"
          onClick={() => setSelected({ path: file.path, section: file.section })}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <FileStatusBadge status={file.status} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-xs font-medium text-[#e6edf3]">
              {file.path.split('/').pop()}
            </div>
            <div className="truncate font-mono text-[11px] text-[#6e7681]">
              {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
            </div>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-[#484f58] lg:hidden" />
        </button>

        <div className="flex shrink-0 items-center gap-1">
          {!isStaged && file.section === 'unstaged' && (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => setConfirmDiscard(file)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#30363d] bg-[#161b22] text-[#8b949e] hover:border-rose-500/40 hover:text-rose-400"
              title="Discard changes"
              aria-label={`Discard ${file.path}`}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() =>
              void runAction(`${file.section}:${file.path}`, () =>
                isStaged
                  ? api.unstageFiles(repoId, [file.path])
                  : api.stageFiles(repoId, [file.path]),
              )
            }
            className={`flex h-8 w-8 items-center justify-center rounded-lg border text-xs font-semibold transition active:scale-95 ${
              isStaged
                ? 'border-amber-500/35 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
                : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
            }`}
            title={isStaged ? 'Unstage file' : 'Stage file'}
            aria-label={isStaged ? `Unstage ${file.path}` : `Stage ${file.path}`}
          >
            {isStaged ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          </button>
        </div>
      </div>
    );
  };

  const totalWorking = status.unstaged.length + status.staged.length + status.conflicted.length;

  return (
    <div className="pb-24">
      {actionError && (
        <div className="mb-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-200">
          {actionError}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[380px_1fr]">
        {/* File List Pane (Hidden on mobile when a file diff is open) */}
        <div className={`${selected ? 'hidden lg:block' : 'block'} space-y-4`}>
          {/* Segment filter chips */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                filter === 'all'
                  ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40'
                  : 'bg-[#161b22] text-[#8b949e]'
              }`}
            >
              All ({totalWorking})
            </button>
            <button
              type="button"
              onClick={() => setFilter('unstaged')}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                filter === 'unstaged'
                  ? 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40'
                  : 'bg-[#161b22] text-[#8b949e]'
              }`}
            >
              Unstaged ({status.unstaged.length})
            </button>
            <button
              type="button"
              onClick={() => setFilter('staged')}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                filter === 'staged'
                  ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40'
                  : 'bg-[#161b22] text-[#8b949e]'
              }`}
            >
              Staged ({status.staged.length})
            </button>
          </div>

          {totalWorking === 0 ? (
            <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-8 text-center">
              <CheckCircle2 className="mx-auto h-9 w-9 text-emerald-400/80" />
              <h3 className="mt-2.5 text-sm font-semibold text-[#e6edf3]">Working tree clean</h3>
              <p className="mt-1 text-xs text-[#8b949e]">
                No unstaged, untracked, or staged changes. Check History to verify pushed commits.
              </p>
            </div>
          ) : (
            <>
              {status.conflicted.length > 0 && (
                <section className="rounded-2xl border border-rose-500/40 bg-rose-500/5 p-3">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-rose-300">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Merge Conflicts ({status.conflicted.length})
                  </div>
                  <div className="space-y-1.5">{status.conflicted.map(renderFileRow)}</div>
                </section>
              )}

              {filter !== 'unstaged' && (
                <section className="rounded-2xl border border-emerald-500/25 bg-[#161b22] p-3">
                  <div className="mb-2.5 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-emerald-400" />
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-300">
                        Staged Changes ({status.staged.length})
                      </h3>
                    </div>
                    {status.staged.length > 0 && (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => void runAction('unstage-all', () => api.unstageFiles(repoId))}
                        className="rounded-lg bg-[#21262d] px-2.5 py-1 text-[11px] font-medium text-[#e6edf3] hover:bg-[#30363d]"
                      >
                        Unstage All
                      </button>
                    )}
                  </div>
                  {status.staged.length === 0 ? (
                    <p className="py-2 text-xs text-[#6e7681]">
                      No staged files yet. Tap + on any unstaged file to stage it.
                    </p>
                  ) : (
                    <div className="space-y-1.5">{status.staged.map(renderFileRow)}</div>
                  )}
                </section>
              )}

              {filter !== 'staged' && (
                <section className="rounded-2xl border border-[#30363d] bg-[#161b22] p-3">
                  <div className="mb-2.5 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-amber-400" />
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-300">
                        Unstaged &amp; Untracked ({status.unstaged.length})
                      </h3>
                    </div>
                    {status.unstaged.length > 0 && (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => void runAction('stage-all', () => api.stageFiles(repoId))}
                        className="rounded-lg bg-emerald-600/20 px-2.5 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-600/30"
                      >
                        Stage All
                      </button>
                    )}
                  </div>
                  {status.unstaged.length === 0 ? (
                    <p className="py-2 text-xs text-[#6e7681]">No unstaged or untracked files.</p>
                  ) : (
                    <div className="space-y-1.5">{status.unstaged.map(renderFileRow)}</div>
                  )}
                </section>
              )}

              {/* Commit Composer */}
              <form
                onSubmit={(e) => void handleCommit(e)}
                className="space-y-2.5 rounded-2xl border border-[#30363d] bg-[#161b22] p-3.5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[#e6edf3]">
                    Commit Staged ({status.staged.length})
                  </span>
                  <span className="font-mono text-[11px] text-[#8b949e]">{status.branch}</span>
                </div>

                {/* 4-type Commit Standard Selector */}
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {COMMIT_TYPES.map((type) => {
                      const active = commitType === type || (!commitType && detectedCommitMeta?.type === type);
                      const activeColors: Record<CommitType, string> = {
                        bugfix: 'border-rose-500/60 bg-rose-500/20 text-rose-200 ring-1 ring-rose-500/35',
                        features: 'border-emerald-500/60 bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/35',
                        chores: 'border-zinc-400/60 bg-zinc-500/20 text-zinc-100 ring-1 ring-zinc-400/35',
                        improvement: 'border-sky-500/60 bg-sky-500/20 text-sky-200 ring-1 ring-sky-500/35',
                      };
                      return (
                        <button
                          key={type}
                          type="button"
                          title={COMMIT_TYPE_META[type].description}
                          onClick={() => setCommitType((prev) => (prev === type ? null : type))}
                          className={`rounded-lg border px-2.5 py-1 font-mono text-[11px] font-semibold transition ${
                            active
                              ? activeColors[type]
                              : 'border-[#30363d] bg-[#0d1117] text-[#8b949e] hover:border-[#484f58] hover:text-[#e6edf3]'
                          }`}
                        >
                          {type}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      title="Freeform commit header for external repositories"
                      onClick={() => setCommitType((prev) => (prev === 'custom' ? null : 'custom'))}
                      className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
                        commitType === 'custom'
                          ? 'border-[#58a6ff]/60 bg-[#58a6ff]/15 text-sky-200'
                          : 'border-[#30363d] bg-[#0d1117] text-[#6e7681] hover:text-[#c9d1d9]'
                      }`}
                    >
                      custom
                    </button>
                  </div>

                  {commitType && commitType !== 'custom' && (
                    <input
                      type="text"
                      value={commitScope}
                      onChange={(e) => setCommitScope(e.target.value)}
                      placeholder="Scope (optional, e.g. ui, git, api)"
                      className="w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-1.5 font-mono text-xs text-[#e6edf3] placeholder-[#484f58] focus:border-sky-500 focus:outline-none"
                    />
                  )}
                </div>

                <input
                  type="text"
                  value={commitSummary}
                  onChange={(e) => setCommitSummary(e.target.value)}
                  placeholder={
                    commitType && commitType !== 'custom'
                      ? `Short summary (e.g. ${COMMIT_TYPE_META[commitType].example.replace(/^[^:]+:\s*/, '')})`
                      : 'Commit summary (select a type above or write <type>: <summary>)'
                  }
                  className="w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-[#e6edf3] placeholder-[#484f58] focus:border-sky-500 focus:outline-none"
                />

                {formattedCommitSummary ? (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2 rounded-lg bg-[#0d1117] px-2.5 py-1.5 text-[11px]">
                      <span className="truncate font-mono text-[#c9d1d9]" title={formattedCommitSummary}>
                        {commitHasValidType ? formattedCommitSummary : 'Select type: bugfix / features / chores / improvement'}
                      </span>
                      <span
                        className={`shrink-0 font-mono ${
                          commitTooLong
                            ? 'font-semibold text-rose-400'
                            : formattedCommitSummary.length >= 42
                              ? 'text-amber-400'
                              : 'text-[#6e7681]'
                        }`}
                      >
                        {formattedCommitSummary.length}/{MAX_COMMIT_SUBJECT_LENGTH}
                      </span>
                    </div>
                    {commitTooLong && (
                      <p className="text-[11px] text-rose-400">
                        Summary max {MAX_COMMIT_SUBJECT_LENGTH} characters — keep the header concise and move details into the description.
                      </p>
                    )}
                  </div>
                ) : (
                  !commitType && (
                    <p className="text-[11px] text-[#6e7681]">
                      Commit standard: <code className="text-[#8b949e]">bugfix</code>,{' '}
                      <code className="text-[#8b949e]">features</code>,{' '}
                      <code className="text-[#8b949e]">chores</code>, or{' '}
                      <code className="text-[#8b949e]">improvement</code> (max {MAX_COMMIT_SUBJECT_LENGTH} chars).
                    </p>
                  )
                )}

                <textarea
                  rows={3}
                  value={commitDesc}
                  onChange={(e) => setCommitDesc(e.target.value)}
                  placeholder="Change details / description (explain what changed and why)"
                  className="w-full resize-none rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2 text-xs text-[#e6edf3] placeholder-[#484f58] focus:border-sky-500 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={isCommitDisabled}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Send className="h-4 w-4" />
                  {busyAction === 'commit'
                    ? 'Committing...'
                    : `Commit to ${status.branch}`}
                </button>
              </form>
            </>
          )}
        </div>

        {/* Diff Viewer Pane */}
        <div className={selected ? 'block' : 'hidden lg:block'}>
          <MobileDiffViewer
            diff={selected ? diff : null}
            loading={Boolean(selected) && diffLoading}
            error={selected ? diffError : null}
            contextLines={contextLines}
            onChangeContextLines={setContextLines}
            onBack={selected ? () => setSelected(null) : undefined}
            sectionLabel={selected?.section}
            emptyTitle={
              totalWorking === 0
                ? 'No changed files'
                : flatFiles.length === 0
                  ? 'No files in this filter'
                  : undefined
            }
            emptyDescription={
              totalWorking === 0
                ? 'Working tree is clean. Modify, add, or stage files to inspect diffs here.'
                : flatFiles.length === 0
                  ? 'Switch filters on the left to view unstaged or staged changes.'
                  : undefined
            }
            filePositionLabel={
              selectedIndex >= 0 ? `${selectedIndex + 1} / ${flatFiles.length}` : undefined
            }
            onPrevFile={
              selectedIndex > 0
                ? () => {
                    const prev = flatFiles[selectedIndex - 1];
                    setSelected({ path: prev.path, section: prev.section });
                  }
                : undefined
            }
            onNextFile={
              selectedIndex >= 0 && selectedIndex < flatFiles.length - 1
                ? () => {
                    const next = flatFiles[selectedIndex + 1];
                    setSelected({ path: next.path, section: next.section });
                  }
                : undefined
            }
            actionButton={
              selected && selected.section !== 'conflicted'
                ? {
                    label: selected.section === 'staged' ? 'Unstage' : 'Stage',
                    variant: selected.section === 'staged' ? 'unstage' : 'stage',
                    busy: busyAction !== null,
                    onClick: () => {
                      const targetPath = selected.path;
                      const isStaged = selected.section === 'staged';
                      void runAction('diff-toggle', async () => {
                        const updated = isStaged
                          ? await api.unstageFiles(repoId, [targetPath])
                          : await api.stageFiles(repoId, [targetPath]);
                        setSelected({
                          path: targetPath,
                          section: isStaged ? 'unstaged' : 'staged',
                        });
                        return updated;
                      });
                    },
                  }
                : undefined
            }
          />
        </div>
      </div>

      {/* Discard confirmation dialog */}
      {confirmDiscard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-[#30363d] bg-[#161b22] p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-[#e6edf3]">Discard changes?</h3>
            <p className="mt-2 text-xs leading-relaxed text-[#8b949e]">
              This will permanently discard unstaged changes to{' '}
              <code className="break-all text-rose-300">{confirmDiscard.path}</code>
              {confirmDiscard.isUntracked ? ' (untracked file will be deleted).' : '.'}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDiscard(null)}
                className="rounded-xl border border-[#30363d] bg-[#21262d] px-4 py-2 text-xs font-medium text-[#e6edf3]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = confirmDiscard;
                  setConfirmDiscard(null);
                  void runAction(`discard:${target.path}`, () =>
                    api.discardFile(repoId, target.path),
                  );
                }}
                className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500"
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
