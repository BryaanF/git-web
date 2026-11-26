import { FolderGit2, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { RepoEntry } from '../../shared/types.ts';

interface RepoModalProps {
  open: boolean;
  repos: RepoEntry[];
  activeRepoId: string | null;
  onSelect: (id: string) => void;
  onAdd: (path: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onClose: () => void;
}

export function RepoModal({
  open,
  repos,
  activeRepoId,
  onSelect,
  onAdd,
  onRemove,
  onClose,
}: RepoModalProps) {
  const [newPath, setNewPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(newPath.trim());
      setNewPath('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add repository');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 sm:items-center sm:p-4">
      <div className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-[#30363d] bg-[#161b22] p-5 shadow-2xl sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
              <FolderGit2 className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-[#e6edf3]">Repositories</h2>
              <p className="text-xs text-[#8b949e]">Switch or register local Git repositories</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-[#8b949e] hover:bg-[#30363d]/50 hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="mb-4 space-y-2">
          <label className="block text-xs font-medium text-[#8b949e]">
            Add Local Repository Path (Windows or POSIX)
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="C:\Users\name\projects\my-app"
              className="min-w-0 flex-1 rounded-xl border border-[#30363d] bg-[#0d1117] px-3 py-2.5 text-sm text-[#e6edf3] placeholder-[#484f58] focus:border-sky-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || !newPath.trim()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              Add
            </button>
          </div>
          {error && <p className="text-xs text-rose-400">{error}</p>}
        </form>

        <div className="space-y-2">
          {repos.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#30363d] p-6 text-center text-sm text-[#8b949e]">
              No repositories registered yet. Paste a local folder containing a <code>.git</code> directory above.
            </div>
          ) : (
            repos.map((repo) => {
              const active = repo.id === activeRepoId;
              return (
                <div
                  key={repo.id}
                  className={`flex items-center justify-between gap-2 rounded-xl border px-3.5 py-3 transition ${
                    active
                      ? 'border-sky-500/60 bg-sky-500/10'
                      : 'border-[#30363d] bg-[#0d1117] hover:border-[#484f58]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(repo.id);
                      onClose();
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-[#e6edf3]">
                        {repo.name}
                      </span>
                      {active && (
                        <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-[10px] font-semibold text-sky-300">
                          Active
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-[#8b949e]">
                      {repo.path}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => void onRemove(repo.id)}
                    className="rounded-lg p-2 text-[#8b949e] hover:bg-rose-500/15 hover:text-rose-400"
                    aria-label={`Remove ${repo.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
