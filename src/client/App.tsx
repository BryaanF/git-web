import {
  ChevronDown,
  FileDiff,
  FolderGit2,
  FolderSearch,
  GitBranch,
  History,
  KeyRound,
  QrCode,
  RefreshCw,
} from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type {
  BranchItem,
  RepoEntry,
  RepoStatusSummary,
  ServerNetworkInfo,
} from '../shared/types.ts';
import {
  ApiAuthError,
  api,
  bootstrapTokenFromUrl,
  setStoredToken,
} from './api.ts';
import { ChangesTab } from './components/ChangesTab.tsx';

const HistoryTab = lazy(() =>
  import('./components/HistoryTab.tsx').then((m) => ({ default: m.HistoryTab })),
);
const BranchesTab = lazy(() =>
  import('./components/BranchesTab.tsx').then((m) => ({ default: m.BranchesTab })),
);
const RepoModal = lazy(() =>
  import('./components/RepoModal.tsx').then((m) => ({ default: m.RepoModal })),
);
const ConnectModal = lazy(() =>
  import('./components/ConnectModal.tsx').then((m) => ({ default: m.ConnectModal })),
);
const FolderBrowser = lazy(() =>
  import('./components/FolderBrowser.tsx').then((m) => ({ default: m.FolderBrowser })),
);

type TabKey = 'changes' | 'history' | 'branches';

