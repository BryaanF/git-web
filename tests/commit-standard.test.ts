import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateCommitRange } from '../scripts/validate-commit-msg.ts';
import { runGit } from '../src/server/git/runner.ts';
import {
  COMMIT_TYPES,
  MAX_COMMIT_SUBJECT_LENGTH,
  formatCommitSubject,
  parseCommitSubject,
  validateCommitMessage,
} from '../src/shared/commit-standard.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('COMMIT_TYPES and MAX_COMMIT_SUBJECT_LENGTH define the 4-type 50-char standard', () => {
  assert.deepEqual([...COMMIT_TYPES], ['bugfix', 'features', 'chores', 'improvement']);
  assert.equal(MAX_COMMIT_SUBJECT_LENGTH, 50);
});

test('validateCommitMessage enforces 4 types, <=50 char summary, and allows detailed description body', () => {
  const exact50 = `features(ui): ${'a'.repeat(50 - 'features(ui): '.length)}`;
  assert.equal(exact50.length, 50);

  const validMessages = [
    'bugfix: fix null check in status bar',
    'bugfix(ui): clear diff spinner on clean tree',
    'features(repo): add host folder browser',
    'chores: update npm scripts and docs',
    'chores(ci): add hook and workflow checks',
    'improvement(git): batch staged diff blobs',
    exact50,
    `${exact50}\n\nDetailed description explaining why this change was made.\n- Point 1\n- Point 2`,
    "Merge branch 'main' into features/browse",
    'Revert "features(repo): temporary test"',
  ];

  for (const msg of validMessages) {
    const res = validateCommitMessage(msg);
    assert.equal(res.valid, true, `Expected valid for "${msg}", got ${res.reason}`);
  }

  const parsed = parseCommitSubject('features(repo-ui): add browse button');
  assert.deepEqual(parsed, {
    type: 'features',
    scope: 'repo-ui',
    description: 'add browse button',
  });

  const over50 = `features(ui): ${'a'.repeat(51 - 'features(ui): '.length)}`;
  assert.equal(over50.length, 51);

  const invalidMessages = [
    '',
    '   \n# comment line only',
    'feat: wrong type alias',
    'fix(ui): wrong type alias',
    'chore: singular form instead of chores',
    'FEATURE: uppercase type',
    'bugfix(ui):missing space after colon',
    'bugfix(Bad Scope): space in scope',
    'Just a plain commit summary without type',
    over50,
  ];

  for (const msg of invalidMessages) {
    const res = validateCommitMessage(msg);
    assert.equal(res.valid, false, `Expected invalid for "${msg}"`);
  }
});

test('formatCommitSubject formats scoped/unscoped headers and avoids double-prefixing', () => {
  assert.equal(
    formatCommitSubject({ type: 'features', scope: 'ui', summary: 'add browse button' }),
    'features(ui): add browse button',
  );
  assert.equal(
    formatCommitSubject({ type: 'bugfix', scope: '  ', summary: 'fix spinner' }),
    'bugfix: fix spinner',
  );
  assert.equal(
    formatCommitSubject({ type: 'chores', scope: 'docs', summary: 'chores(docs): update guide' }),
    'chores(docs): update guide',
  );
  assert.equal(
    formatCommitSubject({ type: 'custom', scope: 'ignored', summary: 'WIP checkpoint' }),
    'WIP checkpoint',
  );
});

test('validate-commit-msg CLI validates inline messages and git commit ranges cleanly', async () => {
  const out = execFileSync(
    process.execPath,
    ['scripts/validate-commit-msg.ts', '--message', 'improvement(perf): speed up commit query'],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  assert.ok(out.includes('Valid: improvement(perf): speed up commit query'));

  assert.throws(() => {
    execFileSync(
      process.execPath,
      ['scripts/validate-commit-msg.ts', '--message', 'feat: unsupported conventional type'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
  });

  assert.throws(() => {
    execFileSync(
      process.execPath,
      ['scripts/validate-commit-msg.ts', '--message', 'features(ui): summary line exceeding fifty characters total'],
      { cwd: projectRoot, stdio: 'pipe' },
    );
  });

  const tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdock-commit-range-'));
  try {
    await runGit(tmpRepo, ['init', '--initial-branch=main']);
    await runGit(tmpRepo, ['config', 'user.name', 'Test']);
    await runGit(tmpRepo, ['config', 'user.email', 'test@example.com']);

    await fs.writeFile(path.join(tmpRepo, 'a.txt'), '1\n', 'utf8');
    await runGit(tmpRepo, ['add', '-A']);
    await runGit(tmpRepo, ['commit', '-m', 'initial commit']);
    const baseSha = (await runGit(tmpRepo, ['rev-parse', 'HEAD'])).stdout.trim();

    await fs.writeFile(path.join(tmpRepo, 'b.txt'), '2\n', 'utf8');
    await runGit(tmpRepo, ['add', '-A']);
    await runGit(tmpRepo, ['commit', '-m', 'features(ui): add folder picker', '-m', 'Detailed body line.']);

    // Zero-SHA push still passes while skipping legacy root 'initial commit'
    const zeroBaseRes = validateCommitRange('0000000000000000000000000000000000000000', 'HEAD', tmpRepo);
    assert.equal(zeroBaseRes.checked, 1);
    assert.equal(zeroBaseRes.failures.length, 0);

    // Non-standard commit inside explicit range must fail
    await fs.writeFile(path.join(tmpRepo, 'c.txt'), '3\n', 'utf8');
    await runGit(tmpRepo, ['add', '-A']);
    await runGit(tmpRepo, ['commit', '-m', 'fix: non-standard commit type']);

    const rangeRes = validateCommitRange(baseSha, 'HEAD', tmpRepo);
    assert.equal(rangeRes.checked, 2);
    assert.equal(rangeRes.failures.length, 1);
    assert.equal(rangeRes.failures[0].subject, 'fix: non-standard commit type');
  } finally {
    await fs.rm(tmpRepo, { recursive: true, force: true });
  }
});
