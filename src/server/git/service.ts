import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  BranchItem,
  CommitDetail,
  CommitHistoryResponse,
  CommitPushState,
  CommitSummary,
  DiffPayload,
  FileChangeStatus,
  RemoteVerifyResult,
  RepoEntry,
  RepoStatusSummary,
} from '../../shared/types.ts';
import {
  buildUntrackedUnifiedPatch,
  inferLanguageFromPath,
  parseCommitFilesOutput,
  parseStatusPorcelainV2Z,
  parseUnifiedPatch,
} from './parsers.ts';
import { GitCommandError, runGit } from './runner.ts';

const MAX_READ_BYTES = 512 * 1024;
const MAX_CONTENT_BYTES = 180 * 1024;

export function assertSafeRepoPath(repoRoot: string, filePath: string): string {
  const normalizedRoot = path.resolve(repoRoot);
  const resolvedTarget = path.resolve(normalizedRoot, filePath);
  const relative = path.relative(normalizedRoot, resolvedTarget);

  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes('.git')
  ) {
    throw new Error(`Invalid repository file path: ${filePath}`);
  }
  return resolvedTarget;
}

function toGitSlashPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function looksBinary(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

async function readGitBlob(repoPath: string, spec: string): Promise<string | undefined> {
  const res = await runGit(repoPath, ['cat-file', '-s', spec], { allowNonZeroExit: true });
  if (res.exitCode !== 0) return undefined;
  const size = Number.parseInt(res.stdout.trim(), 10);
  if (!Number.isFinite(size) || size > MAX_CONTENT_BYTES) return undefined;

  const contentRes = await runGit(repoPath, ['show', spec], { allowNonZeroExit: true });
  if (contentRes.exitCode !== 0) return undefined;
  if (contentRes.stdout.includes('\0')) return undefined;
  return contentRes.stdout;
}

async function readWorktreeText(repoPath: string, filePath: string): Promise<{ text?: string; isBinary: boolean; isTooLarge: boolean }> {
  const absPath = assertSafeRepoPath(repoPath, filePath);
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      return { isBinary: false, isTooLarge: false };
    }
    if (stat.size > MAX_READ_BYTES) {
      return { isBinary: false, isTooLarge: true };
    }
    const buf = await fs.readFile(absPath);
    if (looksBinary(buf)) {
      return { isBinary: true, isTooLarge: false };
    }
    return { text: buf.toString('utf8'), isBinary: false, isTooLarge: false };
  } catch {
    return { isBinary: false, isTooLarge: false };
  }
}

export async function validateGitRepo(candidatePath: string): Promise<{ rootPath: string; name: string; remoteUrl?: string }> {
  const resolved = path.resolve(candidatePath);
  const topRes = await runGit(resolved, ['rev-parse', '--show-toplevel']);
  const rootPath = path.resolve(topRes.stdout.trim());
  const remoteRes = await runGit(rootPath, ['remote', 'get-url', 'origin'], { allowNonZeroExit: true });
  return {
    rootPath,
    name: path.basename(rootPath) || rootPath,
    remoteUrl: remoteRes.exitCode === 0 ? remoteRes.stdout.trim() : undefined,
  };
}

export async function getRepoStatus(repo: RepoEntry): Promise<RepoStatusSummary> {
  const [statusRes, remotesRes] = await Promise.all([
    runGit(repo.path, ['status', '--porcelain=v2', '--branch', '-z']),
    runGit(repo.path, ['remote']),
  ]);

  const parsed = parseStatusPorcelainV2Z(statusRes.stdout);
  const remotes = remotesRes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const remoteName = parsed.upstream ? parsed.upstream.split('/')[0] : (remotes[0] ?? null);

  return {
    repo,
    branch: parsed.branch,
    headSha: parsed.headSha,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    isDetached: parsed.isDetached,
    hasRemote: remotes.length > 0,
    remoteName,
    unstaged: parsed.unstaged,
    staged: parsed.staged,
    conflicted: parsed.conflicted,
    lastRefreshedAt: new Date().toISOString(),
  };
}

