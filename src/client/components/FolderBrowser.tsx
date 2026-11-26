import {
  ArrowUp,
  ChevronRight,
  Folder,
  FolderGit2,
  Loader2,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DirectoryBrowseResponse } from '../../shared/types.ts';
import { api } from '../api.ts';

interface FolderBrowserProps {
  initialPath?: string;
  registeredPaths?: string[];
  onSelectPath: (selectedPath: string) => void;
  onClose: () => void;
}

interface BreadcrumbSegment {
  label: string;
  path: string;
}

export function normalizePathKey(rawPath: string): string {
  return rawPath.trim().replace(/[\\/]+$/, '').toLowerCase();
}

export function getParentDirectory(rawPath: string): string | undefined {
  const trimmed = rawPath.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return undefined;
  const lastSep = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (lastSep < 0) return undefined;
  if (lastSep === 0) return '/';
  if (/^[a-zA-Z]:$/.test(trimmed.slice(0, lastSep))) {
    return `${trimmed.slice(0, lastSep)}\\`;
  }
  return trimmed.slice(0, lastSep);
}

function splitPathBreadcrumbs(fullPath: string): BreadcrumbSegment[] {
  const trimmed = fullPath.trim();
  if (!trimmed) return [];

  // Windows UNC path: \\server\share\sub\dir
  const uncMatch = trimmed.match(/^(\\\\[^\\]+\\[^\\]+)(?:\\(.*))?$/);
  if (uncMatch) {
    const root = `${uncMatch[1]}\\`;
    const rest = (uncMatch[2] ?? '').split('\\').filter(Boolean);
    const segments: BreadcrumbSegment[] = [{ label: uncMatch[1], path: root }];
    let acc = uncMatch[1];
    for (const part of rest) {
      acc = `${acc}\\${part}`;
      segments.push({ label: part, path: acc });
    }
    return segments;
  }

  // Windows drive path: C:\Users\name
  const winMatch = trimmed.match(/^([a-zA-Z]:)(?:[\\/](.*))?$/);
  if (winMatch) {
    const drive = `${winMatch[1]}\\`;
    const rest = (winMatch[2] ?? '').split(/[\\/]+/).filter(Boolean);
    const segments: BreadcrumbSegment[] = [{ label: drive, path: drive }];
    let acc = winMatch[1];
    for (const part of rest) {
      acc = `${acc}\\${part}`;
      segments.push({ label: part, path: acc });
    }
    return segments;
  }

  // POSIX path: /home/name/projects
  const rest = trimmed.split('/').filter(Boolean);
  const segments: BreadcrumbSegment[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of rest) {
    acc = `${acc}/${part}`;
    segments.push({ label: part, path: acc });
  }
  return segments;
}

