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
import { parseUnifiedPatch } from '../src/server/git/parsers.ts';
import { runGit } from '../src/server/git/runner.ts';
import { getRepoStatus, getWorkingFileDiff, stageFiles } from '../src/server/git/service.ts';
import type { CommitDetail, DiffPayload, RepoStatusSummary } from '../src/shared/types.ts';

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

test('HistoryTab CommitDetailPanel renders code diff inline directly below the selected file on desktop', async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const viteServer = await createViteServer({
    root: projectRoot,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  });

  try {
    const { CommitDetailPanel } = (await viteServer.ssrLoadModule('/src/client/components/HistoryTab.tsx')) as typeof import('../src/client/components/HistoryTab.tsx');

    const patch = [
      'diff --git a/src/middle.ts b/src/middle.ts',
      '--- a/src/middle.ts',
      '+++ b/src/middle.ts',
      '@@ -1,2 +1,2 @@',
      '-export const middle = 1;',
      '+export const middle = 2;',
      ' export const keep = true;',
      '',
    ].join('\n');
    const parsed = parseUnifiedPatch(patch);
    const diffPayload: DiffPayload = {
      path: 'src/middle.ts',
      patch,
      hunks: parsed.hunks,
      oldContent: 'export const middle = 1;\nexport const keep = true;\n',
      newContent: 'export const middle = 2;\nexport const keep = true;\n',
      lang: 'typescript',
      isBinary: false,
      isTooLarge: false,
      lineCount: parsed.lineCount,
      additions: parsed.additions,
      deletions: parsed.deletions,
      status: 'modified',
    };

    const commitDetail: CommitDetail = {
      commit: {
        sha: '122311abcdef0000',
        shortSha: '122311a',
        subject: 'features(ui): test inline diff placement',
        body: '',
        authorName: 'Tester',
        authorEmail: 'test@example.com',
        authoredAt: '2026-11-27T10:00:00.000Z',
        relativeDate: '1m ago',
        parents: ['0000000000000000'],
        refs: ['HEAD -> main'],
        pushState: 'pushed',
        pushedToRefs: ['origin/main'],
      },
      files: [
        { path: 'src/first.ts', status: 'modified', additions: 2, deletions: 1, isBinary: false },
        { path: 'src/middle.ts', status: 'modified', additions: 1, deletions: 1, isBinary: false },
        { path: 'src/last.ts', status: 'added', additions: 10, deletions: 0, isBinary: false },
      ],
    };

    const baseProps = {
      selectedCommitSha: commitDetail.commit.sha,
      commitDetail,
      detailLoading: false,
      selectedFilePath: 'src/middle.ts',
      diff: diffPayload,
      diffLoading: false,
      diffError: null,
      contextLines: 3,
      onBackToCommits: () => {},
      onSelectFile: () => {},
      onCollapseFile: () => {},
      onStepFile: () => {},
      onChangeContextLines: () => {},
    };

    const desktopHtml = renderToStaticMarkup(
      React.createElement(CommitDetailPanel, {
        ...baseProps,
        isDesktop: true,
      }),
    );

    const firstPos = desktopHtml.indexOf('src/first.ts');
    const middlePos = desktopHtml.indexOf('src/middle.ts');
    const diffMarkerPos = desktopHtml.indexOf('Commit 122311a');
    const diffLinePos = desktopHtml.indexOf('data-operator="+"');
    const lastPos = desktopHtml.indexOf('src/last.ts');

    assert.ok(firstPos >= 0 && middlePos > firstPos, 'Expected first.ts before middle.ts');
    assert.ok(diffMarkerPos > middlePos, 'Expected inline diff viewer after selected middle.ts');
    assert.ok(diffLinePos > diffMarkerPos, 'Expected rendered diff hunks after diff header');
    assert.ok(lastPos > diffLinePos, 'Expected last.ts AFTER the inline diff of middle.ts (not before diff)');
    assert.ok(desktopHtml.includes('aria-label="Collapse diff"'), 'Expected desktop inline collapse button');
    assert.equal(desktopHtml.includes('aria-label="Back to files"'), false);

    const commitWithBody: CommitDetail = {
      ...commitDetail,
      commit: {
        ...commitDetail.commit,
        body: 'Detailed body explaining what changed and why.',
      },
    };

    const collapsedDescHtml = renderToStaticMarkup(
      React.createElement(CommitDetailPanel, {
        ...baseProps,
        commitDetail: commitWithBody,
        isDesktop: true,
      }),
    );
    assert.ok(collapsedDescHtml.includes('>Description<'), 'Expected Description toggle button when body exists');
    assert.equal(
      collapsedDescHtml.includes('Detailed body explaining what changed and why.'),
      false,
      'Expected commit description body to be collapsed by default',
    );

    const expandedDescHtml = renderToStaticMarkup(
      React.createElement(CommitDetailPanel, {
        ...baseProps,
        commitDetail: commitWithBody,
        isDesktop: true,
        descriptionExpanded: true,
      }),
    );
    assert.ok(expandedDescHtml.includes('>Hide description<'), 'Expected Hide description label when expanded');
    assert.ok(
      expandedDescHtml.includes('Detailed body explaining what changed and why.'),
      'Expected commit description body visible when expanded',
    );

    const noBodyHtml = renderToStaticMarkup(
      React.createElement(CommitDetailPanel, {
        ...baseProps,
        isDesktop: true,
      }),
    );
    assert.equal(noBodyHtml.includes('Description'), false, 'Expected no description toggle when commit body is empty');

    const mobileHtml = renderToStaticMarkup(
      React.createElement(CommitDetailPanel, {
        ...baseProps,
        isDesktop: false,
      }),
    );

    assert.ok(mobileHtml.includes('aria-label="Back to files"'), 'Expected mobile drilldown back button');
    assert.ok(mobileHtml.includes('hidden lg:block'), 'Expected mobile commit list hidden during file diff drilldown');
  } finally {
    await viteServer.close();
  }
});
