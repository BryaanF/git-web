import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DiffFile } from '@git-diff-view/file';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer as createViteServer } from 'vite';
import { runGit } from '../src/server/git/runner.ts';
import { getRepoStatus, getWorkingFileDiff, stageFiles } from '../src/server/git/service.ts';
import type { RepoStatusSummary } from '../src/shared/types.ts';

test('working diff loads modified, staged, and untracked files with valid unified headers for DiffFile', async () => {
  const tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdock-diff-'));
  try {
    await runGit(tmpRepo, ['init', '--initial-branch=main']);
    await runGit(tmpRepo, ['config', 'user.name', 'Test']);
    await runGit(tmpRepo, ['config', 'user.email', 'test@example.com']);

    await fs.writeFile(path.join(tmpRepo, 'demo.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
    await fs.writeFile(path.join(tmpRepo, 'staged.ts'), 'export const x = "old";\n', 'utf8');
    await runGit(tmpRepo, ['add', '-A']);
    await runGit(tmpRepo, ['commit', '-m', 'init']);

    // Modify unstaged, modify+stage staged, and create untracked
    await fs.writeFile(path.join(tmpRepo, 'demo.ts'), 'const a = 1;\nconst b = 99;\nconst c = 3;\n', 'utf8');
    await fs.writeFile(path.join(tmpRepo, 'staged.ts'), 'export const x = "new";\n', 'utf8');
    await stageFiles(tmpRepo, ['staged.ts']);
    await fs.writeFile(path.join(tmpRepo, 'fresh.ts'), 'export const fresh = 1;\n', 'utf8');

    const status = await getRepoStatus({
      id: 'demo',
      name: 'demo',
      path: tmpRepo,
      addedAt: new Date().toISOString(),
    });
    assert.equal(status.staged.length, 1);
    assert.equal(status.unstaged.length, 2);

    const [unstagedDiff, stagedDiff, untrackedDiff] = await Promise.all([
      getWorkingFileDiff(tmpRepo, 'demo.ts', 'unstaged', 3),
      getWorkingFileDiff(tmpRepo, 'staged.ts', 'staged', 3),
      getWorkingFileDiff(tmpRepo, 'fresh.ts', 'unstaged', 3, 'untracked'),
    ]);

    assert.equal(unstagedDiff.additions, 2);
    assert.equal(unstagedDiff.deletions, 1);
    assert.equal(stagedDiff.additions, 1);
    assert.equal(stagedDiff.deletions, 1);
    assert.equal(untrackedDiff.status, 'untracked');
    assert.equal(untrackedDiff.additions, 1);

    // Verify @git-diff-view/file parses real additions/deletions from the patch
    for (const payload of [unstagedDiff, stagedDiff, untrackedDiff]) {
      const df = DiffFile.createInstance({
        oldFile: {
          fileName: payload.oldPath ?? payload.path,
          fileLang: payload.lang,
          content: payload.oldContent ?? '',
        },
        newFile: {
          fileName: payload.path,
          fileLang: payload.lang,
          content: payload.newContent ?? '',
        },
        hunks: [payload.patch.replace(/\r\n/g, '\n')],
      });
      df.initTheme('dark');
      df.init();
      df.buildUnifiedDiffLines();
      assert.equal(df.additionLength, payload.additions);
      assert.equal(df.deletionLength, payload.deletions);
      assert.ok(df.unifiedLineLength > 0);
    }
  } finally {
    await fs.rm(tmpRepo, { recursive: true, force: true });
  }
});

test('ChangesTab shows clean empty state with no diff loading spinner when no changed files exist', async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const viteServer = await createViteServer({
    root: projectRoot,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  });

  try {
    const { ChangesTab } = (await viteServer.ssrLoadModule('/src/client/components/ChangesTab.tsx')) as typeof import('../src/client/components/ChangesTab.tsx');
    const cleanStatus: RepoStatusSummary = {
      repo: { id: 'clean', name: 'clean', path: '/tmp/clean', addedAt: '2026-01-01T00:00:00.000Z' },
      branch: 'main',
      headSha: '1234567890abcdef',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasRemote: true,
      remoteName: 'origin',
      unstaged: [],
      staged: [],
      conflicted: [],
      lastRefreshedAt: '2026-01-01T00:00:00.000Z',
    };

    const html = renderToStaticMarkup(
      React.createElement(ChangesTab, {
        repoId: 'clean',
        status: cleanStatus,
        refreshTick: 0,
        onStatusUpdated: () => {},
        onCommitted: () => {},
      }),
    );

    assert.ok(html.includes('Working tree clean'));
    assert.ok(html.includes('No changed files'));
    assert.equal(html.includes('Loading diff...'), false);
    assert.equal(html.includes('animate-spin'), false);
  } finally {
    await viteServer.close();
  }
});
