import type {
  ChangedFile,
  CommitChangedFile,
  FileChangeStatus,
} from '../../shared/types.ts';

export interface ParsedGitStatus {
  branch: string;
  headSha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  isDetached: boolean;
  unstaged: ChangedFile[];
  staged: ChangedFile[];
  conflicted: ChangedFile[];
}

function mapXYCodeToStatus(code: string): FileChangeStatus {
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    case 'U':
      return 'conflicted';
    case 'M':
    default:
      return 'modified';
  }
}

/**
 * Parses `git status --porcelain=v2 --branch -z` NUL-delimited output into
 * separate unstaged (including untracked), staged, and conflicted lists.
 */
export function parseStatusPorcelainV2Z(raw: string): ParsedGitStatus {
  const result: ParsedGitStatus = {
    branch: 'HEAD',
    headSha: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    isDetached: false,
    unstaged: [],
    staged: [],
    conflicted: [],
  };

  if (!raw) return result;

  const tokens = raw.split('\0');
  let i = 0;

  while (i < tokens.length) {
    const record = tokens[i];
    i += 1;
    if (!record) continue;

    if (record.startsWith('# ')) {
      if (record.startsWith('# branch.oid ')) {
        const oid = record.slice('# branch.oid '.length).trim();
        result.headSha = oid === '(initial)' ? null : oid;
      } else if (record.startsWith('# branch.head ')) {
        const head = record.slice('# branch.head '.length).trim();
        if (head === '(detached)') {
          result.isDetached = true;
          result.branch = result.headSha ? result.headSha.slice(0, 7) : 'detached';
        } else {
          result.branch = head;
        }
      } else if (record.startsWith('# branch.upstream ')) {
        result.upstream = record.slice('# branch.upstream '.length).trim() || null;
      } else if (record.startsWith('# branch.ab ')) {
        const match = /\+(\d+)\s+-(\d+)/.exec(record);
        if (match) {
          result.ahead = Number.parseInt(match[1], 10) || 0;
          result.behind = Number.parseInt(match[2], 10) || 0;
        }
      }
      continue;
    }

    // Untracked file: ? <path>
    if (record.startsWith('? ')) {
      const filePath = record.slice(2);
      result.unstaged.push({
        path: filePath,
        status: 'untracked',
        section: 'unstaged',
        isUntracked: true,
      });
      continue;
    }

    // Ignored entry (not normally emitted unless --ignored)
    if (record.startsWith('! ')) {
      continue;
    }

    // Ordinary changed entry:
    // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
    if (record.startsWith('1 ')) {
      const parts = record.split(' ');
      if (parts.length < 9) continue;
      const xy = parts[1];
      const filePath = parts.slice(8).join(' ');
      const indexCode = xy[0] ?? '.';
      const worktreeCode = xy[1] ?? '.';

      if (indexCode !== '.') {
        result.staged.push({
          path: filePath,
          status: mapXYCodeToStatus(indexCode),
          section: 'staged',
        });
      }
      if (worktreeCode !== '.') {
        result.unstaged.push({
          path: filePath,
          status: mapXYCodeToStatus(worktreeCode),
          section: 'unstaged',
        });
      }
      continue;
    }

    // Rename or copy entry:
    // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
    if (record.startsWith('2 ')) {
      const parts = record.split(' ');
      if (parts.length < 10) continue;
      const xy = parts[1];
      const filePath = parts.slice(9).join(' ');
      const origPath = tokens[i] ?? undefined;
      i += 1;

      const indexCode = xy[0] ?? '.';
      const worktreeCode = xy[1] ?? '.';

      if (indexCode !== '.') {
        result.staged.push({
          path: filePath,
          oldPath: origPath,
          status: mapXYCodeToStatus(indexCode),
          section: 'staged',
        });
      }
      if (worktreeCode !== '.') {
        result.unstaged.push({
          path: filePath,
          oldPath: origPath,
          status: mapXYCodeToStatus(worktreeCode),
          section: 'unstaged',
        });
      }
      continue;
    }

    // Unmerged entry:
    // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
    if (record.startsWith('u ')) {
      const parts = record.split(' ');
      if (parts.length < 11) continue;
      const filePath = parts.slice(10).join(' ');
      result.conflicted.push({
        path: filePath,
        status: 'conflicted',
        section: 'conflicted',
      });
    }
  }

  return result;
}

export interface ParsedPatchSummary {
  hunks: string[];
  additions: number;
  deletions: number;
  isBinary: boolean;
  lineCount: number;
}