export async function getWorkingFileDiff(
  repoPath: string,
  filePath: string,
  section: 'unstaged' | 'staged' | 'conflicted',
  contextLines = 3,
): Promise<DiffPayload> {
  assertSafeRepoPath(repoPath, filePath);
  const gitPath = toGitSlashPath(filePath);
  const lang = inferLanguageFromPath(gitPath);
  const ctx = Math.max(0, Math.min(contextLines, 50));

  if (section === 'staged') {
    const diffRes = await runGit(repoPath, [
      'diff',
      '--staged',
      '--no-color',
      '-M',
      `--unified=${ctx}`,
      '--',
      gitPath,
    ]);
    const parsed = parseUnifiedPatch(diffRes.stdout);
    const [oldContent, newContent] = parsed.isBinary
      ? [undefined, undefined]
      : await Promise.all([
          readGitBlob(repoPath, `HEAD:${gitPath}`),
          readGitBlob(repoPath, `:${gitPath}`),
        ]);

    let status: FileChangeStatus = 'modified';
    if (diffRes.stdout.includes('\nnew file mode ')) status = 'added';
    else if (diffRes.stdout.includes('\ndeleted file mode ')) status = 'deleted';
    else if (diffRes.stdout.includes('\nrename from ')) status = 'renamed';

    return {
      path: gitPath,
      patch: diffRes.stdout,
      hunks: parsed.hunks,
      oldContent,
      newContent,
      lang,
      isBinary: parsed.isBinary,
      isTooLarge: parsed.lineCount > 4500,
      lineCount: parsed.lineCount,
      additions: parsed.additions,
      deletions: parsed.deletions,
      status,
    };
  }

  // Check if file is untracked
  const untrackedCheck = await runGit(repoPath, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    gitPath,
  ]);
  const isUntracked = untrackedCheck.stdout.trim().length > 0;

  if (isUntracked) {
    const disk = await readWorktreeText(repoPath, gitPath);
    if (disk.isTooLarge) {
      return {
        path: gitPath,
        patch: '',
        hunks: [],
        lang,
        isBinary: false,
        isTooLarge: true,
        lineCount: 0,
        additions: 0,
        deletions: 0,
        status: 'untracked',
        note: 'Untracked file exceeds 512 KB preview limit.',
      };
    }
    if (disk.isBinary) {
      return {
        path: gitPath,
        patch: '',
        hunks: [],
        lang,
        isBinary: true,
        isTooLarge: false,
        lineCount: 0,
        additions: 0,
        deletions: 0,
        status: 'untracked',
        note: 'Binary untracked file.',
      };
    }
    const text = disk.text ?? '';
    const patch = buildUntrackedUnifiedPatch(gitPath, text);
    const parsed = parseUnifiedPatch(patch);
    return {
      path: gitPath,
      patch,
      hunks: parsed.hunks,
      oldContent: '',
      newContent: text.length <= MAX_CONTENT_BYTES ? text : undefined,
      lang,
      isBinary: false,
      isTooLarge: false,
      lineCount: parsed.lineCount,
      additions: parsed.additions,
      deletions: 0,
      status: 'untracked',
    };
  }

  const diffRes = await runGit(repoPath, [
    'diff',
    '--no-color',
    '-M',
    `--unified=${ctx}`,
    '--',
    gitPath,
  ]);
  const parsed = parseUnifiedPatch(diffRes.stdout);

  let oldContent: string | undefined;
  let newContent: string | undefined;
  if (!parsed.isBinary) {
    const [indexBlob, disk] = await Promise.all([
      readGitBlob(repoPath, `:${gitPath}`),
      readWorktreeText(repoPath, gitPath),
    ]);
    oldContent = indexBlob;
    newContent = !disk.isBinary && !disk.isTooLarge && (disk.text?.length ?? 0) <= MAX_CONTENT_BYTES
      ? disk.text
      : undefined;
  }

  let status: FileChangeStatus = section === 'conflicted' ? 'conflicted' : 'modified';
  if (diffRes.stdout.includes('\ndeleted file mode ')) status = 'deleted';
  else if (diffRes.stdout.includes('\nnew file mode ')) status = 'added';

  return {
    path: gitPath,
    patch: diffRes.stdout,
    hunks: parsed.hunks,
    oldContent,
    newContent,
    lang,
    isBinary: parsed.isBinary,
    isTooLarge: parsed.lineCount > 4500,
    lineCount: parsed.lineCount,
    additions: parsed.additions,
    deletions: parsed.deletions,
    status,
  };
}

const COMMIT_FIELD_SEP = '\x1f';
const COMMIT_RECORD_SEP = '\x1e';

