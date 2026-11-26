import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  CheckCircle2,
  ChevronRight,
  CloudCheck,
  GitCommitHorizontal,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type {
  CommitDetail,
  CommitPushState,
  CommitSummary,
  DiffPayload,
  RemoteVerifyResult,
  RepoStatusSummary,
} from '../../shared/types.ts';
import { api } from '../api.ts';
import { MobileDiffViewer } from './MobileDiffViewer.tsx';
import { CommitTypeBadge, FileStatusBadge, PushStateBadge } from './StatusBadge.tsx';

interface HistoryTabProps {
  repoId: string;
  status: RepoStatusSummary;
  refreshTick: number;
  onStatusUpdated: (status: RepoStatusSummary) => void;
}

export function HistoryTab({ repoId, status, refreshTick, onStatusUpdated }: HistoryTabProps) {
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | CommitPushState>('all');

  const [selectedCommitSha, setSelectedCommitSha] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<CommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [contextLines, setContextLines] = useState(3);

  const [verifyResult, setVerifyResult] = useState<RemoteVerifyResult | null>(null);
  const [remoteBusy, setRemoteBusy] = useState<'verify' | 'fetch' | 'pull' | 'push' | null>(null);
  const [remoteFeedback, setRemoteFeedback] = useState<string | null>(null);
  const [confirmPush, setConfirmPush] = useState(false);

  const loadCommits = async (offset = 0, append = false) => {
    setLoading(true);
    try {
      const res = await api.getCommits(repoId, 40, offset);
      setCommits((prev) => (append ? [...prev, ...res.commits] : res.commits));
      setHasMore(res.hasMore);
    } catch (err) {
      setRemoteFeedback(err instanceof Error ? err.message : 'Failed to load history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSelectedCommitSha(null);
    setCommitDetail(null);
    setDetailLoading(false);
    setSelectedFilePath(null);
    setDiff(null);
    setDiffError(null);
    setDiffLoading(false);
    setVerifyResult(null);
  }, [repoId]);

  useEffect(() => {
    void loadCommits(0, false);
  }, [repoId, refreshTick]);

  useEffect(() => {
    if (!selectedCommitSha) {
      setCommitDetail(null);
      setDetailLoading(false);
      setSelectedFilePath(null);
      setDiff(null);
      setDiffError(null);
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setSelectedFilePath(null);
    setDiff(null);
    setDiffError(null);
    setDiffLoading(false);
    api
      .getCommitDetail(repoId, selectedCommitSha)
      .then((res) => {
        if (!cancelled) {
          setCommitDetail(res);
          if (res.files.length > 0 && typeof window !== 'undefined' && window.innerWidth >= 1024) {
            setSelectedFilePath(res.files[0].path);
          }
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, selectedCommitSha]);

  useEffect(() => {
    if (!selectedCommitSha || !selectedFilePath) {
      setDiff(null);
      setDiffError(null);
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiff(null);
    setDiffLoading(true);
    setDiffError(null);
    api
      .getCommitFileDiff(repoId, selectedCommitSha, selectedFilePath, contextLines)
      .then((res) => {
        if (!cancelled) setDiff(res);
      })
      .catch((err) => {
        if (!cancelled) setDiffError(err instanceof Error ? err.message : 'Failed to load commit diff');
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, selectedCommitSha, selectedFilePath, contextLines]);

  const counts = useMemo(() => {
    return {
      all: commits.length,
      pushed: commits.filter((c) => c.pushState === 'pushed').length,
      unpushed: commits.filter((c) => c.pushState === 'unpushed').length,
      remote_only: commits.filter((c) => c.pushState === 'remote_only').length,
    };
  }, [commits]);

  const filteredCommits = useMemo(() => {
    if (filter === 'all') return commits;
    return commits.filter((c) => c.pushState === filter);
  }, [commits, filter]);

  const selectedFileIndex = useMemo(() => {
    if (!commitDetail || !selectedFilePath) return -1;
    return commitDetail.files.findIndex((f) => f.path === selectedFilePath);
  }, [commitDetail, selectedFilePath]);

  const handleVerifyLive = async () => {
    setRemoteBusy('verify');
    setRemoteFeedback(null);
    try {
      const res = await api.verifyRemote(repoId);
      setVerifyResult(res);
    } catch (err) {
      setRemoteFeedback(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setRemoteBusy(null);
    }
  };

  const handleFetch = async () => {
    setRemoteBusy('fetch');
    setRemoteFeedback(null);
    try {
      const res = await api.fetchRemote(repoId);
      onStatusUpdated(res.status);
      setRemoteFeedback(res.output);
      await loadCommits(0, false);
      const verified = await api.verifyRemote(repoId);
      setVerifyResult(verified);
    } catch (err) {
      setRemoteFeedback(err instanceof Error ? err.message : 'Fetch failed');
    } finally {
      setRemoteBusy(null);
    }
  };

  const handlePull = async () => {
    setRemoteBusy('pull');
    setRemoteFeedback(null);
    try {
      const res = await api.pullRemote(repoId);
      onStatusUpdated(res.status);
      setRemoteFeedback(res.output);
      await loadCommits(0, false);
    } catch (err) {
      setRemoteFeedback(err instanceof Error ? err.message : 'Pull failed');
    } finally {
      setRemoteBusy(null);
    }
  };

  const handlePush = async () => {
    setConfirmPush(false);
    setRemoteBusy('push');
    setRemoteFeedback(null);
    try {
      const res = await api.pushRemote(repoId, !status.upstream);
      onStatusUpdated(res.status);
      setRemoteFeedback(res.output);
      await loadCommits(0, false);
      const verified = await api.verifyRemote(repoId);
      setVerifyResult(verified);
    } catch (err) {
      setRemoteFeedback(err instanceof Error ? err.message : 'Push failed');
    } finally {
      setRemoteBusy(null);
    }
  };

  const verifyVerdictStyle = (verdict: RemoteVerifyResult['verdict']) => {
    switch (verdict) {
      case 'synced':
        return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200';
      case 'ahead_unpushed':
      case 'no_remote_branch':
      case 'no_upstream':
        return 'border-amber-500/40 bg-amber-500/10 text-amber-200';
      case 'stale_local_cache':
      case 'behind_remote':
        return 'border-sky-500/40 bg-sky-500/10 text-sky-200';
      default:
        return 'border-rose-500/40 bg-rose-500/10 text-rose-200';
    }
  };

  // Mobile Drilldown Level 3: Diff of a specific file inside a commit
  const showMobileFileDiff = Boolean(selectedCommitSha && selectedFilePath);
  // Mobile Drilldown Level 2: Commit detail & changed files list
  const showMobileCommitDetail = Boolean(selectedCommitSha && !selectedFilePath);

  return (
    <div className="space-y-4 pb-24">
      {/* Remote Sync & Live Verification Card (visible when browsing history or on desktop) */}
      <div
        className={`${
          selectedCommitSha ? 'hidden lg:block' : 'block'
        } rounded-2xl border border-[#30363d] bg-[#161b22] p-3.5`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-[#8b949e]">
                Remote Push Verification
              </span>
              {status.upstream ? (
                <span className="rounded-full bg-[#21262d] px-2.5 py-0.5 font-mono text-[11px] text-sky-300">
                  {status.upstream}
                </span>
              ) : (
                <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] text-amber-300">
                  No upstream set
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-[#8b949e]">
              <span>
                Branch: <strong className="font-mono text-[#e6edf3]">{status.branch}</strong>
              </span>
              {status.ahead > 0 && (
                <span className="font-medium text-amber-300">↑ {status.ahead} unpushed</span>
              )}
              {status.behind > 0 && (
                <span className="font-medium text-sky-300">↓ {status.behind} behind</span>
              )}
              {status.upstream && status.ahead === 0 && status.behind === 0 && (
                <span className="font-medium text-emerald-400">Up to date locally</span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={!status.hasRemote || remoteBusy !== null}
              onClick={() => void handleVerifyLive()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-45"
            >
              <CloudCheck className={`h-3.5 w-3.5 ${remoteBusy === 'verify' ? 'animate-pulse' : ''}`} />
              {remoteBusy === 'verify' ? 'Verifying...' : 'Verify Live'}
            </button>

            <button
              type="button"
              disabled={!status.hasRemote || remoteBusy !== null}
              onClick={() => void handleFetch()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#30363d] bg-[#21262d] px-3 py-2 text-xs font-medium text-[#e6edf3] hover:bg-[#30363d] disabled:opacity-45"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${remoteBusy === 'fetch' ? 'animate-spin' : ''}`} />
              Fetch
            </button>

            {status.behind > 0 && (
              <button
                type="button"
                disabled={remoteBusy !== null}
                onClick={() => void handlePull()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-sky-600 px-3 py-2 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-45"
              >
                <ArrowDownToLine className="h-3.5 w-3.5" />
                Pull ({status.behind})
              </button>
            )}

            {(status.ahead > 0 || (!status.upstream && status.hasRemote && status.headSha)) && (
              <button
                type="button"
                disabled={remoteBusy !== null}
                onClick={() => setConfirmPush(true)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-amber-600 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-45"
              >
                <ArrowUpFromLine className="h-3.5 w-3.5" />
                Push {status.ahead > 0 ? `(${status.ahead})` : ''}
              </button>
            )}
          </div>
        </div>

        {verifyResult && (
          <div className={`mt-3 rounded-xl border p-3 text-xs ${verifyVerdictStyle(verifyResult.verdict)}`}>
            <div className="flex items-start gap-2">
              {verifyResult.verdict === 'synced' ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium">{verifyResult.message}</p>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px] opacity-85">
                  <span>HEAD: {verifyResult.localHeadSha?.slice(0, 7) ?? 'none'}</span>
                  <span>Server: {verifyResult.remoteLiveSha?.slice(0, 7) ?? 'missing'}</span>
                  <span>Checked: {new Date(verifyResult.checkedAt).toLocaleTimeString()}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {remoteFeedback && (
          <p className="mt-2.5 rounded-lg bg-[#0d1117] px-3 py-2 font-mono text-[11px] text-[#8b949e]">
            {remoteFeedback}
          </p>
        )}
      </div>

      {/* Main Split Grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[400px_1fr]">
        {/* Commit List */}
        <div className={`${selectedCommitSha ? 'hidden lg:block' : 'block'} space-y-3`}>
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ['all', `All (${counts.all})`],
                ['pushed', `Pushed (${counts.pushed})`],
                ['unpushed', `Unpushed (${counts.unpushed})`],
                ...(counts.remote_only > 0
                  ? [['remote_only', `Remote (${counts.remote_only})`]]
                  : []),
              ] as Array<['all' | CommitPushState, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                  filter === key
                    ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40'
                    : 'bg-[#161b22] text-[#8b949e] hover:text-[#e6edf3]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {loading && commits.length === 0 ? (
            <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-8 text-center text-sm text-[#8b949e]">
              Loading commit history...
            </div>
          ) : filteredCommits.length === 0 ? (
            <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-8 text-center text-sm text-[#8b949e]">
              No commits matching this filter.
            </div>
          ) : (
            <div className="space-y-2">
              {filteredCommits.map((commit) => {
                const isSelected = commit.sha === selectedCommitSha;
                return (
                  <button
                    key={commit.sha}
                    type="button"
                    onClick={() => setSelectedCommitSha(commit.sha)}
                    className={`w-full rounded-2xl border p-3.5 text-left transition ${
                      isSelected
                        ? 'border-sky-500/60 bg-sky-500/10'
                        : 'border-[#30363d] bg-[#161b22] hover:border-[#484f58]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                          <PushStateBadge
                            state={commit.pushState}
                            remoteRef={commit.pushedToRefs[0]}
                          />
                          <CommitTypeBadge subject={commit.subject} />
                          <span className="font-mono text-[11px] text-[#6e7681]">
                            {commit.shortSha}
                          </span>
                        </div>
                        <div className="line-clamp-2 text-sm font-medium text-[#e6edf3]">
                          {commit.subject}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-[#8b949e]">
                          <span>{commit.authorName}</span>
                          <span>·</span>
                          <span>{commit.relativeDate}</span>
                        </div>
                      </div>
                      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-[#484f58] lg:hidden" />
                    </div>
                  </button>
                );
              })}

              {hasMore && (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void loadCommits(commits.length, true)}
                  className="w-full rounded-xl border border-[#30363d] bg-[#161b22] py-2.5 text-xs font-medium text-[#e6edf3] hover:bg-[#21262d]"
                >
                  {loading ? 'Loading...' : 'Load older commits'}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Commit Detail + Diff Viewer Pane */}
        <div className={`${selectedCommitSha ? 'block' : 'hidden lg:block'} space-y-4`}>
          {!selectedCommitSha ? (
            <div className="hidden min-h-[420px] flex-col items-center justify-center rounded-2xl border border-dashed border-[#30363d] bg-[#161b22]/50 p-8 text-center lg:flex">
              <GitCommitHorizontal className="h-10 w-10 text-[#484f58]" />
              <h3 className="mt-3 text-sm font-medium text-[#e6edf3]">Select a commit</h3>
              <p className="mt-1 max-w-xs text-xs text-[#8b949e]">
                Inspect pushed or local unpushed commits and tap any file to view its mobile-friendly diff.
              </p>
            </div>
          ) : (
            <>
              {/* Commit Header & Changed Files (hidden on mobile when inspecting a file diff) */}
              <div className={showMobileFileDiff ? 'hidden lg:block' : 'block'}>
                {detailLoading && !commitDetail ? (
                  <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-6 text-center text-sm text-[#8b949e]">
                    Loading commit details...
                  </div>
                ) : commitDetail ? (
                  <div className="space-y-3 rounded-2xl border border-[#30363d] bg-[#161b22] p-4">
                    <div className="flex items-start gap-2.5">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedCommitSha(null);
                          setSelectedFilePath(null);
                          setDiff(null);
                        }}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[#30363d] bg-[#21262d] text-[#e6edf3] lg:hidden"
                        aria-label="Back to commits"
                      >
                        <ArrowLeft className="h-4 w-4" />
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <PushStateBadge
                            state={commitDetail.commit.pushState}
                            remoteRef={commitDetail.commit.pushedToRefs[0]}
                          />
                          <CommitTypeBadge subject={commitDetail.commit.subject} />
                          <span className="font-mono text-xs text-[#8b949e]">
                            {commitDetail.commit.shortSha}
                          </span>
                        </div>
                        <h3 className="mt-2 text-base font-semibold text-[#e6edf3]">
                          {commitDetail.commit.subject}
                        </h3>
                        {commitDetail.commit.body && (
                          <pre className="mt-2 whitespace-pre-wrap font-sans text-xs leading-relaxed text-[#8b949e]">
                            {commitDetail.commit.body}
                          </pre>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#8b949e]">
                          <span>{commitDetail.commit.authorName}</span>
                          <span>·</span>
                          <span>{new Date(commitDetail.commit.authoredAt).toLocaleString()}</span>
                        </div>
                      </div>
                    </div>

                    <div className="border-t border-[#30363d] pt-3">
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[#8b949e]">
                        Changed Files ({commitDetail.files.length})
                      </div>
                      <div className="space-y-1.5">
                        {commitDetail.files.map((file) => {
                          const active = selectedFilePath === file.path;
                          return (
                            <button
                              key={file.path}
                              type="button"
                              onClick={() => setSelectedFilePath(file.path)}
                              className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left transition ${
                                active
                                  ? 'border-sky-500/60 bg-sky-500/10'
                                  : 'border-[#30363d]/80 bg-[#0d1117] hover:border-[#484f58]'
                              }`}
                            >
                              <div className="flex min-w-0 flex-1 items-center gap-2">
                                <FileStatusBadge status={file.status} />
                                <span className="truncate font-mono text-xs text-[#e6edf3]">
                                  {file.path}
                                </span>
                              </div>
                              <div className="flex shrink-0 items-center gap-2 font-mono text-[11px]">
                                {!file.isBinary ? (
                                  <>
                                    <span className="text-emerald-400">+{file.additions}</span>
                                    <span className="text-rose-400">-{file.deletions}</span>
                                  </>
                                ) : (
                                  <span className="text-[#8b949e]">BIN</span>
                                )}
                                <ChevronRight className="h-4 w-4 text-[#484f58] lg:hidden" />
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Commit File Diff */}
              <div className={showMobileCommitDetail ? 'hidden lg:block' : 'block'}>
                {selectedFilePath && (
                  <MobileDiffViewer
                    diff={diff}
                    loading={Boolean(selectedFilePath) && diffLoading}
                    error={diffError}
                    contextLines={contextLines}
                    onChangeContextLines={setContextLines}
                    sectionLabel={`Commit ${selectedCommitSha.slice(0, 7)}`}
                    onBack={() => {
                      setSelectedFilePath(null);
                      setDiff(null);
                    }}
                    filePositionLabel={
                      commitDetail && selectedFileIndex >= 0
                        ? `${selectedFileIndex + 1} / ${commitDetail.files.length}`
                        : undefined
                    }
                    onPrevFile={
                      commitDetail && selectedFileIndex > 0
                        ? () => setSelectedFilePath(commitDetail.files[selectedFileIndex - 1].path)
                        : undefined
                    }
                    onNextFile={
                      commitDetail &&
                      selectedFileIndex >= 0 &&
                      selectedFileIndex < commitDetail.files.length - 1
                        ? () => setSelectedFilePath(commitDetail.files[selectedFileIndex + 1].path)
                        : undefined
                    }
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Confirm Push Modal */}
      {confirmPush && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-[#30363d] bg-[#161b22] p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-[#e6edf3]">Push commits to remote?</h3>
            <p className="mt-2 text-xs leading-relaxed text-[#8b949e]">
              Push branch <code className="text-sky-300">{status.branch}</code>{' '}
              {status.upstream ? (
                <>
                  to <code className="text-sky-300">{status.upstream}</code> ({status.ahead} commit(s)).
                </>
              ) : (
                <>and set upstream tracking on remote.</>
              )}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmPush(false)}
                className="rounded-xl border border-[#30363d] bg-[#21262d] px-4 py-2 text-xs font-medium text-[#e6edf3]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handlePush()}
                className="rounded-xl bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-500"
              >
                Push Now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
