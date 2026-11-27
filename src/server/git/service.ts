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
import { GitCommandError, runGit, runGitBinaryWithInput } from './runner.ts';

const MAX_READ_BYTES = 512 * 1024;
const MAX_CONTENT_BYTES = 180 * 1024;

export function assertSafeRepoPath(repoRoot: string, filePath: string): string {
  if (!filePath || /[\0\r\n]/.test(filePath)) {
    throw new Error(`Invalid repository file path: ${filePath}`);
  }
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

async function resolveRealpathOrParent(targetPath: string): Promise<string | null> {
  let current = path.resolve(targetPath);
  while (true) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

async function assertSafeWorktreeTarget(repoRoot: string, filePath: string): Promise<string> {
  const resolvedTarget = assertSafeRepoPath(repoRoot, filePath);
  const [realRoot, realTargetOrAncestor] = await Promise.all([
    fs.realpath(path.resolve(repoRoot)).catch(() => path.resolve(repoRoot)),
    resolveRealpathOrParent(resolvedTarget),
  ]);
  if (realTargetOrAncestor) {
    const rel = path.relative(realRoot, realTargetOrAncestor);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Repository path resolves outside root: ${filePath}`);
    }
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
  try {
    const contentRes = await runGit(repoPath, ['cat-file', 'blob', spec], {
      allowNonZeroExit: true,
      readOnly: true,
      maxBuffer: MAX_CONTENT_BYTES + 16_384,
    });
    if (contentRes.exitCode !== 0) return undefined;
    if (Buffer.byteLength(contentRes.stdout, 'utf8') > MAX_CONTENT_BYTES) return undefined;
    if (contentRes.stdout.includes('\0')) return undefined;
    return contentRes.stdout;
  } catch {
    return undefined;
  }
}

async function readGitBlobsBatch(repoPath: string, specs: string[]): Promise<Array<string | undefined>> {
  if (specs.length === 0) return [];
  try {
    const out = await runGitBinaryWithInput(
      repoPath,
      ['cat-file', '--batch'],
      `${specs.join('\n')}\n`,
      {
        readOnly: true,
        maxOutputBytes: specs.length * MAX_CONTENT_BYTES + 65_536,
      },
    );

    const results: Array<string | undefined> = [];
    let offset = 0;

    for (let i = 0; i < specs.length; i += 1) {
      if (offset >= out.length) {
        results.push(undefined);
        continue;
      }
      const nlIdx = out.indexOf(0x0a, offset);
      if (nlIdx < 0) {
        results.push(undefined);
        break;
      }
      const header = out.subarray(offset, nlIdx).toString('utf8').replace(/\r$/, '');
      offset = nlIdx + 1;

      if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
        results.push(undefined);
        continue;
      }

      const match = header.match(/^[0-9a-f]{40,64}\s+(\S+)\s+(\d+)$/i);
      if (!match) {
        results.push(undefined);
        break;
      }

      const objType = match[1];
      const byteSize = Number.parseInt(match[2], 10);
      const endOffset = offset + byteSize;
      if (!Number.isFinite(byteSize) || endOffset > out.length) {
        results.push(undefined);
        break;
      }

      const slice = out.subarray(offset, endOffset);
      offset = endOffset + 1;

      if (objType !== 'blob' || byteSize > MAX_CONTENT_BYTES || looksBinary(slice)) {
        results.push(undefined);
      } else {
        results.push(slice.toString('utf8'));
      }
    }

    return results;
  } catch {
    return specs.map(() => undefined);
  }
}

async function readWorktreeText(repoPath: string, filePath: string): Promise<{ text?: string; isBinary: boolean; isTooLarge: boolean }> {
  const absPath = await assertSafeWorktreeTarget(repoPath, filePath);
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
  const topRes = await runGit(resolved, ['rev-parse', '--show-toplevel'], { readOnly: true });
  const rootPath = path.resolve(topRes.stdout.trim());
  const remoteRes = await runGit(rootPath, ['remote', 'get-url', 'origin'], {
    allowNonZeroExit: true,
    readOnly: true,
  });
  return {
    rootPath,
    name: path.basename(rootPath) || rootPath,
    remoteUrl: remoteRes.exitCode === 0 ? remoteRes.stdout.trim() : undefined,
  };
}

async function readLocalRemoteNamesFast(repoPath: string): Promise<string[] | null> {
  try {
    const config = await fs.readFile(path.join(repoPath, '.git', 'config'), 'utf8');
    // Fall back to `git remote` when conditional includes are present.
    if (/^\s*\[include(?:If)?\b/im.test(config)) {
      return null;
    }
    const remotes: string[] = [];
    for (const line of config.split(/\r?\n/)) {
      const match = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*(?:[#;].*)?$/);
      if (match) {
        remotes.push(match[1]);
      }
    }
    return remotes;
  } catch {
    return null;
  }
}

export async function getRepoStatus(repo: RepoEntry): Promise<RepoStatusSummary> {
  const statusRes = await runGit(
    repo.path,
    ['status', '--porcelain=v2', '--branch', '-z'],
    { readOnly: true },
  );

  const parsed = parseStatusPorcelainV2Z(statusRes.stdout);
  let hasRemote = Boolean(parsed.upstream);
  let remoteName = parsed.upstream ? parsed.upstream.split('/')[0] : null;

  if (!parsed.upstream) {
    let remotes = await readLocalRemoteNamesFast(repo.path);
    if (remotes === null) {
      const remotesRes = await runGit(repo.path, ['remote'], { readOnly: true });
      remotes = remotesRes.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }
    hasRemote = remotes.length > 0;
    remoteName = remotes[0] ?? null;
  }

  return {
    repo,
    branch: parsed.branch,
    headSha: parsed.headSha,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    isDetached: parsed.isDetached,
    hasRemote,
    remoteName,
    unstaged: parsed.unstaged,
    staged: parsed.staged,
    conflicted: parsed.conflicted,
    lastRefreshedAt: new Date().toISOString(),
  };
}

function buildUntrackedDiffPayload(
  gitPath: string,
  lang: string,
  disk: { text?: string; isBinary: boolean; isTooLarge: boolean },
): DiffPayload {
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

export async function getWorkingFileDiff(
  repoPath: string,
  filePath: string,
  section: 'unstaged' | 'staged' | 'conflicted',
  contextLines = 3,
  hintStatus?: 'untracked',
): Promise<DiffPayload> {
  assertSafeRepoPath(repoPath, filePath);
  const gitPath = toGitSlashPath(filePath);
  const lang = inferLanguageFromPath(gitPath);
  const ctx = Math.max(0, Math.min(contextLines, 50));

  if (section === 'staged') {
    const [diffRes, blobs] = await Promise.all([
      runGit(
        repoPath,
        ['diff', '--staged', '--no-color', '-M', `--unified=${ctx}`, '--', gitPath],
        { readOnly: true },
      ),
      readGitBlobsBatch(repoPath, [`HEAD:${gitPath}`, `:${gitPath}`]),
    ]);
    const [oldContent, newContent] = blobs;
    const parsed = parseUnifiedPatch(diffRes.stdout);

    let status: FileChangeStatus = 'modified';
    if (diffRes.stdout.includes('\nnew file mode ')) status = 'added';
    else if (diffRes.stdout.includes('\ndeleted file mode ')) status = 'deleted';
    else if (diffRes.stdout.includes('\nrename from ')) status = 'renamed';

    return {
      path: gitPath,
      patch: diffRes.stdout,
      hunks: parsed.hunks,
      oldContent: parsed.isBinary ? undefined : oldContent,
      newContent: parsed.isBinary ? undefined : newContent,
      lang,
      isBinary: parsed.isBinary,
      isTooLarge: parsed.lineCount > 4500,
      lineCount: parsed.lineCount,
      additions: parsed.additions,
      deletions: parsed.deletions,
      status,
    };
  }

  if (section === 'unstaged' && hintStatus === 'untracked') {
    const disk = await readWorktreeText(repoPath, gitPath);
    return buildUntrackedDiffPayload(gitPath, lang, disk);
  }

  const [diffRes, indexBlob, disk] = await Promise.all([
    runGit(
      repoPath,
      ['diff', '--no-color', '-M', `--unified=${ctx}`, '--', gitPath],
      { readOnly: true },
    ),
    readGitBlob(repoPath, `:${gitPath}`),
    readWorktreeText(repoPath, gitPath),
  ]);

  if (!diffRes.stdout.trim() && indexBlob === undefined) {
    const untrackedCheck = await runGit(
      repoPath,
      ['ls-files', '--others', '--exclude-standard', '--', gitPath],
      { readOnly: true },
    );
    if (untrackedCheck.stdout.trim().length > 0) {
      return buildUntrackedDiffPayload(gitPath, lang, disk);
    }
  }

  const parsed = parseUnifiedPatch(diffRes.stdout);
  const oldContent = !parsed.isBinary ? indexBlob : undefined;
  const newContent =
    !parsed.isBinary &&
    !disk.isBinary &&
    !disk.isTooLarge &&
    (disk.text?.length ?? 0) <= MAX_CONTENT_BYTES
      ? disk.text
      : undefined;

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
  const prettyFormat = `%H${COMMIT_FIELD_SEP}%an${COMMIT_FIELD_SEP}%ae${COMMIT_FIELD_SEP}%aI${COMMIT_FIELD_SEP}%P${COMMIT_FIELD_SEP}%D${COMMIT_FIELD_SEP}%s${COMMIT_FIELD_SEP}%b${COMMIT_RECORD_SEP}`;
  const fetchLimit = limit + 1;

  const [refsRes, logRes] = await Promise.all([
    runGit(
      repoPath,
      [
        'for-each-ref',
        '--format=%(HEAD)%09%(refname)%09%(refname:short)%09%(objectname)%09%(upstream:short)%09%(upstream:track,nobracket)',
        'refs/heads',
        'refs/remotes',
      ],
      { allowNonZeroExit: true, readOnly: true },
    ),
    runGit(
      repoPath,
      ['log', 'HEAD', `--max-count=${fetchLimit}`, `--skip=${offset}`, `--format=${prettyFormat}`],
      { allowNonZeroExit: true, readOnly: true },
    ),
  ]);

  let branch = 'HEAD';
  let headSha: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const allRemoteRefs: string[] = [];

  for (const rawLine of refsRes.stdout.split(/\r?\n/)) {
    if (!rawLine) continue;
    const [headMark = '', fullRef = '', shortName = '', objSha = '', upstreamShort = '', trackText = ''] =
      rawLine.split('\t');

    if (fullRef.startsWith('refs/remotes/')) {
      if (shortName && !shortName.endsWith('/HEAD')) {
        allRemoteRefs.push(shortName);
      }
      continue;
    }

    if (headMark.trim() === '*' && fullRef.startsWith('refs/heads/')) {
      branch = shortName || branch;
      headSha = objSha || null;
      upstream = upstreamShort || null;
      const aheadMatch = trackText.match(/ahead\s+(\d+)/i);
      const behindMatch = trackText.match(/behind\s+(\d+)/i);
      ahead = aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0;
      behind = behindMatch ? Number.parseInt(behindMatch[1], 10) : 0;
    }
  }

  // Fallback for detached HEAD or unborn repo where no refs/heads/* matches *(HEAD)
  if (!headSha && logRes.exitCode === 0 && logRes.stdout.trim()) {
    const statusRes = await runGit(
      repoPath,
      ['status', '--porcelain=v2', '--branch', '--untracked-files=no', '-z'],
      { readOnly: true },
    );
    const parsedStatus = parseStatusPorcelainV2Z(statusRes.stdout);
    branch = parsedStatus.branch;
    headSha = parsedStatus.headSha;
    upstream = parsedStatus.upstream;
    ahead = parsedStatus.ahead;
    behind = parsedStatus.behind;
  } else if (!headSha) {
    // Unborn repo (no commits yet): extract symbolic branch name quickly if available
    try {
      const headFile = await fs.readFile(path.join(repoPath, '.git', 'HEAD'), 'utf8');
      const refMatch = headFile.trim().match(/^ref:\s*refs\/heads\/(.+)$/);
      if (refMatch) branch = refMatch[1];
    } catch {
      // Keep default 'HEAD'
    }
  }

  // Empty unborn repo guard
  if (!headSha || logRes.exitCode !== 0) {
    return {
      commits: [],
      branch,
      upstream,
      ahead: 0,
      behind: 0,
      hasMore: false,
    };
  }

  const unpushedSet = new Set<string>();
  const remoteOnlySet = new Set<string>();
  let markAllUnpushed = false;

  if (upstream) {
    const [aheadRes, behindRes] = await Promise.all([
      ahead > 0
        ? runGit(repoPath, ['rev-list', `${upstream}..HEAD`], {
            allowNonZeroExit: true,
            readOnly: true,
          })
        : Promise.resolve(null),
      behind > 0
        ? runGit(repoPath, ['rev-list', `HEAD..${upstream}`], {
            allowNonZeroExit: true,
            readOnly: true,
          })
        : Promise.resolve(null),
    ]);

    if (aheadRes && aheadRes.exitCode === 0) {
      for (const sha of aheadRes.stdout.split(/\r?\n/)) {
        if (sha.trim()) unpushedSet.add(sha.trim());
      }
    }
    if (behindRes && behindRes.exitCode === 0) {
      for (const sha of behindRes.stdout.split(/\r?\n/)) {
        if (sha.trim()) remoteOnlySet.add(sha.trim());
      }
    }
  } else if (allRemoteRefs.length === 0) {
    // No remote tracking refs exist locally, so every commit in HEAD is unpushed
    markAllUnpushed = true;
  } else {
    // No upstream tracking branch set on current branch:
    // Commits not reachable from ANY remote ref are unpushed!
    const localOnlyRes = await runGit(repoPath, ['rev-list', 'HEAD', '--not', '--remotes'], {
      allowNonZeroExit: true,
      readOnly: true,
    });
    if (localOnlyRes.exitCode === 0) {
      for (const sha of localOnlyRes.stdout.split(/\r?\n/)) {
        if (sha.trim()) unpushedSet.add(sha.trim());
      }
    }
  }

  const headCommits = parseLogRecords(logRes.stdout, (sha) => {
    const isUnpushed = markAllUnpushed || unpushedSet.has(sha);
    return {
      pushState: isUnpushed ? 'unpushed' : 'pushed',
      pushedToRefs: isUnpushed
        ? []
        : upstream
          ? [upstream]
          : allRemoteRefs.slice(0, 2),
    };
  });

  const hasMore = headCommits.length > limit;
  const slicedHeadCommits = hasMore ? headCommits.slice(0, limit) : headCommits;

  // On page 0, if remote has incoming commits not yet pulled, prepend them clearly!
  let remoteOnlyCommits: CommitSummary[] = [];
  if (offset === 0 && upstream && remoteOnlySet.size > 0) {
    const incomingRes = await runGit(
      repoPath,
      ['log', `HEAD..${upstream}`, '--max-count=20', `--format=${prettyFormat}`],
      { readOnly: true },
    );
    remoteOnlyCommits = parseLogRecords(incomingRes.stdout, () => ({
      pushState: 'remote_only',
      pushedToRefs: upstream ? [upstream] : [],
    }));
  }

  return {
    commits: [...remoteOnlyCommits, ...slicedHeadCommits],
    branch,
    upstream,
    ahead,
    behind,
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
    runGit(repoPath, ['status', '--porcelain=v2', '--branch', '-z'], { readOnly: true }),
    runGit(repoPath, ['branch', '-r', '--contains', sha], { allowNonZeroExit: true, readOnly: true }),
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
  assertSafeRepoPath(repoPath, filePath);
  const gitPath = toGitSlashPath(filePath);

  const lang = inferLanguageFromPath(gitPath);
  const ctx = Math.max(0, Math.min(contextLines, 50));

  const [diffRes, commitBlobs] = await Promise.all([
    runGit(
      repoPath,
      ['show', '--no-color', '--format=', '-M', `--unified=${ctx}`, '--root', sha, '--', gitPath],
      { readOnly: true },
    ),
    readGitBlobsBatch(repoPath, [`${sha}^:${gitPath}`, `${sha}:${gitPath}`]),
  ]);
  const [oldBlob, newBlob] = commitBlobs;
  const parsed = parseUnifiedPatch(diffRes.stdout);

  let status: FileChangeStatus = 'modified';
  if (diffRes.stdout.includes('\nnew file mode ')) status = 'added';
  else if (diffRes.stdout.includes('\ndeleted file mode ')) status = 'deleted';
  else if (diffRes.stdout.includes('\nrename from ')) status = 'renamed';

  const oldContent = parsed.isBinary ? undefined : status === 'added' ? '' : oldBlob;
  const newContent = parsed.isBinary ? undefined : status === 'deleted' ? '' : newBlob;

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
  const statusRes = await runGit(repoPath, ['status', '--porcelain=v2', '--branch', '-z'], { readOnly: true });
  const status = parseStatusPorcelainV2Z(statusRes.stdout);

  const remotesRes = await runGit(repoPath, ['remote'], { readOnly: true });
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
  const absPath = await assertSafeWorktreeTarget(repoPath, filePath);
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
  const res = await runGit(
    repoPath,
    [
      'for-each-ref',
      '--sort=-committerdate',
      `--format=${format}`,
      'refs/heads',
      'refs/remotes',
    ],
    { readOnly: true },
  );

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
  const cleanName = branchName.trim();
  if (!cleanName) {
    throw new Error('Branch name is required');
  }
  if (cleanName.startsWith('-') || /[\x00-\x1f\x7f]/.test(cleanName)) {
    throw new Error('Invalid branch name');
  }
  const refCheck = await runGit(repoPath, ['check-ref-format', '--branch', cleanName], {
    allowNonZeroExit: true,
    readOnly: true,
  });
  if (refCheck.exitCode !== 0) {
    throw new Error(`Invalid Git branch name: ${cleanName}`);
  }
  try {
    if (create) {
      await runGit(repoPath, ['checkout', '-b', cleanName]);
    } else {
      await runGit(repoPath, ['checkout', cleanName]);
    }
  } catch (err) {
    if (err instanceof GitCommandError) {
      throw new Error(err.stderr.trim() || err.message);
    }
    throw err;
  }
}