function formatRelativeIso(isoDate: string): string {
  const ts = Date.parse(isoDate);
  if (Number.isNaN(ts)) return isoDate;
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  return `${Math.floor(diffMonth / 12)}y ago`;
}

function parseLogRecords(
  raw: string,
  pushClassifier: (sha: string) => { pushState: CommitPushState; pushedToRefs: string[] },
): CommitSummary[] {
  const commits: CommitSummary[] = [];
  const records = raw.split(COMMIT_RECORD_SEP);

  for (const rec of records) {
    const trimmed = rec.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(COMMIT_FIELD_SEP);
    if (fields.length < 7) continue;

    const [sha, authorName, authorEmail, authoredAt, parentsRaw, refsRaw, subject, ...bodyParts] = fields;
    const cleanSha = sha.trim();
    const { pushState, pushedToRefs } = pushClassifier(cleanSha);

    commits.push({
      sha: cleanSha,
      shortSha: cleanSha.slice(0, 7),
      authorName: authorName.trim(),
      authorEmail: authorEmail.trim(),
      authoredAt: authoredAt.trim(),
      relativeDate: formatRelativeIso(authoredAt.trim()),
      parents: parentsRaw.trim() ? parentsRaw.trim().split(' ') : [],
      refs: refsRaw
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
      subject: subject ?? '',
      body: bodyParts.join(COMMIT_FIELD_SEP).trim(),
      pushState,
      pushedToRefs,
    });
  }

  return commits;
}

export async function getCommitHistory(
  repoPath: string,
  limit = 40,
  offset = 0,
): Promise<CommitHistoryResponse> {
  const statusRes = await runGit(repoPath, ['status', '--porcelain=v2', '--branch', '-z']);
  const status = parseStatusPorcelainV2Z(statusRes.stdout);

  // Empty unborn repo guard
  if (!status.headSha) {
    return {
      commits: [],
      branch: status.branch,
      upstream: status.upstream,
      ahead: 0,
      behind: 0,
      hasMore: false,
    };
  }

  const unpushedSet = new Set<string>();
  const remoteOnlySet = new Set<string>();

  if (status.upstream) {
    const [aheadRes, behindRes] = await Promise.all([
      runGit(repoPath, ['rev-list', `${status.upstream}..HEAD`], { allowNonZeroExit: true }),
      runGit(repoPath, ['rev-list', `HEAD..${status.upstream}`], { allowNonZeroExit: true }),
    ]);

    if (aheadRes.exitCode === 0) {
      for (const sha of aheadRes.stdout.split(/\r?\n/)) {
        if (sha.trim()) unpushedSet.add(sha.trim());
      }
    }
    if (behindRes.exitCode === 0) {
      for (const sha of behindRes.stdout.split(/\r?\n/)) {
        if (sha.trim()) remoteOnlySet.add(sha.trim());
      }
    }
  } else {
    // No upstream tracking branch set on current branch:
    // Commits not reachable from ANY remote ref are unpushed!
    const localOnlyRes = await runGit(repoPath, ['rev-list', 'HEAD', '--not', '--remotes'], {
      allowNonZeroExit: true,
    });
    if (localOnlyRes.exitCode === 0) {
      for (const sha of localOnlyRes.stdout.split(/\r?\n/)) {
        if (sha.trim()) unpushedSet.add(sha.trim());
      }
    }
  }

  // Also grab remote refs list so commits on branches without upstream still show known remote presence
  const remoteRefsRes = await runGit(
    repoPath,
    ['for-each-ref', 'refs/remotes', '--format=%(refname:short)'],
    { allowNonZeroExit: true },
  );
  const allRemoteRefs = remoteRefsRes.stdout
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter((r) => r && !r.endsWith('/HEAD'));

  const prettyFormat = `%H${COMMIT_FIELD_SEP}%an${COMMIT_FIELD_SEP}%ae${COMMIT_FIELD_SEP}%aI${COMMIT_FIELD_SEP}%P${COMMIT_FIELD_SEP}%D${COMMIT_FIELD_SEP}%s${COMMIT_FIELD_SEP}%b${COMMIT_RECORD_SEP}`;

  const fetchLimit = limit + 1;
  const logRes = await runGit(repoPath, [
    'log',
    'HEAD',
    `--max-count=${fetchLimit}`,
    `--skip=${offset}`,
    `--format=${prettyFormat}`,
  ]);

  const headCommits = parseLogRecords(logRes.stdout, (sha) => {
    const isUnpushed = unpushedSet.has(sha);
    return {
      pushState: isUnpushed ? 'unpushed' : 'pushed',
      pushedToRefs: isUnpushed
        ? []
        : status.upstream
          ? [status.upstream]
          : allRemoteRefs.slice(0, 2),
    };
  });

  const hasMore = headCommits.length > limit;
  const slicedHeadCommits = hasMore ? headCommits.slice(0, limit) : headCommits;

  // On page 0, if remote has incoming commits not yet pulled, prepend them clearly!
  let remoteOnlyCommits: CommitSummary[] = [];
  if (offset === 0 && status.upstream && remoteOnlySet.size > 0) {
    const incomingRes = await runGit(repoPath, [
      'log',
      `HEAD..${status.upstream}`,
      '--max-count=20',
      `--format=${prettyFormat}`,
    ]);
    remoteOnlyCommits = parseLogRecords(incomingRes.stdout, () => ({
      pushState: 'remote_only',
      pushedToRefs: status.upstream ? [status.upstream] : [],
    }));
  }

  return {
    commits: [...remoteOnlyCommits, ...slicedHeadCommits],
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    hasMore,
  };
}