export function FolderBrowser({
  initialPath,
  registeredPaths = [],
  onSelectPath,
  onClose,
}: FolderBrowserProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DirectoryBrowseResponse | null>(null);
  const [folderQuery, setFolderQuery] = useState('');
  const [gitOnly, setGitOnly] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const requestSeqRef = useRef(0);

  const registeredPathSet = useMemo(
    () => new Set(registeredPaths.map((p) => normalizePathKey(p))),
    [registeredPaths],
  );

  const breadcrumbs = useMemo(
    () => (data ? splitPathBreadcrumbs(data.currentPath) : []),
    [data],
  );

  const filteredEntries = useMemo(() => {
    if (!data) return [];
    const q = folderQuery.trim().toLowerCase();
    return data.entries.filter((entry) => {
      if (gitOnly && !entry.isGitRepo) return false;
      if (q && !entry.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, folderQuery, gitOnly]);

  const loadDirectory = async (
    targetPath?: string,
    opts: { nearest?: boolean; hidden?: boolean } = {},
  ) => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    const nextHidden = opts.hidden ?? showHidden;
    setBusy(true);
    setError(null);
    try {
      const next = await api.browseDirectories({
        path: targetPath,
        nearest: opts.nearest,
        showHidden: nextHidden,
      });
      if (requestSeqRef.current !== seq) return;
      setData(next);
      setFolderQuery('');
    } catch (err) {
      if (requestSeqRef.current !== seq) return;
      setError(err instanceof Error ? err.message : 'Unable to open directory');
    } finally {
      if (requestSeqRef.current === seq) {
        setBusy(false);
      }
    }
  };

  useEffect(() => {
    const seed = initialPath?.trim();
    void loadDirectory(seed || undefined, { nearest: Boolean(seed) });
    // Only seed on initial open; user navigation inside drives subsequent loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentIsRegistered = data
    ? registeredPathSet.has(normalizePathKey(data.currentPath))
    : false;

  return (
    <div className="space-y-2.5 rounded-xl border border-[#30363d] bg-[#0d1117] p-3 text-left">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[#e6edf3]">Browse Host Folders</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-[#8b949e] hover:bg-[#21262d] hover:text-white"
          aria-label="Close folder browser"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Quick roots & drives */}
      {data && data.roots.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {data.roots.map((root) => {
            const isCurrentRoot = normalizePathKey(root.path) === normalizePathKey(data.currentPath);
            return (
              <button
                key={root.path}
                type="button"
                disabled={busy}
                onClick={() => void loadDirectory(root.path)}
                className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
                  isCurrentRoot
                    ? 'border-sky-500/50 bg-sky-500/15 text-sky-300'
                    : 'border-[#30363d] bg-[#161b22] text-[#c9d1d9] hover:border-[#484f58] hover:text-white'
                }`}
              >
                {root.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Up button + breadcrumbs */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={!data?.parentPath || busy}
          onClick={() => {
            if (data?.parentPath) {
              void loadDirectory(data.parentPath);
            }
          }}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-[#30363d] bg-[#161b22] px-2 text-xs font-medium text-[#e6edf3] hover:bg-[#21262d] disabled:opacity-40"
          title="Parent folder"
          aria-label="Go to parent folder"
        >
          <ArrowUp className="h-3.5 w-3.5" />
          Up
        </button>

        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-lg border border-[#30363d] bg-[#161b22] px-2 py-1 text-xs">
          {breadcrumbs.length === 0 ? (
            <span className="text-[#8b949e]">Loading...</span>
          ) : (
            breadcrumbs.map((seg, idx) => {
              const isLast = idx === breadcrumbs.length - 1;
              return (
                <div key={seg.path} className="flex shrink-0 items-center gap-0.5">
                  {idx > 0 && <ChevronRight className="h-3 w-3 text-[#484f58]" />}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void loadDirectory(seg.path)}
                    className={`rounded px-1.5 py-0.5 font-mono text-[11px] transition ${
                      isLast
                        ? 'font-semibold text-[#e6edf3]'
                        : 'text-[#8b949e] hover:bg-[#21262d] hover:text-white'
                    }`}
                  >
                    {seg.label}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Current directory selection bar */}
      {data && (
        <div
          className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 ${
            data.currentIsGitRepo
              ? 'border-emerald-500/40 bg-emerald-500/10'
              : 'border-[#30363d] bg-[#161b22]'
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {data.currentIsGitRepo ? (
                <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                  Git Repo
                </span>
              ) : (
                <span className="text-[10px] font-medium text-[#8b949e]">Current Folder</span>
              )}
              {currentIsRegistered && (
                <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">
                  Added
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-[#c9d1d9]">
              {data.currentPath}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onSelectPath(data.currentPath)}
            className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
              data.currentIsGitRepo
                ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                : 'border border-[#30363d] bg-[#21262d] text-[#e6edf3] hover:bg-[#30363d]'
            }`}
          >
            {data.currentIsGitRepo ? 'Select This Repo' : 'Use Folder'}
          </button>
        </div>
      )}

      {/* Search filter + options */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="relative min-w-[140px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#484f58]" />
          <input
            type="text"
            value={folderQuery}
            onChange={(e) => setFolderQuery(e.target.value)}
            placeholder="Filter folders..."
            className="w-full rounded-lg border border-[#30363d] bg-[#161b22] py-1.5 pl-8 pr-7 text-xs text-[#e6edf3] placeholder-[#484f58] focus:border-sky-500 focus:outline-none"
          />
          {folderQuery && (
            <button
              type="button"
              onClick={() => setFolderQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8b949e] hover:text-white"
              aria-label="Clear folder filter"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setGitOnly((prev) => !prev)}
          className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition ${
            gitOnly
              ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
              : 'border-[#30363d] bg-[#161b22] text-[#8b949e] hover:text-[#e6edf3]'
          }`}
        >
          Git only
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const next = !showHidden;
            setShowHidden(next);
            void loadDirectory(data?.currentPath, { hidden: next });
          }}
          className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition ${
            showHidden
              ? 'border-sky-500/50 bg-sky-500/15 text-sky-300'
              : 'border-[#30363d] bg-[#161b22] text-[#8b949e] hover:text-[#e6edf3]'
          }`}
        >
          Hidden
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-2 text-xs text-rose-300">
          {error}
        </div>
      )}

      {/* Subdirectory list */}
      <div className="max-h-56 divide-y divide-[#21262d] overflow-y-auto rounded-lg border border-[#30363d] bg-[#161b22]">
        {busy && !data ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-[#8b949e]">
            <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
            Scanning folders...
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="py-6 text-center text-xs text-[#8b949e]">
            {data?.entries.length === 0
              ? 'No subfolders in this directory.'
              : 'No folders match the current filter.'}
          </div>
        ) : (
          filteredEntries.map((entry) => {
            const isAdded = registeredPathSet.has(normalizePathKey(entry.path));
            if (entry.isGitRepo) {
              return (
                <div
                  key={entry.path}
                  className="flex items-center justify-between gap-2 px-2.5 py-2 hover:bg-[#21262d]/70"
                >
                  <button
                    type="button"
                    onClick={() => onSelectPath(entry.path)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <FolderGit2 className="h-4 w-4 shrink-0 text-emerald-400" />
                    <span className="truncate text-xs font-medium text-[#e6edf3]">
                      {entry.name}
                    </span>
                    <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                      Git
                    </span>
                    {isAdded && (
                      <span className="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">
                        Added
                      </span>
                    )}
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onSelectPath(entry.path)}
                      className="rounded-md bg-emerald-600/20 px-2 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-600/35"
                    >
                      Select
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void loadDirectory(entry.path)}
                      className="rounded-md p-1 text-[#8b949e] hover:bg-[#30363d] hover:text-white"
                      title={`Open inside ${entry.name}`}
                      aria-label={`Open subfolder ${entry.name}`}
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <button
                key={entry.path}
                type="button"
                disabled={busy}
                onClick={() => void loadDirectory(entry.path)}
                className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left hover:bg-[#21262d]/70 disabled:opacity-60"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Folder className="h-4 w-4 shrink-0 text-[#8b949e]" />
                  <span className="truncate text-xs text-[#e6edf3]">{entry.name}</span>
                </div>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#484f58]" />
              </button>
            );
          })
        )}
      </div>

      {data?.truncated && (
        <p className="text-[11px] text-[#8b949e]">
          Showing first 400 subfolders. Use the filter box or navigate closer to your project folder.
        </p>
      )}
    </div>
  );
}