export function App() {
  const [authNeeded, setAuthNeeded] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [activeRepoId, setActiveRepoId] = useState<string | null>(() =>
    localStorage.getItem('gitdock_active_repo'),
  );
  const [status, setStatus] = useState<RepoStatusSummary | null>(null);
  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);

  const [tab, setTab] = useState<TabKey>('changes');
  const [refreshTick, setRefreshTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [repoModalOpen, setRepoModalOpen] = useState(false);
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [networkInfo, setNetworkInfo] = useState<ServerNetworkInfo | null>(null);
  const [sseConnected, setSseConnected] = useState(false);

  const [quickRepoPath, setQuickRepoPath] = useState('');
  const [quickBrowseOpen, setQuickBrowseOpen] = useState(false);
  const sseCooldownUntilRef = useRef<number>(0);

  const handleStatusUpdated = useCallback((nextStatus: RepoStatusSummary) => {
    sseCooldownUntilRef.current = Date.now() + 900;
    setStatus(nextStatus);
  }, []);

  const loadReposAndStatus = useCallback(async (preferredId?: string | null) => {
    setError(null);
    try {
      const repoRes = await api.listRepos();
      setRepos(repoRes.repos);

      const candidateId = preferredId ?? localStorage.getItem('gitdock_active_repo');
      const matched = repoRes.repos.find((r) => r.id === candidateId) ?? repoRes.repos[0] ?? null;

      if (!matched) {
        setActiveRepoId(null);
        setStatus(null);
        return;
      }

      setActiveRepoId(matched.id);
      localStorage.setItem('gitdock_active_repo', matched.id);
      const nextStatus = await api.getStatus(matched.id);
      setStatus(nextStatus);
      setAuthNeeded(false);
    } catch (err) {
      if (err instanceof ApiAuthError) {
        setAuthNeeded(true);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load repository state');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      const urlOrStored = bootstrapTokenFromUrl();
      if (urlOrStored) {
        try {
          await api.pair(urlOrStored);
        } catch {
          // Will fall through to auth screen if rejected
        }
      }
      await loadReposAndStatus();
    };
    void init();
  }, [loadReposAndStatus]);

  const refreshActiveRepo = useCallback(async () => {
    if (!activeRepoId) return;
    sseCooldownUntilRef.current = Date.now() + 900;
    setRefreshing(true);
    try {
      const nextStatus = await api.getStatus(activeRepoId);
      setStatus(nextStatus);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      if (err instanceof ApiAuthError) {
        setAuthNeeded(true);
      } else {
        setError(err instanceof Error ? err.message : 'Refresh failed');
      }
    } finally {
      setRefreshing(false);
    }
  }, [activeRepoId]);

  const loadBranches = useCallback(async () => {
    if (!activeRepoId) return;
    setBranchesLoading(true);
    try {
      const res = await api.listBranches(activeRepoId);
      setBranches(res.branches);
    } catch {
      // Handled silently or by status
    } finally {
      setBranchesLoading(false);
    }
  }, [activeRepoId]);

  useEffect(() => {
    if (tab === 'branches' && activeRepoId) {
      void loadBranches();
    }
  }, [tab, activeRepoId, loadBranches, refreshTick]);

  // Live SSE updates when files or git refs change on PC
  useEffect(() => {
    if (!activeRepoId || authNeeded) return;
    const url = `/api/repos/${encodeURIComponent(activeRepoId)}/events`;

    let inflight = false;
    const es = new EventSource(url, { withCredentials: true });
    es.addEventListener('connected', () => setSseConnected(true));
    es.addEventListener('repo-changed', () => {
      if (inflight || sseCooldownUntilRef.current > Date.now()) return;
      inflight = true;
      void api
        .getStatus(activeRepoId)
        .then((next) => {
          setStatus(next);
          setRefreshTick((t) => t + 1);
        })
        .catch(() => {})
        .finally(() => {
          inflight = false;
        });
    });
    es.onerror = () => setSseConnected(false);

    return () => {
      setSseConnected(false);
      es.close();
    };
  }, [activeRepoId, authNeeded]);

  const openConnectModal = async () => {
    setConnectModalOpen(true);
    try {
      const info = await api.getNetworkInfo();
      setNetworkInfo(info);
    } catch {
      // Ignore if offline
    }
  };

  const handlePairSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    try {
      await api.pair(tokenInput.trim());
      setStoredToken(tokenInput.trim());
      setAuthNeeded(false);
      setLoading(true);
      await loadReposAndStatus();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Invalid pairing token');
    }
  };

  const handleSelectRepo = async (id: string) => {
    setActiveRepoId(id);
    localStorage.setItem('gitdock_active_repo', id);
    setRefreshing(true);
    try {
      const next = await api.getStatus(id);
      setStatus(next);
      setRefreshTick((t) => t + 1);
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddRepo = async (repoPath: string) => {
    const res = await api.addRepo(repoPath);
    await loadReposAndStatus(res.repo.id);
  };

  const handleRemoveRepo = async (id: string) => {
    await api.removeRepo(id);
    await loadReposAndStatus(id === activeRepoId ? null : activeRepoId);
  };

  if (authNeeded) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#0d1117] p-4">
        <form
          onSubmit={(e) => void handlePairSubmit(e)}
          className="w-full max-w-sm space-y-4 rounded-2xl border border-[#30363d] bg-[#161b22] p-6 shadow-2xl"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-500/15 text-sky-400">
              <KeyRound className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-[#e6edf3]">Pair Device</h1>
              <p className="text-xs text-[#8b949e]">
                Scan the QR code from your PC or enter the pairing token
              </p>
            </div>
          </div>
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Paste pairing token"
            className="w-full rounded-xl border border-[#30363d] bg-[#0d1117] px-3.5 py-2.5 text-sm text-[#e6edf3] placeholder-[#484f58] focus:border-sky-500 focus:outline-none"
          />
          {authError && <p className="text-xs text-rose-400">{authError}</p>}
          <button
            type="submit"
            disabled={!tokenInput.trim()}
            className="w-full rounded-xl bg-sky-600 py-2.5 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
          >
            Unlock GitDock Web
          </button>
        </form>
      </div>
    );
  }

  const workingCount = status
    ? status.unstaged.length + status.staged.length + status.conflicted.length
    : 0;

  return (
    <div className="min-h-dvh bg-[#0d1117] text-[#e6edf3]">
      {/* Top App Bar */}
      <header className="safe-top sticky top-0 z-30 border-b border-[#30363d] bg-[#0d1117]/95 backdrop-blur">
        <div className="mx-auto flex h-[52px] max-w-7xl items-center justify-between gap-2 px-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setRepoModalOpen(true)}
              className="flex min-w-0 items-center gap-2 rounded-xl border border-[#30363d] bg-[#161b22] px-2.5 py-1.5 text-left hover:border-[#484f58] active:scale-[0.99]"
            >
              <FolderGit2 className="h-4 w-4 shrink-0 text-sky-400" />
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-[#e6edf3] sm:text-sm">
                  {status?.repo.name ?? 'Select Repo'}
                </div>
              </div>
              {status && (
                <span className="hidden rounded-md bg-[#21262d] px-1.5 py-0.5 font-mono text-[11px] text-[#8b949e] sm:inline-block">
                  {status.branch}
                </span>
              )}
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#8b949e]" />
            </button>

            {status && (
              <div className="flex items-center gap-1 text-[11px] font-medium">
                <span className="rounded-md bg-[#161b22] px-2 py-1 font-mono text-[#8b949e] sm:hidden">
                  {status.branch}
                </span>
                {status.ahead > 0 && (
                  <span className="rounded-md bg-amber-500/15 px-1.5 py-1 text-amber-300">
                    ↑{status.ahead}
                  </span>
                )}
                {status.behind > 0 && (
                  <span className="rounded-md bg-sky-500/15 px-1.5 py-1 text-sky-300">
                    ↓{status.behind}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Desktop Center Navigation */}
          {status && (
            <nav className="hidden items-center gap-1 rounded-xl border border-[#30363d] bg-[#161b22] p-1 md:flex">
              <button
                type="button"
                onClick={() => setTab('changes')}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium transition ${
                  tab === 'changes'
                    ? 'bg-[#21262d] text-white'
                    : 'text-[#8b949e] hover:text-[#e6edf3]'
                }`}
              >
                <FileDiff className="h-3.5 w-3.5" />
                Changes
                {workingCount > 0 && (
                  <span className="rounded-full bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-300">
                    {workingCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setTab('history')}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium transition ${
                  tab === 'history'
                    ? 'bg-[#21262d] text-white'
                    : 'text-[#8b949e] hover:text-[#e6edf3]'
                }`}
              >
                <History className="h-3.5 w-3.5" />
                History &amp; Pushed
                {status.ahead > 0 && (
                  <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">
                    ↑{status.ahead}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setTab('branches')}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium transition ${
                  tab === 'branches'
                    ? 'bg-[#21262d] text-white'
                    : 'text-[#8b949e] hover:text-[#e6edf3]'
                }`}
              >
                <GitBranch className="h-3.5 w-3.5" />
                Branches
              </button>
            </nav>
          )}

          {/* Right Controls */}
          <div className="flex shrink-0 items-center gap-1.5">
            <span
              title={sseConnected ? 'Live filesystem watch active' : 'Manual refresh mode'}
              className={`hidden h-2 w-2 rounded-full sm:inline-block ${
                sseConnected ? 'bg-emerald-400' : 'bg-zinc-600'
              }`}
            />
            <button
              type="button"
              onClick={() => void refreshActiveRepo()}
              disabled={refreshing || !activeRepoId}
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-[#30363d] bg-[#161b22] text-[#e6edf3] hover:bg-[#21262d] disabled:opacity-45"
              title="Refresh repository"
              aria-label="Refresh repository"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => void openConnectModal()}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-sky-500/35 bg-sky-500/10 px-2.5 text-xs font-medium text-sky-300 hover:bg-sky-500/20"
            >
              <QrCode className="h-4 w-4" />
              <span className="hidden sm:inline">Phone QR</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl px-3 pt-4 sm:px-5">
        {error && (
          <div className="mb-4 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex min-h-[50dvh] flex-col items-center justify-center">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
            <p className="mt-3 text-sm text-[#8b949e]">Scanning local repositories...</p>
          </div>
        ) : !status ? (
          <div className="mx-auto mt-8 max-w-lg rounded-2xl border border-[#30363d] bg-[#161b22] p-6 text-center">
            <FolderGit2 className="mx-auto h-10 w-10 text-sky-400" />
            <h2 className="mt-3 text-base font-semibold text-[#e6edf3]">
              Add your first Git repository
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-[#8b949e]">
              Click <strong>Browse</strong> or paste the local path of any project containing a <code>.git</code> folder to start viewing unstaged, staged, and pushed diffs from your phone.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (quickRepoPath.trim()) {
                  setQuickBrowseOpen(false);
                  void handleAddRepo(quickRepoPath.trim());
                }
              }}
              className="mt-4 flex flex-col gap-2 sm:flex-row"
            >
              <input
                type="text"
                value={quickRepoPath}
                onChange={(e) => setQuickRepoPath(e.target.value)}
                placeholder="e.g. ~/projects/my-repo or C:\projects\my-repo"
                className="min-w-0 flex-1 rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-[#e6edf3] placeholder-[#484f58] focus:border-sky-500 focus:outline-none"
              />
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => setQuickBrowseOpen((prev) => !prev)}
                  aria-expanded={quickBrowseOpen}
                  className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-3.5 py-2.5 text-sm font-medium transition sm:flex-none ${
                    quickBrowseOpen
                      ? 'border-sky-500/60 bg-sky-500/15 text-sky-300'
                      : 'border-[#30363d] bg-[#21262d] text-[#e6edf3] hover:border-[#484f58] hover:bg-[#30363d]/70'
                  }`}
                >
                  <FolderSearch className="h-4 w-4" />
                  Browse
                </button>
                <button
                  type="submit"
                  disabled={!quickRepoPath.trim()}
                  className="flex-1 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50 sm:flex-none"
                >
                  Open Repo
                </button>
              </div>
            </form>
            {quickBrowseOpen && (
              <div className="mt-4">
                <Suspense fallback={null}>
                  <FolderBrowser
                    initialPath={quickRepoPath.trim() || undefined}
                    registeredPaths={repos.map((r) => r.path)}
                    onSelectPath={(selectedPath) => {
                      setQuickRepoPath(selectedPath);
                      setQuickBrowseOpen(false);
                    }}
                    onClose={() => setQuickBrowseOpen(false)}
                  />
                </Suspense>
              </div>
            )}
          </div>
        ) : (
          <>
            {tab === 'changes' && (
              <ChangesTab
                repoId={status.repo.id}
                status={status}
                refreshTick={refreshTick}
                onStatusUpdated={handleStatusUpdated}
                onCommitted={() => setRefreshTick((t) => t + 1)}
              />
            )}
            {tab === 'history' && (
              <Suspense
                fallback={
                  <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-8 text-center text-sm text-[#8b949e]">
                    Loading history...
                  </div>
                }
              >
                <HistoryTab
                  repoId={status.repo.id}
                  status={status}
                  refreshTick={refreshTick}
                  onStatusUpdated={handleStatusUpdated}
                />
              </Suspense>
            )}
            {tab === 'branches' && (
              <Suspense
                fallback={
                  <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-8 text-center text-sm text-[#8b949e]">
                    Loading branches...
                  </div>
                }
              >
                <BranchesTab
                  branches={branches}
                  loading={branchesLoading}
                  onRefresh={() => void loadBranches()}
                  onCheckout={async (branch, create) => {
                    const res = await api.checkoutBranch(status.repo.id, branch, create);
                    setStatus(res.status);
                    setRefreshTick((t) => t + 1);
                    await loadBranches();
                  }}
                />
              </Suspense>
            )}
          </>
        )}
      </main>

      {/* Mobile Bottom Navigation */}
      {status && (
        <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-[#30363d] bg-[#0d1117]/95 backdrop-blur md:hidden">
          <div className="grid grid-cols-3">
            <button
              type="button"
              onClick={() => setTab('changes')}
              className={`flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium ${
                tab === 'changes' ? 'text-sky-400' : 'text-[#8b949e]'
              }`}
            >
              <div className="relative">
                <FileDiff className="h-5 w-5" />
                {workingCount > 0 && (
                  <span className="absolute -right-2.5 -top-1 rounded-full bg-sky-500 px-1 text-[9px] font-bold text-white">
                    {workingCount}
                  </span>
                )}
              </div>
              <span>Changes</span>
            </button>

            <button
              type="button"
              onClick={() => setTab('history')}
              className={`flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium ${
                tab === 'history' ? 'text-sky-400' : 'text-[#8b949e]'
              }`}
            >
              <div className="relative">
                <History className="h-5 w-5" />
                {status.ahead > 0 && (
                  <span className="absolute -right-2.5 -top-1 rounded-full bg-amber-500 px-1 text-[9px] font-bold text-black">
                    {status.ahead}
                  </span>
                )}
              </div>
              <span>History</span>
            </button>

            <button
              type="button"
              onClick={() => setTab('branches')}
              className={`flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium ${
                tab === 'branches' ? 'text-sky-400' : 'text-[#8b949e]'
              }`}
            >
              <GitBranch className="h-5 w-5" />
              <span>Branches</span>
            </button>
          </div>
        </nav>
      )}

      {repoModalOpen && (
        <Suspense fallback={null}>
          <RepoModal
            open={repoModalOpen}
            repos={repos}
            activeRepoId={activeRepoId}
            onSelect={(id) => void handleSelectRepo(id)}
            onAdd={handleAddRepo}
            onRemove={handleRemoveRepo}
            onClose={() => setRepoModalOpen(false)}
          />
        </Suspense>
      )}

      {connectModalOpen && (
        <Suspense fallback={null}>
          <ConnectModal
            open={connectModalOpen}
            network={networkInfo}
            onClose={() => setConnectModalOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