export async function getCommitDetail(repoPath: string, sha: string): Promise<CommitDetail> {
  if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) {
    throw new Error('Invalid commit SHA');
  }

  const prettyFormat = `%H${COMMIT_FIELD_SEP}%an${COMMIT_FIELD_SEP}%ae${COMMIT_FIELD_SEP}%aI${COMMIT_FIELD_SEP}%P${COMMIT_FIELD_SEP}%D${COMMIT_FIELD_SEP}%s${COMMIT_FIELD_SEP}%b${COMMIT_RECORD_SEP}`;

  const [metaRes, numstatRes, nameStatusRes, statusRes, remoteContainsRes] = await Promise.all([
    runGit(repoPath, ['show', '--no-patch', `--format=${prettyFormat}`, sha]),
    runGit(repoPath, ['diff-tree', '--no-commit-id', '--numstat', '-r', '-M', '--root', sha]),
    runGit(repoPath, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', '--root', sha]),
    runGit(repoPath, ['status', '--porcelain=v2', '--branch', '-z']),
    runGit(repoPath, ['branch', '-r', '--contains', sha], { allowNonZeroExit: true }),
  ]);

  const status = parseStatusPorcelainV2Z(statusRes.stdout);
  const remoteRefsContaining = remoteContainsRes.exitCode === 0
    ? remoteContainsRes.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.includes(' -> '))
    : [];

  let isRemoteOnly = false;
  if (status.upstream) {
    const ancestorRes = await runGit(repoPath, ['merge-base', '--is-ancestor', sha, 'HEAD'], {
      allowNonZeroExit: true,
    });
    if (ancestorRes.exitCode !== 0 && remoteRefsContaining.length > 0) {
      isRemoteOnly = true;
    }
  }

  const commits = parseLogRecords(metaRes.stdout, () => {
    if (isRemoteOnly) {
      return { pushState: 'remote_only', pushedToRefs: remoteRefsContaining };
    }
    const pushed = status.upstream
      ? remoteRefsContaining.includes(status.upstream)
      : remoteRefsContaining.length > 0;
    return {
      pushState: pushed ? 'pushed' : 'unpushed',
      pushedToRefs: remoteRefsContaining,
    };
  });

  if (commits.length === 0) {
    throw new Error(`Commit ${sha} not found`);
  }

  const files = parseCommitFilesOutput(numstatRes.stdout, nameStatusRes.stdout);
  return {
    commit: commits[0],
    files,
  };
}

