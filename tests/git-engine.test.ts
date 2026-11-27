import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseStatusPorcelainV2Z, parseUnifiedPatch } from '../src/server/git/parsers.ts';
import { runGit } from '../src/server/git/runner.ts';
import {
  assertSafeRepoPath,
  checkoutBranch,
  getCommitDetail,
  getCommitFileDiff,
  getCommitHistory,
  getRepoStatus,
  getWorkingFileDiff,
  pushBranch,
  stageFiles,
  verifyRemoteSync,
} from '../src/server/git/service.ts';

test('parseStatusPorcelainV2Z separates staged, unstaged, untracked, and renamed files', () => {
  const sample = [
    '# branch.oid abcdef1234567890',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 MM N... 100644 100644 100644 111111 222222 src/app.ts',
    '1 A. N... 000000 100644 100644 000000 333333 src/new.ts',
    '2 R. N... 100644 100644 100644 444444 444444 R100 src/renamed.ts\0src/old.ts',
    '? notes/todo.md',
    'u UU N... 100644 100644 100644 100644 555555 666666 777777 conflict.txt',
    '',
  ].join('\0');

  const parsed = parseStatusPorcelainV2Z(sample);
  assert.equal(parsed.branch, 'main');
  assert.equal(parsed.upstream, 'origin/main');
  assert.equal(parsed.ahead, 2);
  assert.equal(parsed.behind, 1);

  assert.equal(parsed.staged.length, 3);
  assert.equal(parsed.staged[0].path, 'src/app.ts');
  assert.equal(parsed.staged[2].oldPath, 'src/old.ts');

  assert.equal(parsed.unstaged.length, 2);
  assert.equal(parsed.unstaged[0].path, 'src/app.ts');
  assert.equal(parsed.unstaged[1].path, 'notes/todo.md');
  assert.equal(parsed.unstaged[1].isUntracked, true);

  assert.equal(parsed.conflicted.length, 1);
  assert.equal(parsed.conflicted[0].path, 'conflict.txt');
});

test('assertSafeRepoPath blocks parent traversal, control chars, and .git metadata access', () => {
  const root = path.resolve(os.tmpdir(), 'sample-repo');
  assert.throws(() => assertSafeRepoPath(root, '../secret.txt'));
  assert.throws(() => assertSafeRepoPath(root, '.git/config'));
  assert.throws(() => assertSafeRepoPath(root, 'src/index.ts\nHEAD:secret'));
  assert.throws(() => assertSafeRepoPath(root, 'src/index.ts\0bad'));
  const ok = assertSafeRepoPath(root, 'src/index.ts');
  assert.equal(ok, path.join(root, 'src', 'index.ts'));
  const doubleDotName = assertSafeRepoPath(root, 'src/v1..v2.ts');
  assert.equal(doubleDotName, path.join(root, 'src', 'v1..v2.ts'));
});

test('checkoutBranch rejects leading dash flags and control characters', async () => {
  const root = path.resolve(os.tmpdir(), 'sample-repo');
  await assert.rejects(() => checkoutBranch(root, '--orphan=hack', true), /Invalid branch name/);
  await assert.rejects(() => checkoutBranch(root, '-B main', false), /Invalid branch name/);
  await assert.rejects(() => checkoutBranch(root, 'feat\n--force', true), /Invalid branch name/);
  await assert.rejects(() => checkoutBranch(root, '   ', false), /Branch name is required/);
});

