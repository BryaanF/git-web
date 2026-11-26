import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  DirectoryBrowseEntry,
  DirectoryBrowseResponse,
  DirectoryQuickRoot,
} from '../../shared/types.ts';

const MAX_BROWSE_ENTRIES = 400;
const DRIVE_PROBE_TIMEOUT_MS = 250;
const GIT_CHECK_CONCURRENCY = 24;
const WINDOWS_SYSTEM_NOISE = new Set([
  '$recycle.bin',
  'system volume information',
  'recovery',
]);

async function isExistingDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function isExistingDirectoryWithTimeout(dirPath: string, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race<boolean>([
      isExistingDirectory(dirPath),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function hasGitMarker(dirPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(dirPath, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      results[idx] = await worker(items[idx]);
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

export async function getDirectoryQuickRoots(workspaceHint?: string): Promise<DirectoryQuickRoot[]> {
  const roots: DirectoryQuickRoot[] = [];
  const seen = new Set<string>();

  const pushIfDir = async (label: string, candidate: string, timeout = false) => {
    const resolved = path.resolve(candidate);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    const ok = timeout
      ? await isExistingDirectoryWithTimeout(resolved, DRIVE_PROBE_TIMEOUT_MS)
      : await isExistingDirectory(resolved);
    if (!ok) return;
    seen.add(key);
    roots.push({ label, path: resolved });
  };

  const homeDir = os.homedir();
  const baseCwd = workspaceHint ? path.resolve(workspaceHint) : process.cwd();
  const cwdParent = path.dirname(baseCwd);

  await pushIfDir('Home', homeDir);
  if (cwdParent && cwdParent !== baseCwd) {
    await pushIfDir('Workspace', cwdParent);
  }

  const commonNames = ['Projects', 'projects', 'Dev', 'Code', 'Repositories', 'Desktop', 'Documents'];
  const commonChecks = await Promise.all(
    commonNames.map(async (name) => {
      const candidate = path.join(homeDir, name);
      return (await isExistingDirectory(candidate)) ? { label: name, path: candidate } : null;
    }),
  );
  for (const item of commonChecks) {
    if (item) {
      await pushIfDir(item.label, item.path);
    }
  }

  if (process.platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const drives = await Promise.all(
      letters.map(async (letter) => {
        const driveRoot = `${letter}:\\`;
        const ok = await isExistingDirectoryWithTimeout(driveRoot, DRIVE_PROBE_TIMEOUT_MS);
        return ok ? { label: `${letter}:`, path: driveRoot } : null;
      }),
    );
    for (const drive of drives) {
      if (drive) {
        const key = drive.path.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          roots.push(drive);
        }
      }
    }
  } else {
    await pushIfDir('/', '/');
  }

  return roots;
}

function expandRequestedPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const home = os.homedir();
  if (trimmed === '~') {
    return home;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(home, trimmed.slice(2));
  }
  if (process.platform === 'win32' && /^[a-zA-Z]:$/.test(trimmed)) {
    return `${trimmed}\\`;
  }
  return trimmed;
}

async function resolveTargetDirectory(
  requestedPath: string | undefined,
  options: { nearest?: boolean; defaultDir?: string },
): Promise<string> {
  const fallbackDefault = path.resolve(options.defaultDir || os.homedir() || process.cwd());
  if (!requestedPath || !requestedPath.trim()) {
    return (await isExistingDirectory(fallbackDefault)) ? fallbackDefault : path.resolve(process.cwd());
  }

  const expanded = path.resolve(expandRequestedPath(requestedPath));
  if (await isExistingDirectory(expanded)) {
    return expanded;
  }

  if (!options.nearest) {
    throw new Error(`Directory not found: ${expanded}`);
  }

  // Walk upward to the closest existing parent directory when seeding from partial/stale input.
  let current = expanded;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    if (await isExistingDirectory(current)) {
      return current;
    }
  }

  return (await isExistingDirectory(fallbackDefault)) ? fallbackDefault : path.resolve(process.cwd());
}

export interface BrowseDirectoriesOptions {
  showHidden?: boolean;
  nearest?: boolean;
  defaultDir?: string;
}

export async function browseDirectories(
  requestedPath?: string,
  options: BrowseDirectoriesOptions = {},
): Promise<DirectoryBrowseResponse> {
  const target = await resolveTargetDirectory(requestedPath, options);
  const dirents = await fs.readdir(target, { withFileTypes: true });
  const showHidden = Boolean(options.showHidden);

  const visibleDirNames: string[] = [];
  const symlinkCandidates: string[] = [];

  for (const dirent of dirents) {
    const name = dirent.name;
    if (name === '.git') continue;
    if (!showHidden && name.startsWith('.')) continue;
    if (process.platform === 'win32' && WINDOWS_SYSTEM_NOISE.has(name.toLowerCase())) continue;

    if (dirent.isDirectory()) {
      visibleDirNames.push(name);
    } else if (dirent.isSymbolicLink()) {
      symlinkCandidates.push(name);
    }
  }

  if (symlinkCandidates.length > 0) {
    const validSymlinks = await mapWithConcurrency(symlinkCandidates, GIT_CHECK_CONCURRENCY, async (name) => {
      const ok = await isExistingDirectory(path.join(target, name));
      return ok ? name : null;
    });
    for (const name of validSymlinks) {
      if (name) visibleDirNames.push(name);
    }
  }

  visibleDirNames.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  const truncated = visibleDirNames.length > MAX_BROWSE_ENTRIES;
  const slicedNames = truncated ? visibleDirNames.slice(0, MAX_BROWSE_ENTRIES) : visibleDirNames;

  const [currentIsGitRepo, gitFlags, roots] = await Promise.all([
    hasGitMarker(target),
    mapWithConcurrency(slicedNames, GIT_CHECK_CONCURRENCY, (name) => hasGitMarker(path.join(target, name))),
    getDirectoryQuickRoots(options.defaultDir),
  ]);

  const entries: DirectoryBrowseEntry[] = slicedNames.map((name, idx) => ({
    name,
    path: path.join(target, name),
    isGitRepo: Boolean(gitFlags[idx]),
  }));

  const parent = path.dirname(target);
  return {
    currentPath: target,
    parentPath: parent === target ? null : parent,
    currentIsGitRepo,
    entries,
    roots,
    truncated: truncated || undefined,
  };
}