export async function getCommitFileDiff(
  repoPath: string,
  sha: string,
  filePath: string,
  contextLines = 3,
): Promise<DiffPayload> {
  if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) {
    throw new Error('Invalid commit SHA');
  }
  const gitPath = toGitSlashPath(filePath);
  if (gitPath.includes('..')) {
    throw new Error('Invalid file path');
  }

  const lang = inferLanguageFromPath(gitPath);
  const ctx = Math.max(0, Math.min(contextLines, 50));

  const diffRes = await runGit(repoPath, [
    'show',
    '--no-color',
    '--format=',
    '-M',
    `--unified=${ctx}`,
    '--root',
    sha,
    '--',
    gitPath,
  ]);
  const parsed = parseUnifiedPatch(diffRes.stdout);

  let status: FileChangeStatus = 'modified';
  if (diffRes.stdout.includes('\nnew file mode ')) status = 'added';
  else if (diffRes.stdout.includes('\ndeleted file mode ')) status = 'deleted';
  else if (diffRes.stdout.includes('\nrename from ')) status = 'renamed';

  const [oldContent, newContent] = parsed.isBinary
    ? [undefined, undefined]
    : await Promise.all([
        status === 'added' ? Promise.resolve('') : readGitBlob(repoPath, `${sha}^:${gitPath}`),
        status === 'deleted' ? Promise.resolve('') : readGitBlob(repoPath, `${sha}:${gitPath}`),
      ]);

  return {
    path: gitPath,
    patch: diffRes.stdout,
    hunks: parsed.hunks,
    oldContent,
    newContent,
    lang,
    isBinary: parsed.isBinary,
    isTooLarge: parsed.lineCount > 4500,
    lineCount: parsed.lineCount,
    additions: parsed.additions,
    deletions: parsed.deletions,
    status,
  };
}

/**
 * Performs a fast, read-only live verification against the actual remote repository
 * via `git ls-remote` so users can be 100% sure commits are truly pushed on the server.
 */
