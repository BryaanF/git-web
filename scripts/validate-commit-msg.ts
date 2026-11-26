import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  COMMIT_TYPES,
  COMMIT_TYPE_META,
  validateCommitMessage,
} from '../src/shared/commit-standard.ts';

function printFailure(subject: string, reason: string, prefix = '[commit-msg]'): void {
  console.error('');
  console.error(`\x1b[31m${prefix} Commit message rejected.\x1b[0m`);
  if (subject) {
    console.error(`  Received: "${subject}"`);
  }
  console.error(`  Reason:   ${reason}`);
  console.error('');
  console.error('  Allowed commit types:');
  for (const type of COMMIT_TYPES) {
    const meta = COMMIT_TYPE_META[type];
    console.error(`    - ${meta.type.padEnd(11)} : ${meta.description}`);
    console.error(`                    e.g. "${meta.example}"`);
  }
  console.error('');
}

interface GitCommitEntry {
  sha: string;
  parents: string;
  subject: string;
}

function readGitCommits(args: string[], cwd: string): GitCommitEntry[] {
  const out = execFileSync('git', ['log', '--format=%H%x09%P%x09%s', ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
  const commits: GitCommitEntry[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [sha = '', parents = '', ...rest] = line.split('\t');
    commits.push({
      sha: sha.trim(),
      parents: parents.trim(),
      subject: rest.join('\t').trim(),
    });
  }
  return commits;
}

function refExists(refName: string, cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', refName], {
      cwd,
      stdio: 'ignore',
      shell: false,
    });
    return true;
  } catch {
    return false;
  }
}

export function validateCommitRange(baseArg: string, headArg = 'HEAD', cwd = process.cwd()): {
  checked: number;
  failures: Array<{ sha: string; subject: string; reason: string }>;
} {
  const head = headArg.trim() || 'HEAD';
  const base = baseArg.trim();
  const isZeroBase = !base || /^0+$/.test(base);

  let commits: GitCommitEntry[] = [];
  if (!isZeroBase && refExists(base, cwd)) {
    commits = readGitCommits([`${base}..${head}`], cwd);
  } else {
    // New branch / initial push: compare against remote default branch if available, else inspect reachable commits.
    let resolvedBase: string | null = null;
    for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
      if (refExists(candidate, cwd)) {
        const candidateCommits = readGitCommits([`${candidate}..${head}`], cwd);
        if (candidateCommits.length > 0) {
          resolvedBase = candidate;
          commits = candidateCommits;
          break;
        }
      }
    }
    if (!resolvedBase) {
      commits = readGitCommits([head], cwd);
    }
  }

  const failures: Array<{ sha: string; subject: string; reason: string }> = [];
  let checked = 0;

  for (const commit of commits) {
    // Preserve the repository's original parentless bootstrap commit created before this standard existed.
    if (!commit.parents && commit.subject.toLowerCase() === 'initial commit') {
      continue;
    }
    checked += 1;
    const res = validateCommitMessage(commit.subject);
    if (!res.valid) {
      failures.push({
        sha: commit.sha.slice(0, 7),
        subject: commit.subject,
        reason: res.reason ?? 'Invalid commit message format.',
      });
    }
  }

  return { checked, failures };
}

function main(): void {
  const args = process.argv.slice(2);
  const rangeIdx = args.indexOf('--range');
  if (rangeIdx >= 0) {
    const rawFirst = args[rangeIdx + 1] ?? '';
    const rawSecond = args[rangeIdx + 2] && !args[rangeIdx + 2].startsWith('-') ? args[rangeIdx + 2] : '';
    let base = '';
    let head = 'HEAD';
    if (rawFirst.includes('..')) {
      const parts = rawFirst.split('..');
      base = parts[0] ?? '';
      head = parts[1] || 'HEAD';
    } else if (rawFirst) {
      base = rawFirst;
      head = rawSecond || 'HEAD';
    }

    const { checked, failures } = validateCommitRange(base, head);
    if (failures.length > 0) {
      for (const fail of failures) {
        printFailure(fail.subject, fail.reason, `[commit-msg ${fail.sha}]`);
      }
      process.exit(1);
    }
    console.log(`[commit-msg] Checked ${checked} commit(s); all conform to the 4-type standard.`);
    return;
  }

  let rawMessage = '';
  const msgIdx = args.indexOf('--message');
  const shortMsgIdx = args.indexOf('-m');
  if (msgIdx >= 0 || shortMsgIdx >= 0) {
    const idx = msgIdx >= 0 ? msgIdx : shortMsgIdx;
    rawMessage = args[idx + 1] ?? '';
  } else if (args[0]) {
    const msgFile = path.resolve(args[0]);
    rawMessage = fs.readFileSync(msgFile, 'utf8');
  } else {
    console.error(
      'Usage: node scripts/validate-commit-msg.ts <commit-msg-file> | --message "<subject>" | --range <base> <head>',
    );
    process.exit(1);
  }

  const result = validateCommitMessage(rawMessage);
  if (!result.valid) {
    printFailure(result.subject, result.reason ?? 'Invalid commit message format.');
    process.exit(1);
  }

  if (msgIdx >= 0 || shortMsgIdx >= 0) {
    console.log(`[commit-msg] Valid: ${result.subject}`);
  }
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]).endsWith('validate-commit-msg.ts');
if (isEntrypoint) {
  main();
}