test('Git integration: unstaged, untracked, staged diffs & live pushed vs unpushed verification', async () => {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdock-test-'));
  const bareRemote = path.join(tmpBase, 'origin.git');
  const workRepo = path.join(tmpBase, 'work');

  try {
    await fs.mkdir(bareRemote, { recursive: true });
    await runGit(bareRemote, ['init', '--bare', '--initial-branch=main']);

    await fs.mkdir(workRepo, { recursive: true });
    await runGit(workRepo, ['init', '--initial-branch=main']);
    await runGit(workRepo, ['config', 'user.name', 'Test User']);
    await runGit(workRepo, ['config', 'user.email', 'test@example.com']);
    await runGit(workRepo, ['remote', 'add', 'origin', bareRemote]);

    // Commit 1 (pushed)
    await fs.writeFile(path.join(workRepo, 'app.ts'), 'export const v = 1;\n', 'utf8');
    await fs.writeFile(path.join(workRepo, 'staged.ts'), 'export const s = "a";\n', 'utf8');
    await runGit(workRepo, ['add', '-A']);
    await runGit(workRepo, ['commit', '-m', 'Initial commit']);
    await runGit(workRepo, ['push', '-u', 'origin', 'main']);

    // Commit 2 (local unpushed)
    await fs.writeFile(path.join(workRepo, 'app.ts'), 'export const v = 2;\n', 'utf8');
    await runGit(workRepo, ['add', 'app.ts']);
    await runGit(workRepo, ['commit', '-m', 'Local unpushed commit']);

    // Working tree: staged change, unstaged change, and untracked file
    await fs.writeFile(path.join(workRepo, 'staged.ts'), 'export const s = "b";\n', 'utf8');
    await stageFiles(workRepo, ['staged.ts']);
    await fs.writeFile(path.join(workRepo, 'app.ts'), 'export const v = 3;\n', 'utf8');
    await fs.writeFile(path.join(workRepo, 'untracked.ts'), 'export const fresh = true;\n', 'utf8');

    const status = await getRepoStatus({
      id: 'work',
      name: 'work',
      path: workRepo,
      addedAt: new Date().toISOString(),
    });
    assert.equal(status.ahead, 1);
    assert.equal(status.behind, 0);
    assert.deepEqual(
      status.staged.map((f) => f.path),
      ['staged.ts'],
    );
    assert.deepEqual(
      status.unstaged.map((f) => f.path).sort(),
      ['app.ts', 'untracked.ts'],
    );

    const stagedDiff = await getWorkingFileDiff(workRepo, 'staged.ts', 'staged');
    assert.equal(stagedDiff.additions, 1);
    assert.equal(stagedDiff.deletions, 1);
    assert.ok(stagedDiff.hunks.length > 0);

    const unstagedDiff = await getWorkingFileDiff(workRepo, 'app.ts', 'unstaged');
    assert.equal(unstagedDiff.additions, 1);
    assert.equal(unstagedDiff.deletions, 1);

    const untrackedDiff = await getWorkingFileDiff(workRepo, 'untracked.ts', 'unstaged');
    assert.equal(untrackedDiff.status, 'untracked');
    assert.equal(untrackedDiff.additions, 1);
    assert.ok(untrackedDiff.patch.includes('+export const fresh = true;'));

    // Check commit history push states before pushing commit 2
    const historyBefore = await getCommitHistory(workRepo, 20, 0);
    assert.equal(historyBefore.commits.length, 2);
    assert.equal(historyBefore.commits[0].subject, 'Local unpushed commit');
    assert.equal(historyBefore.commits[0].pushState, 'unpushed');
    assert.equal(historyBefore.commits[1].subject, 'Initial commit');
    assert.equal(historyBefore.commits[1].pushState, 'pushed');

    const verifyBefore = await verifyRemoteSync(workRepo);
    assert.equal(verifyBefore.ok, true);
    assert.equal(verifyBefore.verdict, 'ahead_unpushed');
    assert.equal(verifyBefore.aheadCount, 1);

    // Push commit 2 and verify both history and live remote agree
    await pushBranch(workRepo, false);
    const historyAfter = await getCommitHistory(workRepo, 20, 0);
    assert.equal(historyAfter.commits[0].pushState, 'pushed');
    assert.ok(historyAfter.commits[0].pushedToRefs.includes('origin/main'));

    const verifyAfter = await verifyRemoteSync(workRepo);
    assert.equal(verifyAfter.verdict, 'synced');
    assert.equal(verifyAfter.localHeadSha, verifyAfter.remoteLiveSha);

    const commitDetail = await getCommitDetail(workRepo, historyAfter.commits[0].sha);
    assert.equal(commitDetail.files[0].path, 'app.ts');
    const commitFileDiff = await getCommitFileDiff(workRepo, historyAfter.commits[0].sha, 'app.ts');
    assert.equal(commitFileDiff.additions, 1);
    assert.equal(commitFileDiff.deletions, 1);
    assert.equal(parseUnifiedPatch(commitFileDiff.patch).hunks.length, 1);
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
});