export async function verifyRemoteSync(repoPath: string): Promise<RemoteVerifyResult> {
  const checkedAt = new Date().toISOString();
  const statusRes = await runGit(repoPath, ['status', '--porcelain=v2', '--branch', '-z']);
  const status = parseStatusPorcelainV2Z(statusRes.stdout);

  const remotesRes = await runGit(repoPath, ['remote']);
  const remotes = remotesRes.stdout
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter(Boolean);

  const remoteName = status.upstream ? status.upstream.split('/')[0] : (remotes[0] ?? null);
  if (!remoteName) {
    return {
      ok: false,
      checkedAt,
      remoteName: null,
      remoteUrl: null,
      branch: status.branch,
      upstreamRef: null,
      localHeadSha: status.headSha,
      localTrackingSha: null,
      remoteLiveSha: null,
      verdict: 'no_upstream',
      message: 'No Git remote configured for this repository.',
      aheadCount: status.ahead,
      behindCount: status.behind,
    };
  }

  const remoteUrlRes = await runGit(repoPath, ['remote', 'get-url', remoteName], { allowNonZeroExit: true });
  const remoteUrl = remoteUrlRes.exitCode === 0 ? remoteUrlRes.stdout.trim() : null;

  const targetRemoteBranch = status.upstream
    ? status.upstream.slice(remoteName.length + 1)
    : status.branch;

  let localTrackingSha: string | null = null;
  if (status.upstream) {
    const trackRes = await runGit(repoPath, ['rev-parse', status.upstream], { allowNonZeroExit: true });
    if (trackRes.exitCode === 0) localTrackingSha = trackRes.stdout.trim();
  }

  const lsRes = await runGit(
    repoPath,
    ['ls-remote', '--heads', remoteName, `refs/heads/${targetRemoteBranch}`],
    { allowNonZeroExit: true, timeoutMs: 15_000 },
  );

  if (lsRes.exitCode !== 0) {
    return {
      ok: false,
      checkedAt,
      remoteName,
      remoteUrl,
      branch: status.branch,
      upstreamRef: status.upstream,
      localHeadSha: status.headSha,
      localTrackingSha,
      remoteLiveSha: null,
      verdict: 'error',
      message: lsRes.stderr.trim() || `Unable to reach remote "${remoteName}".`,
      aheadCount: status.ahead,
      behindCount: status.behind,
    };
  }

  const firstLine = lsRes.stdout.trim().split(/\r?\n/)[0] ?? '';
  const remoteLiveSha = firstLine ? firstLine.split(/\s+/)[0] : null;

  if (!remoteLiveSha) {
    return {
      ok: true,
      checkedAt,
      remoteName,
      remoteUrl,
      branch: status.branch,
      upstreamRef: status.upstream,
      localHeadSha: status.headSha,
      localTrackingSha,
      remoteLiveSha: null,
      verdict: 'no_remote_branch',
      message: `Branch "${targetRemoteBranch}" does not exist on ${remoteName} yet. Commits are local only.`,
      aheadCount: status.ahead,
      behindCount: status.behind,
    };
  }

  if (status.headSha && remoteLiveSha === status.headSha) {
    return {
      ok: true,
      checkedAt,
      remoteName,
      remoteUrl,
      branch: status.branch,
      upstreamRef: status.upstream,
      localHeadSha: status.headSha,
      localTrackingSha,
      remoteLiveSha,
      verdict: 'synced',
      message: `Live check confirmed: ${remoteName}/${targetRemoteBranch} matches HEAD (${remoteLiveSha.slice(0, 7)}). All commits are pushed.`,
      aheadCount: 0,
      behindCount: 0,
    };
  }

  if (localTrackingSha && remoteLiveSha !== localTrackingSha) {
    return {
      ok: true,
      checkedAt,
      remoteName,
      remoteUrl,
      branch: status.branch,
      upstreamRef: status.upstream,
      localHeadSha: status.headSha,
      localTrackingSha,
      remoteLiveSha,
      verdict: 'stale_local_cache',
      message: `Remote server is at ${remoteLiveSha.slice(0, 7)}, while local ${status.upstream ?? remoteName} cache is at ${localTrackingSha.slice(0, 7)}. Tap Fetch to refresh.`,
      aheadCount: status.ahead,
      behindCount: status.behind,
    };
  }

  if (!status.upstream) {
    return {
      ok: true,
      checkedAt,
      remoteName,
      remoteUrl,
      branch: status.branch,
      upstreamRef: null,
      localHeadSha: status.headSha,
      localTrackingSha: null,
      remoteLiveSha,
      verdict: 'no_upstream',
      message: `Remote branch ${remoteName}/${targetRemoteBranch} exists at ${remoteLiveSha.slice(0, 7)}, but local branch has no upstream set.`,
      aheadCount: status.ahead,
      behindCount: status.behind,
    };
  }

  if (status.ahead > 0 && status.behind === 0) {
    return {
      ok: true,
      checkedAt,
      remoteName,
      remoteUrl,
      branch: status.branch,
      upstreamRef: status.upstream,
      localHeadSha: status.headSha,
      localTrackingSha,
      remoteLiveSha,
      verdict: 'ahead_unpushed',
      message: `Verified live: ${status.ahead} local commit(s) NOT yet pushed to ${remoteName}/${targetRemoteBranch}.`,
      aheadCount: status.ahead,
      behindCount: 0,
    };
  }

  if (status.ahead === 0 && status.behind > 0) {
    return {
      ok: true,
      checkedAt,
      remoteName,
      remoteUrl,
      branch: status.branch,
      upstreamRef: status.upstream,
      localHeadSha: status.headSha,
      localTrackingSha,
      remoteLiveSha,
      verdict: 'behind_remote',
      message: `Verified live: local branch is behind ${remoteName}/${targetRemoteBranch} by ${status.behind} commit(s).`,
      aheadCount: 0,
      behindCount: status.behind,
    };
  }

  return {
    ok: true,
    checkedAt,
    remoteName,
    remoteUrl,
    branch: status.branch,
    upstreamRef: status.upstream,
    localHeadSha: status.headSha,
    localTrackingSha,
    remoteLiveSha,
    verdict: 'diverged',
    message: `Diverged from ${remoteName}/${targetRemoteBranch}: ${status.ahead} ahead, ${status.behind} behind.`,
    aheadCount: status.ahead,
    behindCount: status.behind,
  };
}

export async function stageFiles(repoPath: string, paths?: string[]): Promise<void> {
  if (!paths || paths.length === 0) {
    await runGit(repoPath, ['add', '-A']);
    return;
  }
  const safePaths = paths.map((p) => {
    assertSafeRepoPath(repoPath, p);
    return toGitSlashPath(p);
  });
  await runGit(repoPath, ['add', '--', ...safePaths]);
}

export async function unstageFiles(repoPath: string, paths?: string[]): Promise<void> {
  const headCheck = await runGit(repoPath, ['rev-parse', '--verify', 'HEAD'], { allowNonZeroExit: true });
  const hasHead = headCheck.exitCode === 0;

  if (!paths || paths.length === 0) {
    if (hasHead) {
      await runGit(repoPath, ['reset', 'HEAD', '--']);
    } else {
      await runGit(repoPath, ['rm', '-r', '--cached', '--ignore-unmatch', '.']);
    }
    return;
  }

  const safePaths = paths.map((p) => {
    assertSafeRepoPath(repoPath, p);
    return toGitSlashPath(p);
  });

  if (hasHead) {
    await runGit(repoPath, ['reset', 'HEAD', '--', ...safePaths]);
  } else {
    await runGit(repoPath, ['rm', '--cached', '--ignore-unmatch', '--', ...safePaths]);
  }
}