/**
 * Splits a raw `git diff` output for one file into hunk strings suitable for
 * @git-diff-view/file `DiffFile`, while counting +/- lines and binary markers.
 */
export function parseUnifiedPatch(rawPatch: string): ParsedPatchSummary {
  if (!rawPatch.trim()) {
    return { hunks: [], additions: 0, deletions: 0, isBinary: false, lineCount: 0 };
  }

  const normalized = rawPatch.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  const isBinary =
    lines.some((line) => line.startsWith('Binary files ') || line === 'GIT binary patch');

  const hunks: string[] = [];
  let currentHunk: string[] | null = null;
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      if (currentHunk && currentHunk.length > 0) {
        hunks.push(currentHunk.join('\n'));
      }
      currentHunk = [line];
      continue;
    }

    if (currentHunk) {
      // Stop if another diff --git header appears
      if (line.startsWith('diff --git ')) {
        hunks.push(currentHunk.join('\n'));
        currentHunk = null;
        continue;
      }
      currentHunk.push(line);
      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions += 1;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions += 1;
      }
    }
  }

  if (currentHunk && currentHunk.length > 0) {
    // Strip single trailing empty line generated by split
    if (currentHunk[currentHunk.length - 1] === '') {
      currentHunk.pop();
    }
    if (currentHunk.length > 0) {
      hunks.push(currentHunk.join('\n'));
    }
  }

  return {
    hunks,
    additions,
    deletions,
    isBinary,
    lineCount: lines.length,
  };
}

/**
 * Builds a clean unified diff patch from raw text content of an untracked file.
 */
export function buildUntrackedUnifiedPatch(filePath: string, content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const rawLines = normalized.split('\n');
  const hasTrailingNewline = normalized.endsWith('\n');
  const lines = hasTrailingNewline ? rawLines.slice(0, -1) : rawLines;

  if (lines.length === 0) {
    return [
      `diff --git a/${filePath} b/${filePath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${filePath}`,
    ].join('\n');
  }

  const hunkHeader = `@@ -0,0 +1,${lines.length} @@`;
  const addedLines = lines.map((line) => `+${line}`);
  if (!hasTrailingNewline) {
    addedLines.push('\\ No newline at end of file');
  }

  return [
    `diff --git a/${filePath} b/${filePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${filePath}`,
    hunkHeader,
    ...addedLines,
  ].join('\n');
}

const EXTENSION_LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  c: 'c',
  h: 'c',
  hpp: 'cpp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  svelte: 'xml',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  md: 'markdown',
  mdx: 'markdown',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  diff: 'diff',
  patch: 'diff',
};

export function inferLanguageFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  const baseName = lower.split('/').pop() ?? lower;
  if (baseName === 'dockerfile' || baseName.startsWith('dockerfile.')) return 'dockerfile';
  if (baseName === 'makefile') return 'makefile';

  const lastDot = baseName.lastIndexOf('.');
  if (lastDot === -1) return 'plaintext';
  const ext = baseName.slice(lastDot + 1);
  return EXTENSION_LANG_MAP[ext] ?? 'plaintext';
}

export function parseCommitFilesOutput(numstatOut: string, nameStatusOut: string): CommitChangedFile[] {
  const statusMap = new Map<string, { status: FileChangeStatus; oldPath?: string }>();

  for (const line of nameStatusOut.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0]?.[0] ?? 'M';
    if ((code === 'R' || code === 'C') && parts.length >= 3) {
      statusMap.set(parts[2], { status: mapXYCodeToStatus(code), oldPath: parts[1] });
    } else if (parts.length >= 2) {
      statusMap.set(parts[1], { status: mapXYCodeToStatus(code) });
    }
  }

  const files: CommitChangedFile[] = [];
  for (const line of numstatOut.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addRaw, delRaw, ...pathParts] = parts;
    const filePath = pathParts.length > 1 ? pathParts[pathParts.length - 1] : pathParts[0];
    const isBinary = addRaw === '-' || delRaw === '-';
    const meta = statusMap.get(filePath);

    files.push({
      path: filePath,
      oldPath: meta?.oldPath,
      status: meta?.status ?? 'modified',
      additions: isBinary ? 0 : Number.parseInt(addRaw, 10) || 0,
      deletions: isBinary ? 0 : Number.parseInt(delRaw, 10) || 0,
      isBinary,
    });
  }

  return files;
}
