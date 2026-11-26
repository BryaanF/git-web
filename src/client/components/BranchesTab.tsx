import { Check, GitBranch, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { BranchItem } from '../../shared/types.ts';

interface BranchesTabProps {
  branches: BranchItem[];
  loading: boolean;
  onRefresh: () => void;
  onCheckout: (branch: string, create: boolean) => Promise<void>;
}

export function BranchesTab({ branches, loading, onRefresh, onCheckout }: BranchesTabProps) {
  const [newBranch, setNewBranch] = useState('');
  const [busyBranch, setBusyBranch] = useState<string | null>(null);
  const [filter, setFilter] = useState<'local' | 'remote'>('local');
  const [error, setError] = useState<string | null>(null);

  const filtered = branches.filter((b) => (filter === 'remote' ? b.isRemote : !b.isRemote));

  const handleCheckout = async (shortName: string, create = false) => {
    setBusyBranch(shortName);
    setError(null);
    try {
      await onCheckout(shortName, create);
      if (create) setNewBranch('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    } finally {
      setBusyBranch(null);
    }
  };

  return (
    <div className="space-y-4 pb-24">
      <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[#e6edf3]">Create &amp; Switch Branch</h3>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#30363d] bg-[#21262d] px-2.5 py-1.5 text-xs text-[#e6edf3] hover:bg-[#30363d] disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (newBranch.trim()) void handleCheckout(newBranch.trim(), true);
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            placeholder="feature/new-branch"
            className="min-w-0 flex-1 rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm text-[#e6edf3] placeholder-[#484f58] focus:border-sky-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!newBranch.trim() || busyBranch !== null}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Create
          </button>
        </form>

        {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setFilter('local')}
          className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
            filter === 'local'
              ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40'
              : 'bg-[#161b22] text-[#8b949e] hover:text-[#e6edf3]'
          }`}
        >
          Local ({branches.filter((b) => !b.isRemote).length})
        </button>
        <button
          type="button"
          onClick={() => setFilter('remote')}
          className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
            filter === 'remote'
              ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40'
              : 'bg-[#161b22] text-[#8b949e] hover:text-[#e6edf3]'
          }`}
        >
          Remote Tracking ({branches.filter((b) => b.isRemote).length})
        </button>
      </div>

      <div className="space-y-2">
        {filtered.map((branch) => (
          <div
            key={branch.name}
            className={`flex items-center justify-between gap-3 rounded-xl border p-3.5 ${
              branch.isCurrent
                ? 'border-emerald-500/40 bg-emerald-500/5'
                : 'border-[#30363d] bg-[#161b22]'
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <GitBranch
                  className={`h-4 w-4 shrink-0 ${
                    branch.isCurrent ? 'text-emerald-400' : 'text-[#8b949e]'
                  }`}
                />
                <span className="truncate font-mono text-sm font-semibold text-[#e6edf3]">
                  {branch.shortName}
                </span>
                {branch.isCurrent && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                    <Check className="h-3 w-3" /> Current
                  </span>
                )}
                {typeof branch.ahead === 'number' && branch.ahead > 0 && (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                    ↑ {branch.ahead} unpushed
                  </span>
                )}
                {typeof branch.behind === 'number' && branch.behind > 0 && (
                  <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-300">
                    ↓ {branch.behind} behind
                  </span>
                )}
              </div>
              <div className="mt-1 truncate text-xs text-[#8b949e]">
                <span className="font-mono text-[#6e7681]">{branch.lastCommitSha}</span> ·{' '}
                {branch.lastCommitSubject || 'No commits'} · {branch.lastCommitDate}
              </div>
            </div>

            {!branch.isCurrent && !branch.isRemote && (
              <button
                type="button"
                disabled={busyBranch !== null}
                onClick={() => void handleCheckout(branch.shortName, false)}
                className="shrink-0 rounded-xl border border-[#30363d] bg-[#21262d] px-3 py-2 text-xs font-medium text-[#e6edf3] hover:bg-[#30363d] disabled:opacity-50"
              >
                {busyBranch === branch.shortName ? 'Switching...' : 'Checkout'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