export async function discardUnstagedFile(repoPath: string, filePath: string): Promise<void> {
  const absPath = assertSafeRepoPath(repoPath, filePath);
  const gitPath = toGitSlashPath(filePath);

  const untrackedCheck = await runGit(repoPath, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    gitPath,
  ]);
  if (untrackedCheck.stdout.trim().length > 0) {
    await fs.rm(absPath, { force: true, recursive: true });
    return;
  }

  await runGit(repoPath, ['checkout', '--', gitPath]);
}

export async function createCommit(repoPath: string, summary: string, description = ''): Promise<{ sha: string }> {
  const cleanSummary = summary.trim();
  if (!cleanSummary) {
    throw new Error('Commit summary is required');
  }

  const args = ['commit', '-m', cleanSummary];
  if (description.trim()) {
    args.push('-m', description.trim());
  }
  await runGit(repoPath, args);
  const headRes = await runGit(repoPath, ['rev-parse', 'HEAD']);
  return { sha: headRes.stdout.trim() };
}

export async function fetchRemote(repoPath: string): Promise<{ output: string }> {
  const res = await runGit(repoPath, ['fetch', '--all', '--prune'], { timeoutMs: 30_000 });
  return { output: (res.stdout + '\n' + res.stderr).trim() || 'Fetched remote references.' };
}

export async function pullBranch(repoPath: string): Promise<{ output: string }> {
  const res = await runGit(repoPath, ['pull', '--ff-only'], { timeoutMs: 30_000 });
  return { output: (res.stdout + '\n' + res.stderr).trim() || 'Branch updated.' };
}

export async function pushBranch(repoPath: string, setUpstream = false): Promise<{ output: string }> {
  if (setUpstream) {
    const branchRes = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchRes.stdout.trim();
    const remotesRes = await runGit(repoPath, ['remote']);
    const remote = remotesRes.stdout.split(/\r?\n/).map((r) => r.trim()).find(Boolean) ?? 'origin';
    const res = await runGit(repoPath, ['push', '-u', remote, branch], { timeoutMs: 40_000 });
    return { output: (res.stdout + '\n' + res.stderr).trim() || `Pushed ${branch} to ${remote}.` };
  }

  const res = await runGit(repoPath, ['push'], { timeoutMs: 40_000 });
  return { output: (res.stdout + '\n' + res.stderr).trim() || 'Pushed commits to remote.' };
}

export async function listBranches(repoPath: string): Promise<BranchItem[]> {
  const format = '%(refname)%09%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(objectname:short)%09%(contents:subject)%09%(committerdate:relative)';
  const res = await runGit(repoPath, [
    'for-each-ref',
    '--sort=-committerdate',
    `--format=${format}`,
    'refs/heads',
    'refs/remotes',
  ]);

  const items: BranchItem[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [refname, shortName, headMark, upstream, track, sha, subject, date] = line.split('\t');
    if (shortName.endsWith('/HEAD')) continue;

    let ahead: number | undefined;
    let behind: number | undefined;
    if (track) {
      const aMatch = /ahead (\d+)/.exec(track);
      const bMatch = /behind (\d+)/.exec(track);
      if (aMatch) ahead = Number.parseInt(aMatch[1], 10);
      if (bMatch) behind = Number.parseInt(bMatch[1], 10);
    }

    items.push({
      name: refname,
      shortName,
      isCurrent: headMark === '*',
      isRemote: refname.startsWith('refs/remotes/'),
      upstream: upstream || undefined,
      ahead,
      behind,
      lastCommitSha: sha ?? '',
      lastCommitSubject: subject ?? '',
      lastCommitDate: date ?? '',
    });
  }
  return items;
}

export async function checkoutBranch(repoPath: string, branchName: string, create = false): Promise<void> {
  if (!branchName.trim()) {
    throw new Error('Branch name is required');
  }
  try {
    if (create) {
      await runGit(repoPath, ['checkout', '-b', branchName.trim()]);
    } else {
      await runGit(repoPath, ['checkout', branchName.trim()]);
    }
  } catch (err) {
    if (err instanceof GitCommandError) {
      throw new Error(err.stderr.trim() || err.message);
    }
    throw err;
  }
}
